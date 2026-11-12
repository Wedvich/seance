// Keeps macOS's first-exec scan queue deep, as a full `bun run test` does when every shard
// writes its stubs at once: N workers each write a never-executed script, run it, delete
// it, forever. A test whose first exec of a new file lands in a timed window fails under
// it on demand (docs/development.md, "Reproducing a flaky test"). Linux has no such scan.
//
//   bun scripts/scan-flood.ts [workers=16] &
//   bun test daemon/test/<suite>.test.ts --timeout 15000; kill %1
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workers = Number(process.argv[2] ?? 16);
if (!Number.isInteger(workers) || workers < 1)
  throw new Error(`workers must be a positive integer, not ${process.argv[2]}`);
const dir = await mkdtemp(join(tmpdir(), "scan-flood-"));
let n = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void rm(dir, { recursive: true, force: true }).finally(() => process.exit(0));
  });
}

async function firstExec(): Promise<void> {
  const file = join(dir, `f-${n++}`);
  // Random content: the verdict is per inode, but a distinct file rules out any content cache.
  await writeFile(file, `#!/bin/bash\nexit 0\n# ${Math.random()}\n`);
  await chmod(file, 0o755);
  await Bun.spawn([file], { stdout: "ignore", stderr: "ignore" }).exited;
  await rm(file, { force: true });
}

async function worker(): Promise<never> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one scan in flight per worker: the count sets the depth
    await firstExec();
  }
}

await Promise.all(Array.from({ length: workers }, worker));
