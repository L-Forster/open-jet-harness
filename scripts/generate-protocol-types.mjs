import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Inside an OpenJet checkout (harness mounted at ui/) the backend's schema is
// authoritative; standalone checkouts use the vendored copy.
const schemaPath = [
  process.env.OPENJET_PROTOCOL_SCHEMA,
  resolve(here, "../../protocol/openjet-tui-v1.schema.json"),
  resolve(here, "../protocol/openjet-tui-v1.schema.json"),
].find((path) => path && existsSync(path));
if (!schemaPath) throw new Error("openjet-tui-v1.schema.json not found; set OPENJET_PROTOCOL_SCHEMA");
const outputPath = resolve(here, "../src/protocol.generated.ts");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const names = schema.properties.type.enum.map((value) => JSON.stringify(value));
const requestNames = new Set(schema["x-requestTypes"]);
const requests = schema["x-requestTypes"].map((value) => JSON.stringify(value)).join(" | ");
const events = schema.properties.type.enum.filter((value) => !requestNames.has(value)).map((value) => JSON.stringify(value)).join(" | ");

writeFileSync(
  outputPath,
  "// Generated from protocol/openjet-tui-v1.schema.json. Do not edit.\n" +
    `export const PROTOCOL_VERSION = ${schema.properties.protocolVersion.const} as const;\n` +
    `export type RequestType = ${requests};\n` +
    `export type EventType = ${events};\n`,
  "utf8",
);
