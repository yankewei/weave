import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  taskCommentInputSchema,
  type TaskComment,
  type TaskCommentInput,
} from '@weave/contracts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SessionGuard, type AuthorizedRequest } from './auth.js';
import { Database } from './database.js';
import { TasksService } from './tasks.js';
import { SchemaPipe } from './validation.js';

const commentColumns = `c.id, c.task_id AS "taskId", c.parent_id AS "parentId",
  c.author_id AS "authorId", u.name AS "authorName", c.body,
  c.created_at AS "createdAt"`;

@Injectable()
export class TaskCommentsService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  async list(userId: string, taskId: string) {
    return this.database.transaction(async (client) => {
      await this.tasks.read(client, userId, taskId);
      return (
        await client.query<TaskComment>(
          `SELECT ${commentColumns}
           FROM task_comments c JOIN users u ON u.id = c.author_id
           WHERE c.task_id = $1 ORDER BY c.created_at, c.id`,
          [taskId],
        )
      ).rows;
    });
  }

  async create(userId: string, taskId: string, input: TaskCommentInput) {
    return this.database.transaction(async (client) => {
      const task = await this.tasks.read(client, userId, taskId);
      const parentId = input.parentId ?? null;
      if (parentId) {
        const parent = await client.query<{ parentId: string | null }>(
          `SELECT parent_id AS "parentId" FROM task_comments
           WHERE id = $1 AND task_id = $2`,
          [parentId, taskId],
        );
        if (!parent.rows[0])
          throw new NotFoundException('要回复的评论不存在。');
        if (parent.rows[0].parentId)
          throw new BadRequestException('只能回复一级评论。');
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO task_comments(
           id, workspace_id, project_id, task_id, parent_id, author_id, body
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          task.workspaceId,
          task.projectId,
          taskId,
          parentId,
          userId,
          input.body,
        ],
      );
      return (
        await client.query<TaskComment>(
          `SELECT ${commentColumns}
           FROM task_comments c JOIN users u ON u.id = c.author_id
           WHERE c.id = $1`,
          [id],
        )
      ).rows[0]!;
    });
  }

  async remove(userId: string, taskId: string, commentId: string) {
    return this.database.transaction(async (client) => {
      await this.tasks.read(client, userId, taskId);
      const comment = await this.queryComment(client, taskId, commentId);
      if (comment.authorId !== userId)
        throw new ForbiddenException('只能删除自己的评论。');
      // Replies reference this row and are removed by the foreign key cascade.
      await client.query('DELETE FROM task_comments WHERE id = $1', [
        commentId,
      ]);
      return null;
    });
  }

  private async queryComment(
    client: PoolClient,
    taskId: string,
    commentId: string,
  ) {
    const result = await client.query<{ authorId: string }>(
      `SELECT author_id AS "authorId" FROM task_comments
       WHERE id = $1 AND task_id = $2 FOR UPDATE`,
      [commentId, taskId],
    );
    if (!result.rows[0]) throw new NotFoundException('评论不存在。');
    return result.rows[0];
  }
}

@Controller()
@UseGuards(SessionGuard)
export class TaskCommentsController {
  constructor(
    @Inject(TaskCommentsService)
    private readonly comments: TaskCommentsService,
  ) {}

  @Get('tasks/:taskId/comments')
  list(
    @Req() request: AuthorizedRequest,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.comments.list(request.user.id, taskId);
  }

  @Post('tasks/:taskId/comments')
  create(
    @Req() request: AuthorizedRequest,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body(new SchemaPipe(taskCommentInputSchema)) input: TaskCommentInput,
  ) {
    return this.comments.create(request.user.id, taskId, input);
  }

  @Delete('tasks/:taskId/comments/:commentId')
  @HttpCode(204)
  remove(
    @Req() request: AuthorizedRequest,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.comments.remove(request.user.id, taskId, commentId);
  }
}
