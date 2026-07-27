import { exec } from "./exec.ts";
import { log } from "./log.ts";

async function onACPower(): Promise<boolean> {
  const result = await exec(["pmset", "-g", "batt"], { timeoutMs: 5_000 });
  return result.exitCode === 0 && result.stdout.includes("AC Power");
}

/**
 * Holds `caffeinate -is` only while on AC power — desk machines stay
 * spawnable, laptop batteries don't get cooked. Battery machines sleep and
 * show offline; spawned sessions carry their own caffeinate regardless.
 * No-op off macOS.
 */
export function startPowerLoop(intervalMs = 60_000): () => void {
  if (process.platform !== "darwin") return (): void => {};

  let assertion: ReturnType<typeof Bun.spawn> | null = null;
  const tick = async (): Promise<void> => {
    const ac = await onACPower();
    if (ac && assertion === null) {
      assertion = Bun.spawn(["caffeinate", "-is"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      log.info("on AC power — holding sleep assertion");
    } else if (!ac && assertion !== null) {
      assertion.kill();
      assertion = null;
      log.info("on battery — released sleep assertion");
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return (): void => {
    clearInterval(timer);
    assertion?.kill();
    assertion = null;
  };
}
