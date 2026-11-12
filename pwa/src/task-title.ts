import { originLabel, type Task } from "@seance/shared";

/** The window `daemon/src/spawn.ts` names a spawn with no title or prompt (`session`, `session-<n>`): says nothing about the task. */
const NO_SLUG_WINDOW = /^session(?:-\d+)?$/u;

/** How a task is named wherever it is listed: its title, its prompt's first line, its window, else its repo. */
export function taskTitle(task: Task): string {
  const { spec } = task;
  if (spec.title !== undefined && spec.title !== "") return spec.title;
  const first = spec.prompt
    ?.split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  if (first !== undefined) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const session = task.assignment?.window;
  if (session !== undefined && !NO_SLUG_WINDOW.test(session)) return session;
  return originLabel(spec.repo);
}
