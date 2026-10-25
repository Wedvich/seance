/**
 * The one `/name` token rule, shared by the PWA picker and the scheduler's
 * skills filter so what completes is what routes: a `/` at the start, after
 * whitespace or after an opening wrapper (`` ` " ' ( [ ``), the name running to
 * the next whitespace with no second `/` (`and/or`, `https://a/b`, `/tmp/x` are
 * none). Only the one character before the `/` is checked, so `x(/sh` counts.
 */

/** A character a token may follow, besides whitespace or the text's start. */
export const SKILL_TOKEN_OPENER = /^[\s`"'([]$/u;

/** Every token in a text; group 1 is the raw name, closing run included — pass it through `trimSkillName`. */
export const SKILL_TOKEN = /(?<![^\s`"'([])\/([^\s/]+)(?=\s|$)/gu;

/**
 * Closing wrappers and trailing sentence punctuation are not part of the name
 * (a token ending in `:` cannot be a `plugin:name`, but `:` stays inside one).
 */
export function trimSkillName(raw: string): string {
  return raw.replace(/[.,;!?:`"')\]]+$/u, "");
}
