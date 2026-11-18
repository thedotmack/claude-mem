/**
 * Open tasks before done ones, each group in its recorded order (c-ai-task M: the one done item in "Parking lot items"
 * sat sixth of seven). The drawer sorts a workstream's tasks with it before drawing them (ai-elements/task.tsx
 * TaskItem), so reading order and screen order agree.
 */
export function openTasksFirst<T extends { done: boolean }>(tasks: readonly T[]): T[] {
  return [...tasks.filter((task) => !task.done), ...tasks.filter((task) => task.done)]
}
