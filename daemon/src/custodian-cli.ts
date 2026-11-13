/**
 * `seanced custodian <verb>`: the round's verbs (docs/custodian.md). Built with custodian PR 4; until then the
 * command exists so the round's `Bash(seanced custodian *)` allowance names a real command and a round in this
 * build reports a clear refusal. Imported statically by `main.ts` like `session-event` (the round runs its verbs
 * many times a turn): no import here may be heavy, and none may reach `log.ts`.
 */
export function cmdCustodian(_rest: readonly string[]): Promise<void> {
  console.error("seanced custodian: not built yet — the verbs land with custodian PR 4 (docs/custodian.md)");
  process.exit(2);
}
