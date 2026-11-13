// The tool this mod registers (`$.tool.register`), declared by hand: the kit lays its MCP
// entry only from servers connected at a save, so a hook matching on this name would
// otherwise not type-check on a machine where the mod has not been loaded yet. `{}` is the shape the kit writes
// for a tool with no arguments, so the entry it adds on a machine that has loaded the mod merges without a conflict.
// oxlint-disable-next-line unicorn/require-module-specifiers -- makes this a module, so the block below augments
export {};
declare module "claude-code" {
  interface McpToolInputs {
    // oxlint-disable-next-line typescript/ban-types -- the kit's own shape for a tool with no arguments
    mcp__inbox__read_messages: {};
  }
}
