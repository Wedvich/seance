import type { Task, TaskPr } from "./types.ts";

/**
 * Every PR its session reported, oldest first: `prs`, with `prUrl` appended when it is not
 * among them — a record from an older leader carries `prUrl` alone, and one an older leader
 * rewrote has lost `prs`. Empty with no `prUrl`: a list without a primary is no list.
 */
export function taskPrs(task: Pick<Task, "prUrl" | "prs">): readonly TaskPr[] {
  const { prUrl, prs = [] } = task;
  if (prUrl === undefined) return [];
  return prs.some((pr) => pr.url === prUrl) ? prs : [...prs, { url: prUrl }];
}

/** The PR a task stands on (`Task.prUrl`): the newest not read closed, else the newest. */
export function primaryPr(prs: readonly TaskPr[]): string | undefined {
  return (prs.findLast((pr) => pr.closed !== true) ?? prs.at(-1))?.url;
}
