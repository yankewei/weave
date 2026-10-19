import { randomUUID } from 'node:crypto';
import { type TaskComment, type TaskCommentInput } from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';
import { read as readTask } from './tasks';

const commentColumns = `c.id, c.task_id AS "taskId", c.parent_id AS "parentId",
  c.author_id AS "authorId", u.name AS "authorName", c.body,
  c.created_at AS "createdAt"`;

export function list(userId: string, taskId: string) {
  return transaction(async (client) => {
    await readTask(client, userId, taskId);
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

export function create(
  userId: string,
  taskId: string,
  input: TaskCommentInput,
) {
  return transaction(async (client) => {
    const task = await readTask(client, userId, taskId);
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await client.query<{ parentId: string | null }>(
        `SELECT parent_id AS "parentId" FROM task_comments
         WHERE id = $1 AND task_id = $2`,
        [parentId, taskId],
      );
      if (!parent.rows[0]) throw new ApiError(404, '要回复的评论不存在。');
      if (parent.rows[0].parentId)
        throw new ApiError(400, '只能回复一级评论。');
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

export function remove(userId: string, taskId: string, commentId: string) {
  return transaction(async (client) => {
    await readTask(client, userId, taskId);
    const result = await client.query<{ authorId: string }>(
      `SELECT author_id AS "authorId" FROM task_comments
       WHERE id = $1 AND task_id = $2 FOR UPDATE`,
      [commentId, taskId],
    );
    const comment = result.rows[0];
    if (!comment) throw new ApiError(404, '评论不存在。');
    if (comment.authorId !== userId)
      throw new ApiError(403, '只能删除自己的评论。');
    // Replies reference this row and are removed by the foreign key cascade.
    await client.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
    return null;
  });
}
