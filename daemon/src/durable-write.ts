import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

let tempSeq = 0;

/**
 * Temp, fsync, rename, then fsync the directory: the file's bytes and the
 * rename that publishes them both reach the disk before this resolves. Without
 * the directory sync a power cut can bring the previous file back. macOS
 * `fsync` stops at the drive's own cache (`F_FULLFSYNC`, which Node does not
 * expose), so there it outlasts a process or kernel crash, not every power cut.
 *
 * Not serialized: a caller with overlapping writes chains them itself.
 */
export async function writeDurable(path: string, text: string, mode: number): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // Per call, not per process: overlapping writers would otherwise share a temp name.
  const temp = `${path}.${process.pid}.${tempSeq++}.tmp`;
  try {
    const handle = await open(temp, "w", mode);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
