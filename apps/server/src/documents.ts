import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  documentInputSchema,
  projectInputSchema,
  restoreDocumentSchema,
  updateDocumentSchema,
  type Document,
  type Project,
  type Revision,
  type Workspace,
} from '@weave/contracts';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from './database.js';
import { SessionGuard, type AuthorizedRequest } from './auth.js';
import { SchemaPipe } from './validation.js';

const documentColumns = `d.id, d.workspace_id AS "workspaceId", d.project_id AS "projectId",
  d.title, d.body, d.version, d.updated_at AS "updatedAt"`;

@Injectable()
export class DocumentsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async requireProject(client: PoolClient, userId: string, projectId: string) {
    const result = await client.query<Project>(
      `SELECT p.id, p.workspace_id AS "workspaceId", p.name FROM projects p
       JOIN workspace_members m ON m.workspace_id = p.workspace_id
       WHERE p.id = $1 AND m.user_id = $2 FOR SHARE OF p, m`,
      [projectId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('项目不存在或无权访问。');
    return result.rows[0];
  }

  async readDocument(
    client: PoolClient,
    userId: string,
    documentId: string,
    lock: boolean,
  ) {
    const result = await client.query<Document>(
      `SELECT ${documentColumns} FROM documents d
       JOIN workspace_members m ON m.workspace_id = d.workspace_id
       WHERE d.id = $1 AND m.user_id = $2 ${lock ? 'FOR UPDATE OF d' : ''} FOR SHARE OF m`,
      [documentId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('文档不存在或无权访问。');
    return result.rows[0];
  }

  // The sole formal document write path: state, immutable snapshot and audit share one transaction.
  async writeRevision(
    client: PoolClient,
    userId: string,
    document: Document,
    beforeVersion: number | null,
    restoredFrom: number | null,
  ) {
    const operationId = randomUUID();
    const kind =
      beforeVersion === null
        ? 'create'
        : restoredFrom === null
          ? 'edit'
          : 'restore';
    await client.query(
      `INSERT INTO document_revisions(workspace_id, project_id, document_id, version, title, body, actor_id, operation_id, kind, restored_from_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        document.workspaceId,
        document.projectId,
        document.id,
        document.version,
        document.title,
        document.body,
        userId,
        operationId,
        kind,
        restoredFrom,
      ],
    );
    await client.query(
      `INSERT INTO audit_events(operation_id, workspace_id, project_id, document_id, before_version, after_version, initiator_id, confirmer_id, method)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
      [
        operationId,
        document.workspaceId,
        document.projectId,
        document.id,
        beforeVersion,
        document.version,
        userId,
        kind === 'restore' ? 'restore' : 'manual',
      ],
    );
  }

  async create(
    userId: string,
    projectId: string,
    input: z.infer<typeof documentInputSchema>,
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.requireProject(client, userId, projectId);
      const result = await client.query<Document>(
        `INSERT INTO documents AS d(id, workspace_id, project_id, title, body, version, updated_by)
         VALUES($1,$2,$3,$4,$5,1,$6) RETURNING ${documentColumns}`,
        [
          randomUUID(),
          project.workspaceId,
          projectId,
          input.title,
          input.body,
          userId,
        ],
      );
      const document = result.rows[0]!;
      await this.writeRevision(client, userId, document, null, null);
      return document;
    });
  }

  async change(
    userId: string,
    documentId: string,
    input:
      | z.infer<typeof updateDocumentSchema>
      | z.infer<typeof restoreDocumentSchema>,
  ) {
    return this.database.transaction(async (client) => {
      const current = await this.readDocument(client, userId, documentId, true);
      if (current.version !== input.baseVersion) {
        throw new ConflictException(
          '文档已被修改。你的草稿已保留，请查看最新版本后再保存。',
        );
      }
      let title: string;
      let body: string;
      let restoredFrom: number | null = null;
      if ('revisionVersion' in input) {
        const revision = await client.query<{ title: string; body: string }>(
          'SELECT title, body FROM document_revisions WHERE document_id = $1 AND version = $2',
          [documentId, input.revisionVersion],
        );
        if (!revision.rows[0]) throw new NotFoundException('历史版本不存在。');
        ({ title, body } = revision.rows[0]);
        restoredFrom = input.revisionVersion;
      } else {
        ({ title, body } = input);
      }
      if (title === current.title && body === current.body) return current;
      const result = await client.query<Document>(
        `UPDATE documents AS d SET title = $2, body = $3, version = version + 1, updated_by = $4, updated_at = now()
         WHERE id = $1 RETURNING ${documentColumns}`,
        [documentId, title, body, userId],
      );
      const document = result.rows[0]!;
      await this.writeRevision(
        client,
        userId,
        document,
        current.version,
        restoredFrom,
      );
      return document;
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class DocumentsController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Get('workspaces')
  workspaces(@Req() request: AuthorizedRequest) {
    return this.database.transaction(
      async (client) =>
        (
          await client.query<Workspace>(
            `SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.name, w.id`,
            [request.user.id],
          )
        ).rows,
    );
  }

  @Get('workspaces/:workspaceId/projects')
  projects(
    @Req() request: AuthorizedRequest,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
  ) {
    return this.database.transaction(async (client) => {
      const member = await client.query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, request.user.id],
      );
      if (!member.rowCount)
        throw new NotFoundException('工作空间不存在或无权访问。');
      return (
        await client.query<Project>(
          'SELECT id, workspace_id AS "workspaceId", name FROM projects WHERE workspace_id = $1 ORDER BY created_at, id',
          [workspaceId],
        )
      ).rows;
    });
  }

  @Post('workspaces/:workspaceId/projects')
  createProject(
    @Req() request: AuthorizedRequest,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new SchemaPipe(projectInputSchema))
    input: z.infer<typeof projectInputSchema>,
  ) {
    return this.database.transaction(async (client) => {
      const member = await client.query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
        [workspaceId, request.user.id],
      );
      if (!member.rowCount)
        throw new NotFoundException('工作空间不存在或无权访问。');
      return (
        await client.query<Project>(
          'INSERT INTO projects(id, workspace_id, name) VALUES($1,$2,$3) RETURNING id, workspace_id AS "workspaceId", name',
          [randomUUID(), workspaceId, input.name],
        )
      ).rows[0]!;
    });
  }

  @Get('projects/:projectId/documents')
  list(
    @Req() request: AuthorizedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.database.transaction(async (client) => {
      await this.documents.requireProject(client, request.user.id, projectId);
      return (
        await client.query(
          `SELECT d.id, d.workspace_id AS "workspaceId", d.project_id AS "projectId",
        d.title, d.version, d.updated_at AS "updatedAt" FROM documents d WHERE d.project_id = $1 ORDER BY d.updated_at DESC, d.id`,
          [projectId],
        )
      ).rows;
    });
  }

  @Post('projects/:projectId/documents')
  create(
    @Req() request: AuthorizedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new SchemaPipe(documentInputSchema))
    input: z.infer<typeof documentInputSchema>,
  ) {
    return this.documents.create(request.user.id, projectId, input);
  }

  @Get('documents/:documentId')
  get(
    @Req() request: AuthorizedRequest,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    return this.database.transaction((client) =>
      this.documents.readDocument(client, request.user.id, documentId, false),
    );
  }

  @Put('documents/:documentId')
  update(
    @Req() request: AuthorizedRequest,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new SchemaPipe(updateDocumentSchema))
    input: z.infer<typeof updateDocumentSchema>,
  ) {
    return this.documents.change(request.user.id, documentId, input);
  }

  @Get('documents/:documentId/revisions')
  revisions(
    @Req() request: AuthorizedRequest,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    return this.database.transaction(async (client) => {
      await this.documents.readDocument(
        client,
        request.user.id,
        documentId,
        false,
      );
      return (
        await client.query<Revision>(
          `SELECT r.version, r.title, r.body, u.name AS "actorName", r.created_at AS "createdAt", r.operation_id AS "operationId",
         r.kind, r.restored_from_version AS "restoredFromVersion"
         FROM document_revisions r JOIN users u ON u.id = r.actor_id WHERE r.document_id = $1 ORDER BY r.version DESC`,
          [documentId],
        )
      ).rows;
    });
  }

  @Post('documents/:documentId/restore')
  restore(
    @Req() request: AuthorizedRequest,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new SchemaPipe(restoreDocumentSchema))
    input: z.infer<typeof restoreDocumentSchema>,
  ) {
    return this.documents.change(request.user.id, documentId, input);
  }
}
