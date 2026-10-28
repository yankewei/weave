import type { Task, TaskStatus, TaskPriority } from '@/lib/contracts';

export const taskStatuses: TaskStatus[] = ['todo', 'in_progress', 'done'];
export const taskStatusLabels: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
};
export const taskPriorityLabels: Record<TaskPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
};
export const taskFieldLabels = {
  title: '标题',
  description: '描述',
  acceptanceCriteria: '验收标准',
  status: '状态',
  priority: '优先级',
  assigneeId: '负责人',
};

export function taskHistoryValue(
  task: Task | null,
  field: keyof typeof taskFieldLabels,
) {
  if (!task) return '未创建';
  if (field === 'status') return taskStatusLabels[task.status];
  if (field === 'priority') return taskPriorityLabels[task.priority];
  if (field === 'assigneeId') return task.assigneeName ?? '未分配';
  return task[field] || '未填写';
}
