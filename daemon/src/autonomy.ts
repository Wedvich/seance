import type { AgentKind, AutonomyLevel } from "@seance/shared";

/**
 * What a level means, told to the session in its seed. Generic on purpose: séance knows no
 * workspace, so the workspace's own guardrails reach the session through its CLAUDE.md files,
 * which the last clause defers to. Every real choice goes through AskUserQuestion because that
 * is what session-events reports as needs-input, and what Remote Control shows with its options.
 *
 * Codex has no AskUserQuestion: a question is prose, and the turn's end is what reaches the user
 * (docs/codex.md, D6), so its words say to end the turn with the question stated. It reads AGENTS.md
 * where a directory has one, else CLAUDE.md (S9), so its guardrails are named as both.
 */
function stops(instructions: string): string {
  return (
    "These always stop for the user, at every level: deploying to production or changing production data; " +
    "changing how a money figure users see is computed or worded; placing, rotating or printing a secret; " +
    "deleting anything you did not create, or work that is not committed; force-pushing any branch but your own; " +
    "messaging or posting to other people; getting past a permission, a protection or a required review; " +
    `raising a limit the user set; and every guardrail your ${instructions} files name.`
  );
}

const NO_CONFIRMATIONS =
  "Never end a turn to ask whether to proceed or whether to take the obvious next step: take it.";

function preambles(ask: string, instructions: string): Readonly<Record<AutonomyLevel, string>> {
  const always = stops(instructions);
  return {
    steer:
      "Autonomy: steer. The user wants their hand on the wheel: investigate and propose a plan, then wait for " +
      `their approval before changing anything. When a choice is theirs, ${ask} ${always}`,
    checkpoint:
      `Autonomy: checkpoint. ${NO_CONFIRMATIONS} Stop only for a real choice, one whose options lead to ` +
      `outcomes the user would weigh differently, and ${ask} ${always}`,
    auto:
      `Autonomy: auto. The user is away and expects the work done. ${NO_CONFIRMATIONS} When a choice has a ` +
      `recommendation and is cheap to reverse, make it and record it as "Decided: X, because Y" where the ` +
      `user will review the work (the plan, the PR description). Stop only for a choice you have no ` +
      `recommendation for, or a blocker you cannot clear, and ${ask} ${always}`,
  };
}

export const AUTONOMY_PREAMBLE: Readonly<Record<AutonomyLevel, string>> = preambles(
  "ask it with AskUserQuestion, your recommendation first, so it reaches the user wherever they are.",
  "CLAUDE.md",
);

export const CODEX_AUTONOMY_PREAMBLE: Readonly<Record<AutonomyLevel, string>> = preambles(
  "end your turn with the question stated, your recommendation first: the end of your turn is what reaches the user.",
  "AGENTS.md or CLAUDE.md",
);

/** The seed's closing note on the level; `SEANCE_AUTONOMY` holds the same level past a compaction. */
export function autonomyNote(level: AutonomyLevel, agent: AgentKind = "claude"): string {
  const preamble = agent === "codex" ? CODEX_AUTONOMY_PREAMBLE : AUTONOMY_PREAMBLE;
  return `\n${preamble[level]} SEANCE_AUTONOMY in your environment holds this level.\n`;
}
