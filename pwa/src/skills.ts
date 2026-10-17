import type { Machine } from "@seance/shared";

/**
 * The `/` picker's logic (DESIGN.md, PWA): the sorted union of skill names
 * across every machine's `exclaves[].skills`, read from the register blobs the
 * app already holds, so it needs no leader. Pure, so the component stays a
 * thin view over it.
 */

const collator = new Intl.Collator();

/**
 * Names only, no placement: which machine or exclave has a skill is the M4
 * routing filter's job, so the list stays a plain union. Offline machines
 * count: the blob is the inventory either way.
 */
export function skillIndex(machines: readonly Machine[]): readonly string[] {
  const names = new Set<string>();
  for (const machine of machines) {
    for (const exclave of machine.exclaves ?? []) {
      for (const name of exclave.skills) {
        // Whitespace can't sit inside the `/name` token, so it could never be typed or completed.
        if (!/\s/u.test(name)) names.add(name);
      }
    }
  }
  return [...names].toSorted(collator.compare);
}

/**
 * The partial name while the prompt is still its first token after a `/` —
 * the picker completes that token only, like Claude Code's. Null otherwise.
 */
export function skillQuery(prompt: string): string | null {
  const match = /^\/(\S*)$/u.exec(prompt);
  return match === null ? null : (match[1] ?? "");
}

/** Case-insensitive; names starting with the query first, then names containing it. */
export function matchSkills(skills: readonly string[], query: string): readonly string[] {
  const needle = query.toLowerCase();
  const prefix: string[] = [];
  const inner: string[] = [];
  for (const skill of skills) {
    const name = skill.toLowerCase();
    if (name.startsWith(needle)) prefix.push(skill);
    else if (name.includes(needle)) inner.push(skill);
  }
  return [...prefix, ...inner];
}

/** The prompt after picking: the name as the whole first token, space included so typing carries on. */
export function completeSkill(name: string): string {
  return `/${name} `;
}
