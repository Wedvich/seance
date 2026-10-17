import type { Machine } from "@seance/shared";

/**
 * The `/` picker's logic (DESIGN.md, PWA): the union of every machine's
 * `exclaves[].skills`, read from the register blobs the app already holds, so
 * it needs no leader. Pure, so the component stays a thin view over it.
 */

export interface SkillSource {
  readonly machine: string;
  /** The exclaves on this machine that have the skill. */
  readonly exclaves: readonly string[];
  /** The machine reports more than one exclave, so naming them says something. */
  readonly multiExclave: boolean;
}

export interface SkillEntry {
  readonly name: string;
  readonly sources: readonly SkillSource[];
}

export interface SkillIndex {
  readonly skills: readonly SkillEntry[];
  /** Machines that report any exclave — what "every machine" means for a skill. */
  readonly machines: number;
}

const collator = new Intl.Collator();

/**
 * Offline machines count: the blob is the inventory either way, and a name is
 * worth completing wherever it may later run.
 */
export function skillIndex(machines: readonly Machine[]): SkillIndex {
  const byName = new Map<string, SkillSource[]>();
  let reporting = 0;
  const ordered = machines.toSorted((a, b) => collator.compare(a.name, b.name));
  for (const machine of ordered) {
    const exclaves = machine.exclaves ?? [];
    if (exclaves.length === 0) continue;
    reporting += 1;
    const perSkill = new Map<string, string[]>();
    for (const exclave of exclaves) {
      for (const name of exclave.skills) {
        // Whitespace can't sit inside the `/name` token, so it could never be typed or completed.
        if (/\s/u.test(name)) continue;
        const ids = perSkill.get(name) ?? [];
        if (!ids.includes(exclave.id)) ids.push(exclave.id);
        perSkill.set(name, ids);
      }
    }
    for (const [name, ids] of perSkill) {
      const sources = byName.get(name) ?? [];
      sources.push({ machine: machine.name, exclaves: ids, multiExclave: exclaves.length > 1 });
      byName.set(name, sources);
    }
  }
  const skills = [...byName]
    .map(([name, sources]) => ({ name, sources }))
    .toSorted((a, b) => collator.compare(a.name, b.name));
  return { skills, machines: reporting };
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
export function matchSkills(skills: readonly SkillEntry[], query: string): readonly SkillEntry[] {
  const needle = query.toLowerCase();
  const prefix: SkillEntry[] = [];
  const inner: SkillEntry[] = [];
  for (const entry of skills) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(entry);
    else if (name.includes(needle)) inner.push(entry);
  }
  return [...prefix, ...inner];
}

/** The row's sub-line: `all N machines`, or `name` / `name (ex1, ex2)` per machine. */
export function describeSources(entry: SkillEntry, reportingMachines: number): string {
  if (reportingMachines > 1 && entry.sources.length === reportingMachines) return `all ${reportingMachines} machines`;
  return entry.sources
    .map((source) => (source.multiExclave ? `${source.machine} (${source.exclaves.join(", ")})` : source.machine))
    .join(" · ");
}

/** The prompt after picking: the name as the whole first token, space included so typing carries on. */
export function completeSkill(name: string): string {
  return `/${name} `;
}
