# Answering the custodian — proposal

**Status: draft 2026-11-24, parked by the owner the same day: build presence's `self.doing` (docs/presence.md §1, O1) first, then see which false positives are left. Only R0 is decided, and built (#592); nothing else is.** A session that receives a custodian `nudge` has no way
to say "this does not apply", so the next round, reading the same facts, may nudge it again. This file proposes a
reply channel, its bounds and its threat model, with alternatives, for the owner to decide before any code. It
builds on DESIGN.md's "The custodian frame kind" (`nudge`, the flags file and counts, the threat-model paragraph),
"Session messages" and "Replies by handle", and on docs/presence.md's D1.6 (the custodian reading `self.doing`,
decided as O1, not built), whose reasoning it reuses. Proposed decisions are numbered R1–R8; once decided they
become C50 onward in DESIGN.md and docs/custodian.md's index, and this file goes.

## The problem, measured against what exists

- **The wrapper says so.** `custodianRequest` (`shared/src/messages.ts`) ends "It cannot be replied to." True by
  construction: `deliverAsCustodian` places an item with no `origin`, so `noteReceived` records no `received`
  handle, and a `send_message` with `inReplyTo` the nudge's id is answered `unknown`.
- **The round cannot receive.** It is a fenced, sandboxed reader with no inbox, no network and one short round; it is
  gone before a reply could come. Whatever answers it must be stored by the daemon and read by a later round.
- **What a false positive costs today**, which bounds what this is worth: at most one nudge per round and
  `maxNudges` (default 3) per session, each nudge a wasted turn of the session's (the mod submits it); and the
  false positives **spend the session's nudge budget**, so a session nudged twice for a PR it closed on purpose has
  one nudge left for when it is really stuck, after which the round flags `stuck` and the owner gets a card line for
  nothing. Bounded, not dangerous; the value of a reply is fewer wasted turns, a budget kept for real trouble, and
  fewer false `stuck` cards.

### The motivating example is a checklist gap, fixable on its own

"Red CI on a PR I closed on purpose": the `pr` verb already returns the PR's `state` (`custodian-pr.ts` asks for
`state`), but `daemon/custodian/agent.md`'s red-CI case reads only "a check that failed". One line ("only a PR whose
`state` is `OPEN`; a closed or merged PR's checks are not the session's to fix, and it counts as finished") removes
that whole class with no new act. **Recommended regardless of the rest** (R0), as its own small change. A reply
channel is for the false positives the daemon's facts cannot see: a long build the session knows is fine, a check
that is red upstream and not the session's, a wait the owner asked for.

## Recommended shape

A session answers a nudge **by handle**, the gesture messaging already has; the daemon **stores** the answer beside
that session's counts; the next round **reads it as the session's own claim** in `sessions`; the daemon **enforces
nothing** from it.

- **R1. A nudge becomes answerable by handle, once, by the session it reached.** `deliverAsCustodian` gives its item
  a custodian origin (a constant sentinel, never a device id), so `noteReceived` makes the usual `received` entry,
  bound like every other to pane, pid, task and the `claude` process (`Bound.session`). `sendReply` checks that entry
  as it does now (`unknown` for any other pane, process, task or session) and, for the custodian origin, stores
  instead of placing or routing: never into a pane, never through the leader, never to another machine. The handle
  is consumed by the first accepted reply (a second is `unknown`), and lapses with the `received` table's 1 h TTL.
  The reply's `MessageReply` outcome is a new `stored`. It counts in the sender's own rate bucket, as any reply.
- **R2. Bounds on the text.** At most `FLAG_NOTE_MAX` (200) characters, under the same printable-text rule as a
  flag's note (`parse.ts`), applied before anything is stored; one line. Over it is `too_long`, never truncated (a
  cut sentence can invert its meaning: "not stuck, unless …").
- **R3. Where it lives.** In `custodian/sessions.json`, as a `replies` map beside `flags` and `counts`
  (`{v: 1, flags, counts, replies}`; a file without it reads as none): `{pid, text, at}`, keyed and bound exactly
  like the counts (task id, the session's pid, read as none for another pid, dropped by `pruneCounts` when the
  session ends, kept across a daemon restart). One reply per session: a reply to a later nudge replaces it. The file
  is already the daemon's alone, 0600 in the 0700 dir, masked from the round's sandbox and denied to its `Read`
  (4b), so **no mask, fence, built environment or socket changes, and no re-drill** (docs/custodian.md, item 4b's
  rule; the same reasoning as presence D1.6).
- **R4. How a round sees it.** Only through `sessions`: each `ours` pane's view gains
  `reply: {text, minutes} | null` (`minutes` since it was stored, like `stateMinutes`), the verb's help text calling
  it the session's own claim. Never in the seed or the notes (those are the round's own words; a reply must not read
  as an earlier round's reasoning, the reason a flag's note is withheld), never in `capture`, never kept by the
  daemon past the reply. The round may restate it in its notes or summary, as it may restate a screen today.
- **R5. How the round weighs it** (`agent.md`): a reply is evidence about intent, never about state. It may stop
  further **nudges** on the matter it answers; it never makes a session count as finished for `close` (the daemon's
  `closeVerdict` does not read it anyway), and it never stops a **flag**: a session the round would flag `stuck` after
  its nudges is flagged whatever it replied, and a session whose reply contradicts what its screen has shown for a
  long time is flagged `look`. The seed gains one sentence, as presence D1.7's does: a session's reply is its own
  claim, never evidence that it is at rest, finished or stuck.
- **R6. The wrapper.** "It cannot be replied to." becomes, roughly: "If it is mistaken or you will not do it, you may
  answer it once, by its id (`send_message` with `inReplyTo`), in one line under 200 characters; a later custodian
  round reads it. Do not answer otherwise." The invitation is narrow on purpose: every reply is a tool call, and a
  reply to a nudge the session simply acts on is noise.
- **R7. Nothing logged, nothing leaves the machine.** The text is in no log, audit line, `rounds.jsonl` (by the
  daemon), leader event, `get_queue`, archive or push. The `message` audit line names the recipient as the constant
  `custodian` (as replies name `reply`), with the handle never written, bytes and outcome as today. `custodian`
  origin gains nothing: storing a reply is messaging's act, not a verb.
- **R8. No capability flag.** Both ends are one daemon: the wrapper that invites the reply and `sendReply` that
  stores it ship together, and a session's `seance mcp` sends a local frame. Nothing crosses the wire, so
  "offer only what the peer advertises" has no peer here.

## Threat model

A new act: a session's text, written after reading a custodian request, persists in a daemon file and reaches a
later round. Recorded here as CLAUDE.md requires; it folds into "The custodian frame kind"'s threat-model paragraph.

| What an injected session (or one that is wrong) could try | What bounds it                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inject the round through the reply text                   | Not a new reach: `capture` already hands the round far more of the same session's text. New is persistence (it arrives unasked in every `sessions` until replaced or the session ends): accepted on presence D1.6's grounds, every act gated by the daemon's facts. |
| Silence the custodian about itself while really stuck     | Nothing enforces the reply (R5): `close` never reads it, `interrupt` keeps its own still-screen gate, and the checklist never lets a reply stop a flag, so the owner's view is unchanged. Worst case: it is nudged fewer times, which it could already ignore.      |
| Silence the custodian about **another** session           | Impossible: the handle binds the `claude` process the nudge reached, and the reply is stored only under that session's key and shown only in its own pane's view.                                                                                                   |
| A hung session (inside a command)                         | Cannot reply at all: a reply needs a turn. `interrupt` covers it exactly as now.                                                                                                                                                                                    |
| Flood the round or the file                               | One reply per nudge, nudges ≤ `maxNudges` a session, one kept a session, 200 characters, the sender's rate bucket.                                                                                                                                                  |
| Smuggle control text into the round's JSON or a terminal  | The printable rule before storing; the reply reaches only `sessions`' JSON, and `printable` already guards everything the owner's CLI prints from a round's summary.                                                                                                |
| Reply with no nudge, or forge one                         | Only a `received` handle the daemon minted for that session's nudge is accepted; a frame carries no key, task or pane, and the binding is the peer pid (recurring rule).                                                                                            |
| A same-uid process                                        | As today: one that makes itself a descendant of the session's `claude` can reply for it, and could already type into its pane.                                                                                                                                      |

**Residual, accepted if this is chosen:** a session (injected, or confidently wrong) can talk the round out of
nudging it, so a really stuck session reaches its `stuck` flag through the round's own judgment of the screen rather
than through spent nudges. The owner still sees it; it may take a round or two longer.

## Alternatives

- **A. Only fix the checklist** (R0 and similar rules: an `OPEN` PR only, a `doing` line when presence lands). No new
  act at all. Leaves every false positive the facts cannot show, and the budget they spend.
- **B. The recommendation above:** stored reply, round reads it, nothing enforced.
- **C. B plus a daemon-enforced suppression:** a reply with a closed reason (`not_applicable`, `owner_asked`) makes the
  daemon refuse further `nudge`s of that session (`declined`) until its next new turn, or for a TTL.
  **Not recommended:** the daemon cannot check the claim, so this turns a session's word into a gate, which is
  exactly the act an injected session should not have; and nudges are free text, so the daemon cannot tell a
  repeat of the same matter from a new one. Revisit only if, after B ships, rounds keep nudging past clear replies;
  then the narrow form is "refuse a nudge in the round after a reply, once", never a standing silence, and never
  touching `flag` or `interrupt`.
- **D. Route the reply to the owner instead** (onto the flag or the card). The owner adjudicates. Costs the owner's
  attention for what is usually a non-event, puts session-chosen text on the leader's record (which `flag.note`
  rules and the archivist would have to carry), and does not stop the next round's nudge. Not recommended as the
  default; a round that disbelieves a reply already has `flag look`.
- **E. Use `self.doing` instead** (presence §1, O1 decided, unbuilt). A session keeps a line the round reads, which
  covers "waiting on CI by design" without any answer to a specific nudge. Complementary, not a substitute: it needs
  the session to anticipate the round, and says nothing about a nudge it disagrees with. If presence PR 1 and PR 4 land
  first, B shrinks to the cases `doing` misses, and R4's view field sits beside `tags`.

## What it touches (if B is chosen)

- `shared/src/messages.ts`: `custodianRequest`'s last sentence (R6); a `stored` reply outcome.
- `daemon/src/messages.ts`: the custodian origin on `deliverAsCustodian`'s item; `sendReply`'s store branch; a
  `deps` hook into the flags store (the store, not a second file).
- `daemon/src/custodian-flags.ts`: the `replies` map, bound and pruned like `counts`.
- `daemon/src/custodian-verbs.ts`, `custodian-frame.ts`: `CustodianPaneView.reply`.
- `daemon/custodian/agent.md` and the seed: R5's rules and sentence (plus R0).
- Records: DESIGN.md ("The custodian frame kind": `nudge`, `sessions`, the flags file, the threat-model paragraph;
  "Replies by handle": a destination that is stored, not placed); `.claude/rules/custodian.md` (`nudge`, `sessions`,
  the store) and `.claude/rules/messages.md` (Replies by handle, the second way into the inbox); docs/custodian.md's
  index (C50 onward).
- Tests: a reply from the nudged session is stored and shown; from another pane, process, task or a restarted
  `claude` is `unknown`; a second reply is `unknown`; size and printable refusals; dropped when the session ends;
  never in a log or audit line (the existing layering and audit tests' style).

## Open questions for the owner

1. B, A only, or C (B plus enforced suppression)?
2. The cap: `FLAG_NOTE_MAX` (200) as proposed, or more room for an explanation?
3. Should a reply also lift a round's own `look` flag on that session? Proposed: no (R5: a reply never touches a
   flag; the next new turn or a close lifts it, as now).
