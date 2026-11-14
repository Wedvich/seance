import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vsockFilter } from "./custodian-seccomp.ts";

/** Whether this host can run a filter through bwrap at all (Linux with unprivileged user namespaces, python3 for the probe). */
async function bwrapRuns(): Promise<boolean> {
  if (process.platform !== "linux" || Bun.which("bwrap") === null || Bun.which("python3") === null) return false;
  const probe = Bun.spawn(["bwrap", "--dev-bind", "/", "/", "--", "true"], { stdout: "ignore", stderr: "ignore" });
  return (await probe.exited) === 0;
}

/** Opens one socket of each family under the filter and prints each outcome (an errno, or `ok`). */
const PROBE = `
import socket
for name, fam in (("vsock", socket.AF_VSOCK), ("unix", socket.AF_UNIX), ("inet", socket.AF_INET)):
    try:
        socket.socket(fam, socket.SOCK_STREAM).close(); print(name, "ok")
    except OSError as e:
        print(name, e.errno)
`;

describe("vsockFilter", () => {
  test("is written for x64 and arm64 only, whole instructions", () => {
    for (const arch of ["x64", "arm64"]) {
      const length = vsockFilter(arch)?.length ?? 0;
      expect(length).toBeGreaterThan(0);
      expect(length % 8).toBe(0);
    }
    expect(vsockFilter("ia32")).toBeNull();
    expect(vsockFilter("riscv64")).toBeNull();
  });

  test.skipIf(!["x64", "arm64"].includes(process.arch))(
    "under bwrap --seccomp: AF_VSOCK refused EAFNOSUPPORT, AF_UNIX and AF_INET still open, through a nested bwrap too",
    async () => {
      if (!(await bwrapRuns())) return;
      const dir = await mkdtemp(join(tmpdir(), "seccomp-"));
      try {
        const filter = vsockFilter(process.arch);
        if (filter === null) throw new Error("no filter");
        const path = join(dir, "f.bpf");
        await writeFile(path, filter);
        const run = async (argv: readonly string[]): Promise<string> => {
          const file = Bun.file(path);
          const child = Bun.spawn(["bwrap", "--dev-bind", "/", "/", "--seccomp", "3", "--", ...argv], {
            stdio: ["ignore", "pipe", "pipe", file],
          });
          const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect({ code: await child.exited, err }).toEqual({ code: 0, err: "" });
          return out;
        };
        // A failed AF_VSOCK create would be 97 (EAFNOSUPPORT) without the filter too where the module is absent, so the
        // control below shows this host can create one at all; without that, only the other families are asserted.
        const control = Bun.spawn(
          ["python3", "-c", "import socket; socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)"],
          {
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        const vsockAvailable = (await control.exited) === 0;
        const expected = `${vsockAvailable ? "vsock 97\n" : ""}unix ok\ninet ok\n`;
        const strip = (out: string): string =>
          out
            .split("\n")
            .filter((line) => line !== "" && (vsockAvailable || !line.startsWith("vsock")))
            .map((line) => `${line}\n`)
            .join("");
        expect(strip(await run(["python3", "-c", PROBE]))).toBe(expected);
        const nested = await run([
          "bwrap",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--unshare-user",
          "--unshare-net",
          "--",
          "python3",
          "-c",
          PROBE,
        ]);
        expect(strip(nested)).toBe(expected);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
