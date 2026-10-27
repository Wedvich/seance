import { SKILL_TOKEN, SKILL_TOKEN_OPENER, trimSkillName, type Machine } from "@seance/shared";

/**
 * The `/` picker's logic (DESIGN.md, PWA): the sorted union of skill names
 * across every machine's `exclaves[].skills` and clones' `repos[].skills`, read from the register blobs the
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
    // Project skills too: the routing filter honours a `/name` only some clone has, so it must complete.
    const lists = [...(machine.exclaves ?? []).map((x) => x.skills), ...machine.repos.map((r) => r.skills ?? [])];
    for (const list of lists) {
      for (const name of list) {
        // Whitespace can't sit inside the `/name` token, so it could never be typed or completed.
        if (!/\s/u.test(name)) names.add(name);
      }
    }
  }
  return [...names].toSorted(collator.compare);
}

/** The `/name` token the caret is completing: `prompt.slice(start, end)`, `end` at the caret. */
export interface SkillToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/**
 * The token the picker completes, by the routing filter's rule
 * (shared/src/skill-token.ts): a `/` at the start, after whitespace or after an
 * opening wrapper, then no whitespace or second `/` up to the caret, the caret
 * followed by whitespace or the end. So `… /sh|` and `` `/sh| `` open anywhere,
 * but a slash inside a word or URL (`and/or`, `https://a/b`) never does, nor a
 * path (`/tmp/x`). The token starts at the `/`, so a wrapper stays outside it.
 * A caret before a closing wrapper (`` `/sh|` ``) does not open: no space fits
 * there, so a pick would leave the token open under the caret. Null for a
 * selection range (`caret` null).
 */
export function skillToken(prompt: string, caret: number | null): SkillToken | null {
  if (caret === null || caret < 0 || caret > prompt.length) return null;
  if (/\S/u.test(prompt.charAt(caret))) return null;
  let slash = caret;
  while (slash > 0 && /[^\s/]/u.test(prompt.charAt(slash - 1))) slash -= 1;
  slash -= 1;
  if (slash < 0 || prompt.charAt(slash) !== "/") return null;
  if (slash > 0 && !SKILL_TOKEN_OPENER.test(prompt.charAt(slash - 1))) return null;
  return { start: slash, end: caret, query: prompt.slice(slash + 1, caret) };
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

/**
 * The prompt after picking: the token becomes `/name` followed by a space, so
 * typing carries on, reusing one already there rather than doubling it.
 * `caret` sits past that space.
 */
export function completeSkill(
  prompt: string,
  token: SkillToken,
  name: string,
): { readonly prompt: string; readonly caret: number } {
  const before = `${prompt.slice(0, token.start)}/${name}`;
  const after = prompt.slice(token.end);
  if (after.startsWith(" ")) return { prompt: before + after, caret: before.length + 1 };
  return { prompt: `${before} ${after}`, caret: before.length + 1 };
}

/** A run of the prompt mirror from offset `start`: `skill` paints it, `anchor` is the picked token's own run. */
export interface PromptSegment {
  readonly start: number;
  readonly text: string;
  readonly skill: boolean;
  readonly anchor: boolean;
}

/**
 * The prompt cut into runs for the field's mirror: every `/name` token (the
 * routing rule, as `skillToken`) whose name the index knows is a `skill` run —
 * the `/` and name only, a wrapper or trailing punctuation left plain — as
 * Claude Code highlights one — an unknown name still goes as typed, it just
 * isn't marked. Also cut at both ends of `anchor` so the view can measure exactly
 * the token being picked (a span running on to the prompt's end would report
 * every line's height). The runs join back to the prompt exactly: the mirror must
 * draw the textarea's text glyph for glyph.
 */
export function promptSegments(
  prompt: string,
  skills: readonly string[],
  anchor: { readonly start: number; readonly end: number } | null,
): readonly PromptSegment[] {
  const cuts = new Set<number>([0, prompt.length]);
  const marked = new Set<number>();
  for (const match of prompt.matchAll(SKILL_TOKEN)) {
    const name = trimSkillName(match[1] ?? "");
    if (!skills.includes(name)) continue;
    cuts.add(match.index).add(match.index + 1 + name.length);
    marked.add(match.index);
  }
  if (anchor !== null && anchor.start >= 0 && anchor.start < anchor.end && anchor.end <= prompt.length) {
    cuts.add(anchor.start).add(anchor.end);
  }
  const sorted = [...cuts].toSorted((a, b) => a - b);
  const segments: PromptSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const from = sorted[i] ?? 0;
    const to = sorted[i + 1] ?? prompt.length;
    if (to <= from) continue;
    segments.push({
      start: from,
      text: prompt.slice(from, to),
      skill: marked.has(from),
      anchor: anchor !== null && from === anchor.start,
    });
  }
  return segments;
}
