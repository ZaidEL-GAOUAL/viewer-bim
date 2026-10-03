import type { CompiledTask } from './schedule.ts';

export interface ScheduleTree {
  /** Task indexes, with siblings in their original document order. */
  children: Map<number, number[]>;
  roots: number[];
  /** Number of descendants, excluding the task itself. */
  descendantTaskCounts: Uint32Array;
}

export interface ScheduleRow {
  index: number;
  depth: number;
  hasChildren: boolean;
}

/** Display-only hierarchy. The compiled schedule already validates parent IDs and cycles. */
export function buildScheduleTree(tasks: readonly CompiledTask[]): ScheduleTree {
  const byId = new Map(tasks.map(({ task }, index) => [task.id, index]));
  const children = new Map<number, number[]>(), roots: number[] = [];
  for (let index = 0; index < tasks.length; index++) {
    const parentId = tasks[index].task.parentId;
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (parent === undefined) roots.push(index);
    else {
      const siblings = children.get(parent);
      if (siblings) siblings.push(index); else children.set(parent, [index]);
    }
  }

  // Reverse traversal computes subtree sizes in O(n), even for a deeply nested WBS.
  const order: number[] = [], stack = [...roots];
  while (stack.length) {
    const index = stack.pop()!;
    order.push(index);
    for (const child of children.get(index) ?? []) stack.push(child);
  }
  const descendantTaskCounts = new Uint32Array(tasks.length);
  for (let position = order.length - 1; position >= 0; position--) {
    const index = order[position];
    for (const child of children.get(index) ?? []) {
      descendantTaskCounts[index] += descendantTaskCounts[child] + 1;
    }
  }
  return { children, roots, descendantTaskCounts };
}

/** Flatten expanded rows without recursion or modifying document order. */
export function visibleScheduleRows(tree: ScheduleTree, collapsed: ReadonlySet<number>): ScheduleRow[] {
  const rows: ScheduleRow[] = [], stack = tree.roots.map((index) => ({ index, depth: 0 })).reverse();
  while (stack.length) {
    const { index, depth } = stack.pop()!;
    const children = tree.children.get(index);
    rows.push({ index, depth, hasChildren: !!children?.length });
    if (children && !collapsed.has(index)) {
      for (let child = children.length - 1; child >= 0; child--) {
        stack.push({ index: children[child], depth: depth + 1 });
      }
    }
  }
  return rows;
}

/** Union a branch's objects for selection only; simulation bindings stay on each task. */
export function collectTaskElements(tree: ScheduleTree, tasks: readonly CompiledTask[], index: number): number[] {
  if (!tasks[index]) return [];
  const elements = new Set<number>(), stack = [index];
  while (stack.length) {
    const current = stack.pop()!;
    for (const element of tasks[current].elements) elements.add(element);
    const children = tree.children.get(current) ?? [];
    for (let child = children.length - 1; child >= 0; child--) stack.push(children[child]);
  }
  return [...elements];
}
