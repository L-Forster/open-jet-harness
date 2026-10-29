import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenJetPiAgent, compactionTokensForWindow, type OpenJetPiModel, type PiUiEvent } from "./pi-agent.js";

// Replies are streamed the way megakernel/server/mk_server.py streams them:
// a role chunk, reasoning_content/content deltas, tool calls after generation,
// a finish chunk, then usage when stream_options.include_usage is set.
type Reply = {
  reasoning?: string;
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  error?: { status: number; body: unknown };
};

function streamReply(body: Record<string, unknown>, reply: Reply): string {
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "Qwen3.8-27B-Q4_K_M.gguf",
      choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  let out = chunk({ role: "assistant", content: null });
  if (reply.reasoning) out += chunk({ reasoning_content: reply.reasoning });
  if (reply.content) out += chunk({ content: reply.content });
  (reply.toolCalls ?? []).forEach((call, index) => {
    out += chunk({
      tool_calls: [{
        index,
        id: `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    });
  });
  out += chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop");
  if ((body.stream_options as Record<string, unknown> | undefined)?.include_usage) {
    out += chunk(null, null, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 90 } });
  }
  return `${out}data: [DONE]\n\n`;
}

function qwenModel(baseUrl: string, overrides: Partial<OpenJetPiModel> = {}): OpenJetPiModel {
  // Mirrors OpenJetServiceController._pi_model for the managed Qwen3.8 runtime.
  return {
    provider: "openjet-local",
    id: "Qwen3.8-27B-Q4_K_M.gguf",
    name: "Qwen3.8-27B-Q4_K_M.gguf",
    api: "openai-completions",
    apiKey: "openjet-local",
    baseUrl,
    reasoning: true,
    thinkingLevel: "medium",
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
    },
    samplingParams: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
    samplingParamsByThinkingLevel: {
      off: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
    },
    ...overrides,
  };
}

describe("OpenJet local backend through Pi", () => {
  let server: Server;
  let baseUrl: string;
  let workspace: string;
  let requests: Array<Record<string, unknown>>;
  let replies: Reply[];
  let agent: OpenJetPiAgent | undefined;
  let events: PiUiEvent[];

  beforeEach(async () => {
    requests = [];
    replies = [];
    events = [];
    workspace = await mkdtemp(join(tmpdir(), "openjet-harness-"));
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        requests.push(body);
        const reply = replies.shift() ?? { content: "done" };
        if (reply.error) {
          res.writeHead(reply.error.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(reply.error.body));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(streamReply(body, reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    agent?.dispose();
    agent = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  });

  async function startAgent(model: OpenJetPiModel): Promise<OpenJetPiAgent> {
    agent = new OpenJetPiAgent((event) => events.push(event), async () => ({ ok: true, output: "" }));
    await agent.initialize(model, workspace);
    return agent;
  }

  it("runs a thinking tool round with the Qwen thinking preset and replays reasoning", async () => {
    await writeFile(join(workspace, "notes.txt"), "megakernel ready\n");
    replies.push(
      { reasoning: "I should read the notes.", toolCalls: [{ name: "read", arguments: { path: "notes.txt" } }] },
      { reasoning: "The file says it is ready.", content: "The notes say the megakernel is ready." },
    );
    const session = await startAgent(qwenModel(baseUrl));
    await session.prompt("What do the notes say?");

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
    expect(first).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, stream: true, stream_options: { include_usage: true } });
    expect(typeof first.max_tokens).toBe("number");
    expect(first.max_completion_tokens).toBeUndefined();
    expect((first.messages as Array<Record<string, unknown>>)[0].role).toBe("system");
    expect((first.tools as Array<Record<string, unknown>>).some((tool) => (tool.function as Record<string, unknown>).name === "read")).toBe(true);

    const messages = second.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant")!;
    // preserve_thinking keeps the rendered prefix stable, so mk_server reuses its KV cache.
    expect(assistant.reasoning_content).toBe("I should read the notes.");
    expect((assistant.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_0", function: { name: "read" } });
    const tool = messages.find((message) => message.role === "tool")!;
    expect(tool).toMatchObject({ tool_call_id: "call_0" });
    expect(String(tool.content)).toContain("megakernel ready");

    expect(events.some((event) => event.type === "tool_end" && event.ok)).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.text.includes("megakernel is ready"))).toBe(true);
    expect(events.some((event) => event.type === "turn_complete")).toBe(true);
  });

  it("disables thinking and switches to the instruct preset at thinking level off", async () => {
    const session = await startAgent(qwenModel(baseUrl, { thinkingLevel: "off" }));
    await session.prompt("hi");

    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
    expect(requests[0]).toMatchObject({ temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 });
  });

  it("switches sampling with the thinking level without restarting the session", async () => {
    const session = await startAgent(qwenModel(baseUrl));
    await session.prompt("first");
    await session.switchModel(qwenModel(baseUrl, { thinkingLevel: "off" }));
    await session.prompt("second");

    expect(requests.map((body) => (body.chat_template_kwargs as Record<string, unknown>).enable_thinking)).toEqual([true, false]);
    expect(requests.map((body) => body.temperature)).toEqual([1.0, 0.7]);
  });

  it("never sends image parts to the text-only local runtime", async () => {
    const image = join(workspace, "shot.png");
    await writeFile(image, Buffer.from("89504e470d0a1a0a0000000d4948445200000004000000040802000000269309290000001049444154789c63f8cfc000470cc47100ae930ff1d05f239e0000000049454e44ae426082", "hex"));
    const session = await startAgent(qwenModel(baseUrl));
    await session.prompt("describe this", [image]);

    expect(JSON.stringify(requests[0].messages)).not.toContain("image_url");
  });
});

describe("OpenJet local backend errors", () => {
  async function runWithReplies(replies: Reply[], prompts: string[]): Promise<{ events: PiUiEvent[]; requests: Array<Record<string, unknown>> }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        requests.push(body);
        // Compaction summaries are tool-less requests; answer them out of band.
        const reply = body.tools ? replies.shift() ?? { content: "done" } : { content: "## Goal\nsummary of the earlier turns" };
        if (reply.error) {
          res.writeHead(reply.error.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(reply.error.body));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(streamReply(body, reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const workspace = await mkdtemp(join(tmpdir(), "openjet-harness-"));
    const events: PiUiEvent[] = [];
    const agent = new OpenJetPiAgent((event) => events.push(event), async () => ({ ok: true, output: "" }));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      await agent.initialize(qwenModel(baseUrl, { thinkingLevel: "off" }), workspace);
      for (const prompt of prompts) await agent.prompt(prompt);
    } finally {
      agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
    return { events, requests };
  }

  it("compacts and retries when mk_server reports the prompt does not fit", async () => {
    // ~6K tokens per answer, so a 32K window's 8K keep-recent tail leaves earlier turns to summarize.
    const long = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(900)}`;
    const { events, requests } = await runWithReplies([
      { content: long("one") },
      { content: long("two") },
      { content: long("three") },
      // megakernel/server/mk_server.py's BadRequest for an oversized prompt
      { error: { status: 400, body: { error: { message: "the request exceeds the available context size (40000 prompt tokens, context 32768)", type: "invalid_request_error" } } } },
      { content: "fourth answer" },
    ], ["q1", "q2", "q3", "q4"]);

    expect(events.some((event) => event.type === "compaction_start" && event.reason === "overflow")).toBe(true);
    expect(events.some((event) => event.type === "compaction_end" && event.ok && event.willRetry)).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.text === "fourth answer")).toBe(true);
    expect(events.some((event) => event.type === "notice" && event.level === "error")).toBe(false);
    expect(requests.filter((body) => !body.tools).length).toBeGreaterThan(0);
  });

  it("shows provider errors Pi could not recover from", async () => {
    const { events } = await runWithReplies([
      { error: { status: 400, body: { error: { message: "unsupported content part type 'input_audio' (text only)", type: "invalid_request_error" } } } },
    ], ["hi"]);

    const notice = events.find((event) => event.type === "notice" && event.level === "error");
    expect(notice).toMatchObject({ lane: "local" });
    expect(notice && "text" in notice ? notice.text : "").toContain("unsupported content part type");
  });
});

describe("compaction sizing", () => {
  it("keeps Pi defaults for large windows and scales down for small local windows", () => {
    expect(compactionTokensForWindow(272000)).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(compactionTokensForWindow(32768)).toEqual({ reserveTokens: 8192, keepRecentTokens: 8192 });
  });

  it("leaves room below the trigger after compacting", () => {
    for (const window of [8192, 16384, 32768, 65536, 100000, 262144]) {
      const { reserveTokens, keepRecentTokens } = compactionTokensForWindow(window);
      expect(keepRecentTokens).toBeLessThan(window - reserveTokens);
    }
  });
});
