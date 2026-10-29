# OpenJet harness

The agent harness and terminal UI for [OpenJet](https://github.com/L-Forster/open-jet).
It runs Pi's `AgentSession` (from the Earendil Works Pi packages, pinned in
`package.json`) against OpenJet's local runtime, the llama.cpp server or the
Qwen3.8 megakernel server, or against a Codex or OpenRouter orchestrator. It
also talks to OpenJet's Python hardware service over newline-delimited JSON.

OpenJet includes this repository as a git submodule at `ui/`, and
`scripts/build_tui.py` in OpenJet builds the standalone executable that ships
in its wheels. See OpenJet's `docs/architecture/typescript-tui.md` for the
process boundary.

## Development

```bash
npm ci --legacy-peer-deps
npm run build
npm test
```

`npm run build` generates `src/protocol.generated.ts` from the service protocol
schema. Inside an OpenJet checkout it reads OpenJet's
`protocol/openjet-tui-v1.schema.json`. A standalone checkout falls back to the
copy in `protocol/`. `OPENJET_PROTOCOL_SCHEMA` overrides both.

`src/openrouter-models.generated.ts` is written by OpenJet's
`src/openrouter_catalog.py` during the OpenJet build.

## Local backend behaviour

`src/openjet-backend.test.ts` drives a full Pi session against a fake server
that streams like `megakernel/server/mk_server.py`, and checks the behaviour
OpenJet relies on:

- Qwen chat-template thinking: `enable_thinking` follows the thinking level, and
  `preserve_thinking` keeps the rendered prefix stable so the server's KV cache
  is reused across turns.
- Sampling: the thinking preset applies by default and the instruct preset at
  thinking level `off`, through `samplingParamsByThinkingLevel`.
- Images are never sent to the text-only local runtime.
- When the server rejects an oversized prompt, Pi compacts and retries.
- Compaction is sized to the model's context window, so small local windows do
  not compact every turn.
- Provider errors Pi cannot recover from are shown to the user.

## License

AGPL-3.0, same as OpenJet. The Pi packages are MIT licensed; see `NOTICE`.
