import { describe, expect, test } from "bun:test";
import { EFFORT_LABELS, EFFORTS, FALLBACK_EFFORT, FALLBACK_MODEL, MODEL_LABELS, MODELS } from "./options.ts";
import {
  EFFORT_LABELS as PWA_EFFORT_LABELS,
  EFFORTS as PWA_EFFORTS,
  MODEL_LABELS as PWA_MODEL_LABELS,
  MODELS as PWA_MODELS,
} from "../../../pwa/src/state.ts";

/**
 * The offered lists exist in three places that cannot be one — this module, the
 * PWA's `state.ts` (a different runtime, and neither package depends on the
 * other), and the `preferences[].data` arrays in package.json, because Raycast
 * reads a static manifest and a manifest cannot import. Running under Bun, these
 * tests can reach all three, so the duplication drifts loudly instead of
 * silently offering a model on one surface and not the other.
 */

interface ManifestPreference {
  readonly name: string;
  readonly default?: unknown;
  readonly data?: readonly { readonly title: string; readonly value: string }[];
}

const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  readonly preferences: readonly ManifestPreference[];
};

function preference(name: string): ManifestPreference {
  const found = manifest.preferences.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no ${name} preference in the manifest`);
  return found;
}

describe("drift guard: the PWA offers the same options", () => {
  test("models", () => {
    expect([...MODELS]).toEqual([...PWA_MODELS]);
  });

  test("efforts", () => {
    expect([...EFFORTS]).toEqual([...PWA_EFFORTS]);
  });

  test("model labels", () => {
    expect(MODEL_LABELS).toEqual(PWA_MODEL_LABELS);
  });

  test("effort labels", () => {
    expect(EFFORT_LABELS).toEqual(PWA_EFFORT_LABELS);
  });
});

describe("drift guard: the manifest offers the same options", () => {
  test("the model dropdown lists exactly the offered models, with their labels", () => {
    expect(preference("defaultModel").data).toEqual(
      MODELS.map((model) => ({ title: MODEL_LABELS[model], value: model })),
    );
  });

  test("the effort dropdown lists exactly the offered efforts, with their labels", () => {
    expect(preference("defaultEffort").data).toEqual(
      EFFORTS.map((effort) => ({ title: EFFORT_LABELS[effort], value: effort })),
    );
  });

  test("the manifest defaults are the wire defaults", () => {
    expect(preference("defaultModel").default).toBe(FALLBACK_MODEL);
    expect(preference("defaultEffort").default).toBe(FALLBACK_EFFORT);
  });

  test("no preference collects a secret — credentials come from the daemon's own stores", () => {
    for (const entry of manifest.preferences) {
      expect(entry).not.toHaveProperty("type", "password");
      expect(entry.name).not.toMatch(/psk|token|secret/iu);
    }
  });
});
