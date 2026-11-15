// 各社の SDK を偽物に差し替えて、道具を使うループ (呼び出し → 実行 → 結果を返す → 返答) を確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolOutcome } from "../tools";

const script = vi.hoisted(() => ({
  claude: [] as unknown[],
  claudeRequests: [] as Record<string, unknown>[],
  openai: [] as unknown[],
  openaiRequests: [] as Record<string, unknown>[],
  gemini: [] as unknown[],
  geminiRequests: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (...a: unknown[]) => object };
  class FakeAnthropic extends actual.default {
    constructor(...args: unknown[]) {
      super(...args);
      Object.assign(this, {
        beta: {
          messages: {
            stream: (params: Record<string, unknown>) => {
              script.claudeRequests.push(structuredClone(params));
              const message = script.claude.shift() as { content: { type: string; text?: string }[] };
              return {
                on: (event: string, cb: (d: string) => void) => {
                  if (event === "text") for (const b of message.content) if (b.type === "text") cb(b.text!);
                },
                finalMessage: async () => message,
              };
            },
          },
        },
      });
    }
  }
  return { ...actual, default: FakeAnthropic };
});

vi.mock("openai", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (...a: unknown[]) => object };
  class FakeOpenAI extends actual.default {
    constructor(...args: unknown[]) {
      super(...args);
      Object.assign(this, {
        responses: {
          create: async (params: Record<string, unknown>) => {
            script.openaiRequests.push(structuredClone(params));
            return script.openai.shift();
          },
        },
      });
    }
  }
  return { ...actual, default: FakeOpenAI };
});

vi.mock("@google/genai", () => ({
  ApiError: class ApiError extends Error {
    status?: number;
  },
  GoogleGenAI: class {
    models = {
      generateContent: async (params: Record<string, unknown>) => {
        script.geminiRequests.push(structuredClone({ ...params, config: { ...(params.config as object), abortSignal: undefined } }));
        return script.gemini.shift();
      },
    };
  },
}));

const { createChatSession, createAnthropicClient, describeChatError } = await import("../chat");

const tools = [{ name: "add_element", description: "d", parameters: { type: "object", properties: {} } }];
const calls: [string, unknown][] = [];
const runTool = (name: string, input: unknown): ToolOutcome => {
  calls.push([name, input]);
  return { ok: true, content: JSON.stringify({ id: "act_1" }), changed: true };
};
const opts = (model: string) => ({ apiKey: "test", model, system: "sys", tools, runTool });

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(script) as (keyof typeof script)[]) script[k].length = 0;
});

describe("Claude", () => {
  it("道具を呼んで結果を返し、最後の返答を返す。Opus ではサーバー側のフォールバックを付ける", async () => {
    script.claude.push(
      { stop_reason: "tool_use", content: [{ type: "text", text: "足します。" }, { type: "tool_use", id: "tu_1", name: "add_element", input: { kind: "activity" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "足しました。" }] },
    );
    const s = createChatSession("claude", opts("claude-opus-5-5"));
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    const texts: string[] = [];
    const tooled: string[] = [];
    const reply = await s.send("作業を足して", { onText: (d) => texts.push(d), onTool: (n) => tooled.push(n) });
    expect(reply).toBe("足しました。");
    expect(texts).toEqual(["足します。", "足しました。"]);
    expect(calls).toEqual([["add_element", { kind: "activity" }]]);
    expect(tooled).toEqual(["add_element"]);
    const second = script.claudeRequests[1]!;
    // system は、キャッシュの印つきのブロックの配列で送る (文は変わらない)
    expect(second).toMatchObject({ model: "claude-opus-5-5", system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    const msgs = second.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(msgs[4]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: JSON.stringify({ id: "act_1" }), cache_control: { type: "ephemeral" } }]);
  });

  it("Haiku にはフォールバックを付けない。断られたらエラーにする", async () => {
    script.claude.push({ stop_reason: "refusal", content: [] });
    const s = createChatSession("claude", opts("claude-haiku-5-5"));
    await expect(s.send("x")).rejects.toThrow(/安全のための判定/);
    expect(script.claudeRequests[0]).not.toHaveProperty("fallbacks");
  });
});

describe("Codex (OpenAI)", () => {
  it("function_call を実行して function_call_output を返し、最後の文章を返す", async () => {
    script.openai.push(
      { output_text: "", output: [{ type: "function_call", call_id: "c1", name: "add_element", arguments: '{"kind":"usecase"}' }] },
      { output_text: "できました", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "できました" }] }], usage: { input_tokens: 1200, output_tokens: 30, input_tokens_details: { cached_tokens: 1000 } } },
    );
    const s = createChatSession("codex", opts("gpt-5-codex"));
    const usages: unknown[] = [];
    expect(await s.send("操作を足して", { onUsage: (u) => usages.push(u) })).toBe("できました");
    // 入力の合計 1200 のうちキャッシュから 1000 (OpenAI は自動でキャッシュする。使用量のない返答では通知しない)
    expect(usages).toEqual([{ input: 200, output: 30, cacheWrite: 0, cacheRead: 1000 }]);
    expect(calls).toEqual([["add_element", { kind: "usecase" }]]);
    const second = script.openaiRequests[1]! as { input: Record<string, unknown>[]; instructions: string; tools: Record<string, unknown>[] };
    expect(second.instructions).toBe("sys");
    expect(second.tools[0]).toMatchObject({ type: "function", name: "add_element" });
    expect(second.input.slice(-1)[0]).toEqual({ type: "function_call_output", call_id: "c1", output: JSON.stringify({ id: "act_1" }) });
  });

  it("引数が JSON でなければ、実行せずにエラーを返す", async () => {
    script.openai.push(
      { output_text: "", output: [{ type: "function_call", call_id: "c1", name: "add_element", arguments: "{oops" }] },
      { output_text: "やめます", output: [] },
    );
    const s = createChatSession("codex", opts("gpt-5-codex"));
    await s.send("x");
    expect(calls).toEqual([]);
  });
});

describe("Gemini", () => {
  it("functionCalls を実行して functionResponse を返し、最後の文章を返す", async () => {
    script.gemini.push(
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "f1", name: "add_element", args: { kind: "state" } } }] } }], functionCalls: [{ id: "f1", name: "add_element", args: { kind: "state" } }], text: "" },
      { candidates: [{ content: { role: "model", parts: [{ text: "足しました" }] } }], functionCalls: undefined, text: "足しました", usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 600, candidatesTokenCount: 20, thoughtsTokenCount: 5 } },
    );
    const s = createChatSession("gemini", opts("gemini-2.5-pro"));
    const usages: unknown[] = [];
    expect(await s.send("状態を足して", { onUsage: (u) => usages.push(u) })).toBe("足しました");
    expect(usages).toEqual([{ input: 300, output: 25, cacheWrite: 0, cacheRead: 600 }]);
    expect(calls).toEqual([["add_element", { kind: "state" }]]);
    const second = script.geminiRequests[1]! as { contents: { role: string; parts: Record<string, unknown>[] }[]; config: Record<string, unknown> };
    expect(second.config.systemInstruction).toBe("sys");
    expect(second.contents.slice(-1)[0]).toEqual({ role: "user", parts: [{ functionResponse: { id: "f1", name: "add_element", response: { output: { id: "act_1" } } } }] });
  });
});

describe("道具の結果が finish を示したとき: 次のリクエストを送らずに終える", () => {
  /** finish を返す道具 (submit) と、ふつうの道具 (read) */
  const finishing = (log: string[]) => (name: string): ToolOutcome => {
    log.push(name);
    return { ok: true, content: JSON.stringify({ result: name }), changed: false, ...(name === "submit" ? { finish: true } : {}) };
  };
  const finishTools = [{ name: "read", description: "d", parameters: { type: "object", properties: {} } }, { name: "submit", description: "d", parameters: { type: "object", properties: {} } }];

  it("Claude: 同じ往復のほかの道具もすべて実行し、結果を履歴に積んで終える。そのあと同じ会話に send しても、呼び出しと結果は対のまま", async () => {
    script.claude.push(
      { stop_reason: "tool_use", content: [{ type: "text", text: "出します" }, { type: "tool_use", id: "tu_a", name: "submit", input: {} }, { type: "tool_use", id: "tu_b", name: "read", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "次の答え" }] },
    );
    const log: string[] = [];
    const s = createChatSession("claude", { ...opts("claude-opus-5-5"), tools: finishTools, runTool: finishing(log) });
    expect(await s.send("提出して")).toBe("出します");
    // リクエストは 1 回だけ。提出と同じ往復の read も実行している
    expect(script.claudeRequests).toHaveLength(1);
    expect(log).toEqual(["submit", "read"]);
    expect(await s.send("続けて")).toBe("次の答え");
    const msgs = script.claudeRequests[1]!.messages as { role: string; content: { type: string; tool_use_id?: string; text?: string }[] }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // 呼び出し (tu_a・tu_b) に、結果が対で付いている。そのあとの発言は、同じ user のメッセージの末尾
    expect(msgs[2]!.content.map((b) => (b.type === "tool_result" ? b.tool_use_id : b.text))).toEqual(["tu_a", "tu_b", "続けて"]);
  });

  it("Claude: finish が無ければ今までどおり、結果を返して次のリクエストを送る", async () => {
    script.claude.push({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_a", name: "read", input: {} }] }, { stop_reason: "end_turn", content: [{ type: "text", text: "答え" }] });
    const log: string[] = [];
    const s = createChatSession("claude", { ...opts("claude-opus-5-5"), tools: finishTools, runTool: finishing(log) });
    expect(await s.send("読んで")).toBe("答え");
    expect(script.claudeRequests).toHaveLength(2);
  });

  it("Codex (OpenAI): 次のリクエストを送らず、呼び出しと結果は履歴に対で残る", async () => {
    script.openai.push(
      { output_text: "出します", output: [{ type: "function_call", call_id: "c1", name: "submit", arguments: "{}" }, { type: "function_call", call_id: "c2", name: "read", arguments: "{}" }] },
      { output_text: "次の答え", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "次の答え" }] }] },
    );
    const log: string[] = [];
    const s = createChatSession("codex", { ...opts("gpt-5-codex"), tools: finishTools, runTool: finishing(log) });
    expect(await s.send("提出して")).toBe("出します");
    expect(script.openaiRequests).toHaveLength(1);
    expect(log).toEqual(["submit", "read"]);
    await s.send("続けて");
    const input = (script.openaiRequests[1] as { input: { type?: string; call_id?: string }[] }).input;
    expect(input.filter((x) => x.type === "function_call").map((x) => x.call_id)).toEqual(["c1", "c2"]);
    expect(input.filter((x) => x.type === "function_call_output").map((x) => x.call_id)).toEqual(["c1", "c2"]);
  });

  it("Gemini: 次のリクエストを送らず、呼び出しと結果は履歴に対で残る (続きの発言は、結果と同じ user の末尾)", async () => {
    script.gemini.push(
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "f1", name: "submit", args: {} } }, { functionCall: { id: "f2", name: "read", args: {} } }] } }], functionCalls: [{ id: "f1", name: "submit", args: {} }, { id: "f2", name: "read", args: {} }], text: "出します" },
      { candidates: [{ content: { role: "model", parts: [{ text: "次の答え" }] } }], functionCalls: undefined, text: "次の答え" },
    );
    const log: string[] = [];
    const s = createChatSession("gemini", { ...opts("gemini-2.5-pro"), tools: finishTools, runTool: finishing(log) });
    expect(await s.send("提出して")).toBe("出します");
    expect(script.geminiRequests).toHaveLength(1);
    expect(log).toEqual(["submit", "read"]);
    await s.send("続けて");
    const contents = (script.geminiRequests[1] as { contents: { role: string; parts: Record<string, unknown>[] }[] }).contents;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[2]!.parts.map((p) => (p.functionResponse ? (p.functionResponse as { id: string }).id : p.text))).toEqual(["f1", "f2", "続けて"]);
  });
});

describe("発言の部分 (RequestPart)", () => {
  it("OpenAI・Gemini は、部分をつないだ 1 つの文字列で送る", async () => {
    script.openai.push({ output_text: "ok", output: [] });
    script.gemini.push({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], functionCalls: undefined, text: "ok" });
    const parts = [{ text: "共通。", shared: true }, { text: "固有。" }];
    await createChatSession("codex", opts("gpt-5-codex")).send(parts);
    await createChatSession("gemini", opts("gemini-2.5-pro")).send(parts);
    expect((script.openaiRequests[0] as { input: unknown[] }).input).toEqual([{ role: "user", content: "共通。固有。" }]);
    expect((script.geminiRequests[0] as { contents: unknown[] }).contents).toEqual([{ role: "user", parts: [{ text: "共通。固有。" }] }]);
  });
});

describe("Anthropic のクライアント", () => {
  it("キーを x-api-key で送り、Authorization (Bearer) は付けない", async () => {
    let sent: Headers | undefined;
    const client = createAnthropicClient("sk-ant-test").withOptions({
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await client.models.list();
    expect(sent?.get("x-api-key")).toBe("sk-ant-test");
    expect(sent?.has("authorization")).toBe(false);
  });
});

describe("describeChatError", () => {
  it("中断は、どのプロバイダーでも「中断しました。」", async () => {
    const anthropic = (await import("@anthropic-ai/sdk")).default;
    const openai = (await import("openai")).default;
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    expect(describeChatError(new anthropic.APIUserAbortError())).toBe("中断しました。");
    expect(describeChatError(new openai.APIUserAbortError())).toBe("中断しました。");
    expect(describeChatError(abort)).toBe("中断しました。");
    expect(describeChatError(new Error("boom"))).toBe("boom");
  });
});
