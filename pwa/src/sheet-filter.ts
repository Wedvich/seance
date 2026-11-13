export interface MatchSplit {
  readonly before: string;
  readonly hit: string;
  readonly after: string;
}

// A case-insensitive regex's index is in the original string; lowercasing first can change its length ("İ") and misplace the split.
function matcher(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  return new RegExp(trimmed.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
}

export function matchesFilter(query: string, fields: readonly string[]): boolean {
  const pattern = matcher(query);
  if (pattern === null) return true;
  return fields.some((field) => pattern.test(field));
}

export function splitMatch(text: string, query: string): MatchSplit | null {
  const pattern = matcher(query);
  if (pattern === null) return null;
  const found = pattern.exec(text);
  if (found === null) return null;
  return {
    before: text.slice(0, found.index),
    hit: text.slice(found.index, found.index + found[0].length),
    after: text.slice(found.index + found[0].length),
  };
}
