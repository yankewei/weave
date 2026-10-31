<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use PHPUnit\Framework\TestCase;

final class TasksTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;
    use WorkspaceClient;

    private const STALE = '任务已被其他操作修改。请刷新看板后重试，编辑草稿已保留。';

    private TestServer $server;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    public function testCreatesListsAndEditsTasksWithHistory(): void
    {
        [$token, $workspaceId, $userId] = $this->register('看板空间');
        $projectId = $this->project($token, $workspaceId);

        $created = $this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input(['title' => ' 写接口 ', 'assigneeId' => $userId]));
        self::assertSame(201, $created->status);
        $task = self::json($created);
        self::assertMatchesRegularExpression(TestServer::ISO, self::text($task, 'updatedAt'));
        unset($task['id'], $task['updatedAt']);
        self::assertSame([
            'workspaceId' => $workspaceId, 'projectId' => $projectId, 'number' => 1, 'title' => '写接口',
            'description' => '', 'acceptanceCriteria' => '', 'status' => 'todo', 'priority' => 'normal',
            'assigneeId' => $userId, 'assigneeName' => '测试', 'position' => '1024', 'version' => 1,
        ], $task);
        $taskId = self::text(self::json($created), 'id');
        self::assertSame([self::json($created)], self::json($this->request('GET', "/api/projects/{$projectId}/tasks", $token)));
        self::assertSame([['id' => $userId, 'name' => '测试']], self::json($this->request('GET', "/api/projects/{$projectId}/members", $token)));

        $edit = self::input(['baseVersion' => 1, 'title' => '写接口', 'status' => 'done', 'assigneeId' => null]);
        $edited = self::json($this->request('PUT', "/api/tasks/{$taskId}", $token, $edit));
        self::assertSame([2, 'done', null, null, '1024'], [$edited['version'], $edited['status'], $edited['assigneeId'], $edited['assigneeName'], $edited['position']]);
        // Saving the same fields again is a no-op, not a stale write.
        self::assertSame($edited, self::json($this->request('PUT', "/api/tasks/{$taskId}", $token, [...$edit, 'baseVersion' => 2])));
        self::assertError(409, self::STALE, $this->request('PUT', "/api/tasks/{$taskId}", $token, $edit));

        $history = self::json($this->request('GET', "/api/tasks/{$taskId}/history", $token));
        self::assertSame(['edit', 'create'], array_column($history, 'kind'));
        self::assertSame([2, '测试', null], [self::at($history, 0, 'version'), self::at($history, 0, 'actorName'), self::at($history, 0, 'proposalId')]);
        self::assertMatchesRegularExpression(TestServer::ISO, self::text($history, 0, 'createdAt'));
        self::assertEquals(self::json($created), self::at($history, 0, 'before'));
        self::assertEquals($edited, self::at($history, 0, 'after'));
        self::assertNull(self::at($history, 1, 'before'));
    }

    public function testMovesTasksBetweenAndWithinColumns(): void
    {
        [$token, $workspaceId] = $this->register('拖拽空间');
        $projectId = $this->project($token, $workspaceId);
        [$a, $b, $c] = array_map(fn (string $title): string => self::text(self::json(
            $this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input(['title' => $title])),
        ), 'id'), ['A', 'B', 'C']);

        $moved = self::json($this->request('POST', "/api/tasks/{$c}/move", $token, ['baseVersion' => 1, 'status' => 'todo', 'beforeTaskId' => $a]));
        self::assertSame([2, '0'], [$moved['version'], $moved['position']]);
        self::assertSame([$c, $a, $b], $this->column($token, $projectId, 'todo'));
        // Dropping a task where it already is changes nothing. A whole float version reads as an int, as zod read it.
        self::assertSame($moved, self::json($this->request('POST', "/api/tasks/{$c}/move", $token, "{\"baseVersion\":2.0,\"status\":\"todo\",\"beforeTaskId\":\"{$a}\"}")));

        $between = self::json($this->request('POST', "/api/tasks/{$b}/move", $token, ['baseVersion' => 1, 'status' => 'todo', 'beforeTaskId' => $a]));
        self::assertSame('512.0', $between['position']);
        self::assertSame([$c, $b, $a], $this->column($token, $projectId, 'todo'));

        $done = self::json($this->request('POST', "/api/tasks/{$a}/move", $token, ['baseVersion' => 1, 'status' => 'done', 'beforeTaskId' => null]));
        self::assertSame(['done', 2], [$done['status'], $done['version']]);
        self::assertSame([$c, $b], $this->column($token, $projectId, 'todo'));

        self::assertError(400, '不能将任务放在自身之前。', $this->request('POST', "/api/tasks/{$b}/move", $token, ['baseVersion' => 2, 'status' => 'todo', 'beforeTaskId' => $b]));
        self::assertError(400, '目标任务不在当前项目的目标列中，请刷新看板。', $this->request('POST', "/api/tasks/{$b}/move", $token, ['baseVersion' => 2, 'status' => 'in_progress', 'beforeTaskId' => $c]));
        self::assertError(409, self::STALE, $this->request('POST', "/api/tasks/{$b}/move", $token, ['baseVersion' => 1, 'status' => 'done', 'beforeTaskId' => null]));
        self::assertSame(['move', 'create'], array_column(self::json($this->request('GET', "/api/tasks/{$c}/history", $token)), 'kind'));
    }

    public function testRenumbersAColumnWhenMidpointsGetTooPrecise(): void
    {
        [$token, $workspaceId] = $this->register('重排空间');
        $projectId = $this->project($token, $workspaceId);
        $first = self::text(self::json($this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input(['title' => '首个']))), 'id');
        $versions = [];
        // Each drop before the first task halves the gap to it until the scale overflows.
        for ($i = 0; $i < 40; $i++) {
            $id = self::text(self::json($this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input(['title' => "第{$i}个"]))), 'id');
            $moved = self::json($this->request('POST', "/api/tasks/{$id}/move", $token, ['baseVersion' => 1, 'status' => 'todo', 'beforeTaskId' => $first]));
            $versions[] = $moved['version'];
        }
        $column = self::json($this->request('GET', "/api/projects/{$projectId}/tasks", $token));
        self::assertSame($first, self::at($column, 40, 'id'));
        foreach ($column as $task) {
            self::assertLessThanOrEqual(30, strlen(substr(strrchr(self::text($task, 'position'), '.') ?: '.', 1)));
        }
        self::assertSame(array_fill(0, 40, 2), $versions);
    }

    public function testValidatesInputAndHidesOtherWorkspaces(): void
    {
        [$token, $workspaceId] = $this->register('校验空间');
        [$outsider, , $outsiderId] = $this->register('外部空间');
        $projectId = $this->project($token, $workspaceId);
        $taskId = self::text(self::json($this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input())), 'id');

        self::assertError(
            400,
            'extra: 不支持的字段；title: 长度应为 1–200 个字符；status: 必须是 todo、in_progress、done 之一；assigneeId: 必须是有效的标识或 null',
            $this->request('POST', "/api/projects/{$projectId}/tasks", $token, [...self::input(['title' => ' ', 'status' => 'later', 'assigneeId' => 'me']), 'extra' => 1]),
        );
        self::assertError(400, 'baseVersion: 必须是正整数；beforeTaskId: 必须是有效的标识或 null', $this->request('POST', "/api/tasks/{$taskId}/move", $token, ['baseVersion' => 0, 'status' => 'todo']));
        self::assertError(400, '负责人必须是当前工作空间的成员。', $this->request('POST', "/api/projects/{$projectId}/tasks", $token, self::input(['assigneeId' => $outsiderId])));
        self::assertError(400, '项目 不是有效的标识。', $this->request('GET', '/api/projects/nope/tasks', $token));
        self::assertError(400, '任务 不是有效的标识。', $this->request('GET', '/api/tasks/nope/history', $token));

        foreach (["/api/projects/{$projectId}/tasks", "/api/projects/{$projectId}/members"] as $path) {
            self::assertError(404, '项目不存在或无权访问。', $this->request('GET', $path, $outsider));
        }
        self::assertError(404, '项目不存在或无权访问。', $this->request('POST', "/api/projects/{$projectId}/tasks", $outsider, self::input()));
        self::assertError(404, '任务不存在或无权访问。', $this->request('PUT', "/api/tasks/{$taskId}", $outsider, self::input(['baseVersion' => 1])));
        self::assertError(404, '任务不存在或无权访问。', $this->request('GET', "/api/tasks/{$taskId}/history", $outsider));
        self::assertError(404, '任务不存在或无权访问。', $this->request('GET', "/api/tasks/{$taskId}/comments", $outsider));
    }

    public function testCommentsAndRepliesBelongToTheirAuthors(): void
    {
        [$admin, $workspaceId, $adminId] = $this->register('评论空间');
        [$member, , $memberId, $memberEmail] = $this->register('评论成员空间');
        $this->request('POST', "/api/workspaces/{$workspaceId}/members", $admin, ['email' => $memberEmail]);
        $projectId = $this->project($admin, $workspaceId);
        $taskId = self::text(self::json($this->request('POST', "/api/projects/{$projectId}/tasks", $admin, self::input())), 'id');
        $comments = "/api/tasks/{$taskId}/comments";

        $created = $this->request('POST', $comments, $admin, ['body' => ' 先看这里 ']);
        self::assertSame(201, $created->status);
        $comment = self::json($created);
        self::assertMatchesRegularExpression(TestServer::ISO, self::text($comment, 'createdAt'));
        unset($comment['id'], $comment['createdAt']);
        self::assertSame(['taskId' => $taskId, 'parentId' => null, 'authorId' => $adminId, 'authorName' => '测试', 'body' => '先看这里'], $comment);
        $parentId = self::text(self::json($created), 'id');
        $reply = self::json($this->request('POST', $comments, $member, ['body' => '收到', 'parentId' => $parentId]));
        self::assertSame([$parentId, $memberId], [$reply['parentId'], $reply['authorId']]);
        self::assertSame([$parentId, self::text($reply, 'id')], array_column(self::json($this->request('GET', $comments, $member)), 'id'));

        self::assertError(400, '只能回复一级评论。', $this->request('POST', $comments, $admin, ['body' => '套娃', 'parentId' => $reply['id']]));
        self::assertError(404, '要回复的评论不存在。', $this->request('POST', $comments, $admin, ['body' => '无主', 'parentId' => $taskId]));
        self::assertError(400, 'body: 长度应为 1–4000 个字符', $this->request('POST', $comments, $admin, ['body' => '  ']));
        self::assertError(403, '只能删除自己的评论。', $this->request('DELETE', "{$comments}/{$parentId}", $member));
        self::assertError(400, '评论 不是有效的标识。', $this->request('DELETE', "{$comments}/nope", $admin));

        self::assertSame(204, $this->request('DELETE', "{$comments}/{$parentId}", $admin)->status);
        self::assertSame([], self::json($this->request('GET', $comments, $admin)));
        self::assertError(404, '评论不存在。', $this->request('DELETE', "{$comments}/{$parentId}", $admin));
    }

    /** @return list<mixed> Task ids in board order. */
    private function column(string $token, string $projectId, string $status): array
    {
        $tasks = self::json($this->request('GET', "/api/projects/{$projectId}/tasks", $token));

        return array_column(array_filter($tasks, static fn (mixed $task): bool => is_array($task) && $task['status'] === $status), 'id');
    }

    /**
     * @param array<string, mixed> $fields
     * @return array<string, mixed>
     */
    private static function input(array $fields = []): array
    {
        return [
            'title' => '任务', 'description' => '', 'acceptanceCriteria' => '', 'status' => 'todo',
            'priority' => 'normal', 'assigneeId' => null, ...$fields,
        ];
    }
}
