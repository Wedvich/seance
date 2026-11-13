import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands.ts";
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
  test("each git and tmux entry comes in all four forms", () => {
    for (const [program, subcommand] of [
      ["git", "push"],
      ["git", "worktree remove"],
      ["git", "branch -D"],
      ["tmux", "send-keys"],
      ["tmux", "kill-*"],
      ["tmux", "run-shell"],
      ["tmux", "neww"],
    ] as const) {
      for (const form of [
        `Bash(${program} ${subcommand})`,
        `Bash(${program} ${subcommand} *)`,
        `Bash(${program} * ${subcommand})`,
        `Bash(${program} * ${subcommand} *)`,
      ]) {
        expect(DENY).toContain(form);
      }
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

  test("the reads a round needs are not denied", () => {
    for (const command of [
      "gh pr view 1 --json state",
      "gh pr view 1 --json state,statusCheckRollup",
      "gh pr view 1 --json mergeable,mergeStateStatus,reviewDecision",
      "gh pr view 1 --json additions,deletions,comments",
      "gh pr list --state closed",
      "gh issue list --state closed --label sync-deps",
      "gh run list --branch sync-deps",
      "gh pr list --label pinned",
      "gh run view 2",
      "gh api repos/o/r/pulls/1",
      "tmux capture-pane -p -t %1",
      "tmux -L s capture-pane -p -t %1",
      "tmux list-panes -a",
      "tmux display-message -p x",
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
  const base = { roundDir: "/r/.seance-custodian", socketDirs: ["/tmp/tmux-1", "/s/run"] } as const;

  test("macOS lists the socket directories and never allows every socket", () => {
    const fence = custodianFence({ ...base, platform: "darwin", weakerNested: false });
    expect(fence.sandbox.network.allowUnixSockets).toEqual(["/tmp/tmux-1", "/s/run"]);
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

  test("the shared shape: one denied write dir, dontAsk, Read and the verbs allowed", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const fence = custodianFence({ ...base, platform, weakerNested: false });
      expect(fence.sandbox.filesystem.denyWrite).toEqual([base.roundDir]);
      expect(fence.permissions.defaultMode).toBe("dontAsk");
      expect(fence.permissions.allow).toEqual(["Read", "Bash(seanced custodian *)"]);
      expect(fence.permissions.deny).toBe(DENY);
      expect(fence.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        enableWeakerNetworkIsolation: true,
      });
    }
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
