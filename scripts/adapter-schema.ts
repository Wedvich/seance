import { join } from "node:path";
import { adapterProtocolSchemaText } from "../shared/src/adapter-protocol.ts";

// Regenerates the committed JSON Schema from its record, `shared/src/adapter-protocol.ts`.
const path = join(import.meta.dir, "..", "shared", "src", "adapter-protocol.schema.json");
await Bun.write(path, adapterProtocolSchemaText());
console.log(`wrote ${path}`);
