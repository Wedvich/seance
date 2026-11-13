import { identityOfState, loadOrInitState, parseState, type State } from "../../daemon/src/state.ts";

/**
 * The seat's id is configuration (it must equal the relay's `ARCHIVIST`), so
 * unlike the daemon's `loadOrInitState` this never replaces a file it cannot
 * use: a re-minted id would be refused 4403 forever, and an unreadable file
 * overwritten is a seed gone. Mints only when the file is absent.
 */
export async function loadSeatState(path: string): Promise<State> {
  const result = await parseState(path);
  if (result === null) return loadOrInitState(path);
  const refuse = (problem: string): Error =>
    new Error(
      `state at ${path} ${problem} — refusing to replace the archivist's identity: restore the file, ` +
        `or delete it and set the relay's ARCHIVIST secret to the id the next run mints`,
    );
  if ("problem" in result) throw refuse(result.problem);
  try {
    await identityOfState(result.state);
  } catch (err) {
    throw refuse(`holds an unusable identity (${err instanceof Error ? err.message : String(err)})`);
  }
  return result.state;
}
