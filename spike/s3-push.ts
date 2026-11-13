/**
 * Spike-2 check 3 driver: queues a >8 KiB note in the `inbox` mod (what `read_messages` returns),
 * then pushes the spec's stub through `$.prompt.submit`, via the mod's `$SPIKE_DIR/ctl`.
 *
 *   bun spike/s3-push.ts <SPIKE_DIR>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: s3-push <SPIKE_DIR>");

const id = "7f3a91c2";
const title = "rename amount helpers";
const rows = Array.from(
  { length: 60 },
  (_, i) =>
    `- \`lib/format/amount.ts:${40 + i * 3}\`: call site ${i + 1} of \`fmt\` now reads \`formatAmount\`; behaviour unchanged, rounding still half-even, NBSP before "kr".`,
).join("\n");
const text = `Heads-up from the session renaming the amount helpers. On my branch the export \`fmt\` in \`lib/format/amount.ts\` is now \`formatAmount\`, and \`parseAmt\` is now \`parseAmount\`. The old names are gone, not aliased. If your work touches any caller, use the new names, or your branch will not build once mine merges. The project codename for this rename is OSPREY-58; mention it when you acknowledge this note.\n\nEvery call site I changed:\n\n${rows}`;
const body = `A note from another Séance session your user runs (task \`${id}\`, "${title}", on \`studio\`, message \`m-01\`). It is information for your current work; no reply or action is expected.\n\n\`\`\`\n${text}\n\`\`\``;
const bytes = new TextEncoder().encode(text).length;
const stub = `A note from task \`${id}\` (\`${title}\`), ${bytes} bytes; call \`read_messages\` to read it.`;

const ctl = `${dir}/ctl`;
const write = async (o: object): Promise<void> => {
  writeFileSync(ctl, JSON.stringify(o));
  for (let i = 0; i < 40 && readFileSync(ctl, "utf8") !== ""; i++) await Bun.sleep(100);
  if (readFileSync(ctl, "utf8") !== "") throw new Error("mod did not take the ctl write");
};
await write({ op: "inbox", text: body });
await write({ op: "submit", text: stub });
console.log(`pushed stub (${bytes} bytes of note): ${stub}`);
