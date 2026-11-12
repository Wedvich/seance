import { describe, expect, test } from "bun:test";
import { requireRoot } from "../../daemon/src/target-user.ts";
import { checkoutRefusal, daemonUserRefusal, SUDO_ARCHIVIST } from "./install.ts";

const SEANCED_UNIT = '[Service]\nUser=martin\nExecStart="/usr/bin/bun" "/home/martin/seance/daemon/src/main.ts"\n';

describe("install --system refusals", () => {
  test("the user a seanced system unit runs as is refused", () => {
    expect(daemonUserRefusal("martin", SEANCED_UNIT, false)).toMatch(/seanced\.service runs seanced as .*A27a/u);
  });

  test("a user with a seanced user unit is refused", () => {
    expect(daemonUserRefusal("martin", null, true)).toMatch(/seanced user unit/u);
  });

  test("a user of its own passes, beside a daemon or on a box with none", () => {
    expect(daemonUserRefusal("archivist", SEANCED_UNIT, false)).toBeNull();
    expect(daemonUserRefusal("archivist", null, false)).toBeNull();
  });

  test("a checkout the archivist's user does not own is refused", () => {
    const user = { name: "archivist", uid: 1001 };
    expect(checkoutRefusal("/home/martin/seance", 1000, user)).toMatch(/not archivist's \(owner uid 1000\)/u);
    expect(checkoutRefusal("/home/archivist/seance", 1001, user)).toBeNull();
  });

  test("not root names the archivist's own sudo form", () => {
    expect(SUDO_ARCHIVIST).toMatch(/^sudo --preserve-env=PATH "\$\(command -v bun\)" ".*\/archivist\/src\/main\.ts"$/u);
    expect(() => requireRoot(1000, "install --system", SUDO_ARCHIVIST)).toThrow(
      `\`${SUDO_ARCHIVIST} install --system\``,
    );
  });
});
