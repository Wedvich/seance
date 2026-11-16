import { describe, expect, test } from "bun:test";
import { COMMANDS, CUSTODIAN_OWNER_VERBS } from "./commands.ts";
import { custodianFence, DENY, procSysReadOnly } from "./custodian-fence.ts";

/**
 * Claude Code's `Bash(p)` matcher, approximated: `*` matches any run of characters (spaces included) and the pattern
 * must match the whole command. Its real behaviour is Claude Code's, so this guards the generation, not the matcher
 * (the dev check runs a real round).
 */
function matches(pattern: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/u.exec(pattern)?.[1];
  if (body === undefined) return false;
  const regex = body
    .split("*")
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}$`, "u").test(command);
}

const denied = (command: string): boolean => DENY.some((pattern) => matches(pattern, command));

describe("DENY", () => {
  test("each git entry comes in all four forms", () => {
    for (const subcommand of ["push", "worktree remove", "branch -D"]) {
      for (const form of [
        `Bash(git ${subcommand})`,
        `Bash(git ${subcommand} *)`,
        `Bash(git * ${subcommand})`,
        `Bash(git * ${subcommand} *)`,
      ]) {
        expect(DENY).toContain(form);
      }
    }
  });

  test("the owner's custodian verbs and `notes --clear` are denied to the round, bare and with arguments; the round's verbs are not", () => {
    for (const verb of CUSTODIAN_OWNER_VERBS) {
      expect(denied(`seanced custodian ${verb}`)).toBe(true);
      expect(denied(`seanced custodian ${verb} --for 1h`)).toBe(true);
    }
    expect(denied("seanced custodian notes --clear")).toBe(true);
    expect(denied("seanced custodian notes --clear --x")).toBe(true);
    for (const allowed of [
      "sessions",
      "close %3",
      "capture %3",
      "pr %3",
      "flag %3 stuck",
      "flag %3 look a note",
      "nudge %3",
      "interrupt %3",
      "notes",
      "done",
    ]) {
      expect(denied(`seanced custodian ${allowed}`)).toBe(false);
    }
  });

  test("every seanced command but custodian is denied, plain and with an argument; custodian's verbs are not", () => {
    for (const name of COMMANDS.filter((command) => command !== "custodian")) {
      expect(denied(`seanced ${name}`)).toBe(true);
      expect(denied(`seanced ${name} --x`)).toBe(true);
    }
    expect(denied("seanced")).toBe(true);
    expect(denied("seanced custodian sessions")).toBe(false);
    expect(denied("seanced custodian done")).toBe(false);
  });

  test("tmux and gh are denied whole: a round reads through the verbs", () => {
    for (const command of [
      "tmux",
      "tmux capture-pane -p -t %1",
      "tmux -L s capture-pane -p -t %1",
      "gh pr view 1 --json state",
      "gh api repos/o/r/pulls/1",
      "gh",
    ]) {
      expect(denied(command)).toBe(true);
    }
  });

  test("the verbs and plain reads a round needs are not denied", () => {
    for (const command of [
      "seanced custodian capture %1",
      "seanced custodian pr %1",
      "seanced custodian sessions",
      "git log -1",
      "git status",
      "git -C /x log --oneline",
    ]) {
      expect(denied(command)).toBe(false);
    }
  });

  test("writes, shell runners and the workarounds the spec verified are denied", () => {
    for (const command of [
      "gh api graphql -f q=1",
      "gh api -X POST x",
      "gh api x --method PATCH",
      "gh pr update-branch 1",
      "gh release delete-asset v1 a",
      "gh project item-create 1",
      "gh pr merge 1",
      "gh workflow run x",
      "tmux -L s run-shell x",
      "tmux neww x",
      "tmux send-keys -t %1 x",
      "tmux -L s send-keys -t %1 x",
      "tmux set-option -p @seance-task x",
      "tmux select-pane -t %1 -T x",
      "tmux -L s set-environment -g PATH x",
      "tmux rename-window -t %1 x",
      "tmux move-window -t 2",
      "tmux bind-key x kill-server",
      "tmux save-buffer -b x /tmp/y",
      "tmux -L s saveb /tmp/y",
      "tmux -C attach",
      "tmux lock-server",
      "tmux copy-mode -t %1",
      "tmux server-access -a user",
      "gh pr view 1 merge",
      "gh pr comment 1 -b x",
      "gh pr close 1",
      "git -C /x push",
      "git push",
      "git checkout main",
      "git branch -D x",
      "git worktree remove /w",
      "rm -rf /",
      "kill 1",
      "systemctl --user restart seanced",
      "ssh host",
    ]) {
      expect(denied(command)).toBe(true);
    }
  });
});

describe("custodianFence", () => {
  const base = {
    roundDir: "/r/.seance-custodian",
    socketDir: "/tmp/seance-cu-s-x",
    denyRead: ["/home/u", "/etc"],
    allowRead: ["/etc/resolv.conf"],
    readDenies: [
      { path: "/home/u/.ssh", dir: true },
      { path: "/home/u/.claude/.credentials.json", dir: false },
    ],
  } as const;

  test("macOS lists the round socket's directory alone and never allows every socket", () => {
    const fence = custodianFence({ ...base, platform: "darwin", weakerNested: false });
    expect(fence.sandbox.network.allowUnixSockets).toEqual([base.socketDir]);
    expect(fence.sandbox.network).not.toHaveProperty("allowAllUnixSockets");
  });

  test("Linux allows all sockets and lists none; the weaker nested mode only where asked", () => {
    const plain = custodianFence({ ...base, platform: "linux", weakerNested: false });
    expect(plain.sandbox.network.allowAllUnixSockets).toBe(true);
    expect(plain.sandbox.network).not.toHaveProperty("allowUnixSockets");
    expect(plain.sandbox).not.toHaveProperty("enableWeakerNestedSandbox");
    const nested = custodianFence({ ...base, platform: "linux", weakerNested: true });
    expect(nested.sandbox.enableWeakerNestedSandbox).toBe(true);
    // A macOS host never takes it, whatever the flag says.
    expect(custodianFence({ ...base, platform: "darwin", weakerNested: true }).sandbox).not.toHaveProperty(
      "enableWeakerNestedSandbox",
    );
  });

  test("no network at all: allowedDomains is present and empty, and the weaker network isolation is not asked for", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { sandbox } = custodianFence({ ...base, platform, weakerNested: false });
      expect(Object.hasOwn(sandbox.network, "allowedDomains")).toBe(true);
      expect(sandbox.network.allowedDomains).toEqual([]);
      expect(sandbox).not.toHaveProperty("enableWeakerNetworkIsolation");
    }
  });

  test("the shared shape: one denied write dir, dontAsk, only the verbs allowed", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const fence = custodianFence({ ...base, platform, weakerNested: false });
      expect(fence.sandbox.filesystem).toEqual({
        denyWrite: [base.roundDir],
        denyRead: base.denyRead,
        allowRead: base.allowRead,
      });
      expect(fence.permissions.defaultMode).toBe("dontAsk");
      expect(fence.permissions.allow).toEqual(["Bash(seanced custodian *)"]);
      expect(fence.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
      });
    }
  });

  test("a Read deny is an absolute path in the double-slash form, a directory with its contents, after the command denies", () => {
    const { permissions } = custodianFence({ ...base, platform: "linux", weakerNested: false });
    expect(permissions.deny.slice(0, DENY.length)).toEqual([...DENY]);
    const reads = permissions.deny.slice(DENY.length);
    expect(reads).toEqual(["Read(//home/u/.ssh/**)", "Read(//home/u/.claude/.credentials.json)"]);
    for (const rule of reads) expect(rule.startsWith("Read(//")).toBe(true);
  });
});

describe("procSysReadOnly", () => {
  const mount = (point: string, options: string): string => `30 25 0:5 / ${point} ${options} - proc proc rw`;

  test("a read-only /proc/sys (an LXC container) is true", () => {
    expect(procSysReadOnly([mount("/proc", "rw,nosuid"), mount("/proc/sys", "ro,nosuid,relatime")].join("\n"))).toBe(
      true,
    );
  });

  test("a writable /proc with no /proc/sys line, or a writable /proc/sys, is false", () => {
    expect(procSysReadOnly(mount("/proc", "rw,nosuid"))).toBe(false);
    expect(procSysReadOnly([mount("/proc", "ro"), mount("/proc/sys", "rw,nosuid")].join("\n"))).toBe(false);
  });

  test("a mount that only shares a name prefix does not cover it; garbage is false", () => {
    expect(procSysReadOnly([mount("/proc", "rw"), mount("/proc/sysfoo", "ro")].join("\n"))).toBe(false);
    expect(procSysReadOnly("garbage\n\n")).toBe(false);
  });
});
