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
  GoogleGenAI: class {
    models = {
      generateContent: async (params: Record<string, unknown>) => {
        script.geminiRequests.push(structuredClone({ ...params, config: { ...(params.config as object), abortSignal: undefined } }));
        return script.gemini.shift();
      },
    };
  },
}));

const { createChatSession } = await import("../chat");

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
    expect(second).toMatchObject({ model: "claude-opus-5-5", system: "sys", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    const msgs = second.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(msgs[4]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: JSON.stringify({ id: "act_1" }) }]);
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
      { output_text: "できました", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "できました" }] }] },
    );
    const s = createChatSession("codex", opts("gpt-5-codex"));
    expect(await s.send("操作を足して")).toBe("できました");
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
      { candidates: [{ content: { role: "model", parts: [{ text: "足しました" }] } }], functionCalls: undefined, text: "足しました" },
    );
    const s = createChatSession("gemini", opts("gemini-2.5-pro"));
    expect(await s.send("状態を足して")).toBe("足しました");
    expect(calls).toEqual([["add_element", { kind: "state" }]]);
    const second = script.geminiRequests[1]! as { contents: { role: string; parts: Record<string, unknown>[] }[]; config: Record<string, unknown> };
    expect(second.config.systemInstruction).toBe("sys");
    expect(second.contents.slice(-1)[0]).toEqual({ role: "user", parts: [{ functionResponse: { id: "f1", name: "add_element", response: { output: { id: "act_1" } } } }] });
  });
});
