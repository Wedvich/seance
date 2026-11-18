import { displayLine, httpsUrl, joinTags, taskTagEntries, type Task } from "@seance/shared";

/** A task's tags as the Queue card and the verdict show them (docs/tags.md §6.2: the PWA gets the joined view). */
export interface TaskTagLines {
  /** `owner.label`: what the owner called it; null when unset. */
  readonly label: string | null;
  /** `creator.ref`, linked to `creator.ref-url` when that is an https: URL; null without a ref. */
  readonly ref: { readonly text: string; readonly url: string | null } | null;
  /** Every task tag with its full key, sorted by key; the verdict lists them. */
  readonly all: readonly { readonly key: string; readonly value: string }[];
}

/**
 * Display text only, never markup: each value passes `displayLine` again and a link is shown only for an https:
 * URL, so nothing a creator wrote can become a `javascript:` target. A legacy `linear` reads as `creator.ref`.
 */
export function taskTagLines(task: Task): TaskTagLines {
  const joined = joinTags(taskTagEntries(task.spec, task.createdAt));
  const entries = Object.entries(joined)
    .map(([key, tag]) => ({ key, value: displayLine(tag.value) }))
    .filter(({ value }) => value !== "")
    .toSorted((a, b) => a.key.localeCompare(b.key));
  const value = (key: string): string | null => entries.find((entry) => entry.key === key)?.value ?? null;
  const ref = value("creator.ref");
  const url = value("creator.ref-url");
  return {
    label: value("owner.label"),
    ref: ref === null ? null : { text: ref, url: url === null ? null : httpsUrl(url) },
    all: entries,
  };
}
