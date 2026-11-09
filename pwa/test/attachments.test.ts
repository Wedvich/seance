import { ATTACHMENT_LIMITS, parseAttachmentManifest } from "@seance/shared";
import { describe, expect, test } from "bun:test";
import { admitFiles, attachmentName, attachmentType, manifestOf, uploadRefusalText } from "../src/attachments.ts";

const MB = 1024 * 1024;

/** A `File` that reports `size` without holding it: only the limits read it here. */
function sized(name: string, size: number, type = ""): File {
  const file = new File([], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

let keys = 0;
const mintKey = (): string => `k${(keys += 1)}`;

describe("attachmentType", () => {
  test("lowercases and drops parameters, falling back to octet-stream for anything the manifest refuses", () => {
    expect(attachmentType("Image/PNG")).toBe("image/png");
    expect(attachmentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(attachmentType("")).toBe("application/octet-stream");
    expect(attachmentType("not a type")).toBe("application/octet-stream");
    expect(attachmentType(`application/${"x".repeat(ATTACHMENT_LIMITS.type)}`)).toBe("application/octet-stream");
  });
});

describe("attachmentName", () => {
  test("keeps a name that fits, and replaces what would break the seed's line", () => {
    expect(attachmentName("Screenshot 2026-10-28.png")).toBe("Screenshot 2026-10-28.png");
    expect(attachmentName("a\nb c.txt")).toBe("a_b_c.txt");
    expect(attachmentName("   ")).toBe("file");
  });

  test("cuts a long name in the stem, keeping the extension and every surrogate pair whole", () => {
    const long = `${"😀".repeat(80)}.png`;
    const cut = attachmentName(long);
    expect(cut.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.name);
    expect(cut.endsWith(".png")).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    // No dot near the end: the whole name is the stem.
    expect(attachmentName("x".repeat(300)).length).toBe(ATTACHMENT_LIMITS.name);
  });
});

describe("admitFiles", () => {
  test("adds what fits and names each file it left out and why", () => {
    const { files, notice } = admitFiles(
      [],
      [sized("big.mov", 31 * MB), sized("a.png", 1 * MB, "image/png"), sized("b.txt", 2)],
      mintKey,
    );
    expect(files.map((f) => f.name)).toEqual(["a.png", "b.txt"]);
    expect(files[0]?.type).toBe("image/png");
    expect(notice).toBe("Not attached: big.mov is 31 MB; a file can be at most 30 MB.");
  });

  test("stops at the count bound and skips a file past the total, still trying smaller ones", () => {
    const nine = Array.from({ length: 9 }, (_, i) => sized(`f${i}`, 10 * MB));
    const { files, notice } = admitFiles(
      [],
      [...nine, sized("too-much", 20 * MB), sized("small", 1), sized("over-count", 1)],
      mintKey,
    );
    expect(files.map((f) => f.name)).toEqual([...nine.map((f) => f.name), "small"]);
    expect(files.reduce((sum, f) => sum + f.size, 0)).toBeLessThanOrEqual(ATTACHMENT_LIMITS.totalBytes);
    expect(notice).toBe(
      "Not attached: too-much would take the task past 100 MB in all; a task takes at most 10 files.",
    );
  });

  test("counts files already on the form", () => {
    const first = admitFiles([], [sized("a", 25 * MB)], mintKey);
    const { files, notice } = admitFiles(
      first.files,
      [sized("b", 25 * MB), sized("c", 25 * MB), sized("d", 25 * MB), sized("e", 25 * MB)],
      mintKey,
    );
    expect(files.map((f) => f.name)).toEqual(["a", "b", "c", "d"]);
    expect(notice).toContain("e would take the task past 100 MB");
  });
});

describe("manifestOf", () => {
  test("is null until every file is stored, and then a manifest the leader's parser accepts", () => {
    const { files } = admitFiles([], [sized("a.png", 3, "image/png"), sized("b", 0)], mintKey);
    expect(manifestOf(files)).toBeNull();
    const stored = files.map(({ key, file, name, type, size }, i) => ({
      key,
      file,
      name,
      type,
      size,
      stored: { id: `0000000${i}-0000-4000-8000-000000000000`, hash: "h".repeat(43) },
    }));
    const manifest = manifestOf(stored);
    expect(manifest).not.toBeNull();
    expect(parseAttachmentManifest(manifest)).toEqual(manifest);
  });
});

describe("uploadRefusalText", () => {
  test("names the allowance window and the wait, and always says nothing was queued", () => {
    const text = uploadRefusalText("a.png", {
      ok: false,
      code: "allowance_exhausted",
      window: "hour",
      retryAfter: 600,
    });
    expect(text).toContain("hourly allowance");
    expect(text).toContain("10 minutes");
    expect(text).toContain("Nothing was queued");
    expect(uploadRefusalText("a.png", { ok: false, code: "unreachable" })).toContain("Couldn't reach the relay");
  });
});
