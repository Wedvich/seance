/**
 * The custodian round's agent definition and seed (docs/custodian.md, "The command"). The definition is a markdown
 * file in the repo (`daemon/custodian/agent.md`: frontmatter and a prompt body) that the daemon turns into the
 * `--agents` JSON on argv: `--agents <file>` is read only with `--print`, and `--add-dir` would widen the sandbox's
 * write scope. Nothing here reads a pane, and nothing it returns is ever logged.
 */

/** C37: the notes file the seed carries is at most this many bytes. */
export const NOTES_MAX = 8_192;

/** The seed's constant: what the round is asked to do, before any notes. */
export const ROUND_SEED = "Run your round now.";

/** The seed: the constant, plus the notes from earlier rounds when there are any. */
export function roundSeed(notes: string | null): string {
  if (notes === null || notes.trim() === "") return ROUND_SEED;
  return `${ROUND_SEED}\n\nNotes from earlier rounds:\n${notes}`;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const KEYS = ["name", "description", "tools"];
const AGENT_NAME = "custodian";

/**
 * C20 rules out Edit, Write, web and MCP tools: the definition names exactly these, and an agent file that asks for
 * more is refused rather than launched. Whether `--agents` takes `tools` as an array is Claude Code's behaviour,
 * re-checked by the dev check.
 */
const TOOLS = ["Bash", "Read"];

/** Parses the agent file's text into the `--agents` JSON string; throws on anything it does not expect. */
export function parseAgent(text: string): string {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw new TypeError("custodian agent: missing frontmatter");
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    const key = colon < 0 ? "" : line.slice(0, colon).trim();
    if (!KEYS.includes(key)) throw new TypeError(`custodian agent: unexpected frontmatter line "${key || line}"`);
    if (fields.has(key)) throw new TypeError(`custodian agent: "${key}" twice`);
    fields.set(key, line.slice(colon + 1).trim());
  }
  for (const key of KEYS) if (!fields.has(key)) throw new TypeError(`custodian agent: "${key}" is missing`);
  if (fields.get("name") !== AGENT_NAME) throw new TypeError(`custodian agent: name must be ${AGENT_NAME}`);
  const tools = (fields.get("tools") ?? "").split(",").map((tool) => tool.trim());
  if (tools.length !== TOOLS.length || tools.some((tool, at) => tool !== TOOLS[at])) {
    throw new TypeError(`custodian agent: tools must be exactly ${TOOLS.join(", ")}`);
  }
  const prompt = (match[2] ?? "").trim();
  if (prompt === "") throw new TypeError("custodian agent: the prompt is empty");
  return JSON.stringify({ [AGENT_NAME]: { description: fields.get("description"), prompt, tools: TOOLS } });
}

/** Reads the repo's agent file (or `path`, for tests) and returns the `--agents` JSON string. */
export async function loadAgent(
  path: string | URL = new URL("../custodian/agent.md", import.meta.url),
): Promise<string> {
  return parseAgent(await Bun.file(path).text());
}
