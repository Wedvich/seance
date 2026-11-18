import { ownerTagsOf, withOwnerTags, type TaskSpec } from "@seance/shared";
import type { Task } from "./task.ts";

/**
 * The spec a continuation or successor takes on its first move out of `queued`: its own, with the `owner.*` tags of the
 * task it continues or succeeds merged in (docs/tags.md §5.3), or null when there is nothing to copy. Null when it has no
 * predecessor, the predecessor is not in `tasks` (pruned), holds no `owner.*`, or the task already holds one: the
 * owner's later word on the new task wins. The leader's own copy, since a client's create is version 1 and seals
 * `creator.*` alone; its caller takes it only for a record still at that version, since a label set and cleared leaves
 * no key to show the owner spoke; `creator.*` is the client's (`continuationSpec`,
 * `successorSpec`) and `scheduler.*` is never copied.
 */
export function chainOwnerTags(task: Task, tasks: ReadonlyMap<string, Task>): TaskSpec | null {
  const from = task.spec.continues?.task ?? task.spec.succeeds?.task;
  if (from === undefined) return null;
  const owner = ownerTagsOf(tasks.get(from)?.spec.tags);
  if (Object.keys(owner).length === 0 || Object.keys(ownerTagsOf(task.spec.tags)).length > 0) return null;
  const tags = withOwnerTags(task.spec.tags, owner);
  return tags === undefined ? null : { ...task.spec, tags };
}
