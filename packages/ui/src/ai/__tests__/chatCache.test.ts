// Claude の会話のプロンプトキャッシュ: 本物の SDK に偽の fetch を渡して、実際に送るリクエストの本文 (印の位置・数) と、使用量の通知を確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatSession, MAX_CACHE_BREAKPOINTS, planCacheMarks, totalInputTokens, type ChatUsage } from "../chat";
import type { ToolOutcome } from "../tools";

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; cache_control?: unknown; tool_use_id?: string };
interface Sent {
  headers: Headers;
  body: { model: string; system?: { type: string; text: string; cache_control?: unknown }[] | string; tools?: { name: string; cache_control?: unknown }[]; messages: { role: string; content: string | Block[] }[]; fallbacks?: string; betas?: string[] };
}
interface Reply {
  content: Block[];
  stop: "end_turn" | "tool_use";
  usage?: { input: number; output: number; write?: number; read?: number };
}

const sent: Sent[] = [];
const replies: Reply[] = [];

/** SDK のストリーミングが読める SSE にする */
function sse(reply: Reply): string {
  const u = reply.usage ?? { input: 10, output: 5 };
  const usage = { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.write ?? 0, cache_read_input_tokens: u.read ?? 0 };
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage } });
  reply.content.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: reply.stop, stop_sequence: null }, usage });
  out += ev("message_stop", {});
  return out;
}

beforeEach(() => {
  sent.length = 0;
  replies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(sse(replies.shift()!), { status: 200, headers: { "content-type": "text/event-stream" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const tools = [
  { name: "read_file", description: "読む", parameters: { type: "object", properties: {} } },
  { name: "submit", description: "出す", parameters: { type: "object", properties: {} } },
];
const runTool = (): ToolOutcome => ({ ok: true, content: JSON.stringify({ ok: true }), changed: false });
const make = (over: Partial<Parameters<typeof createChatSession>[1]> = {}) => createChatSession("claude", { apiKey: "sk-test", model: "claude-opus-5-5", system: "指示", tools, runTool, ...over });

/** リクエストの中の、印の付いた場所の一覧 (tools・system・メッセージの番号とブロックの番号) */
function marksOf(s: Sent): string[] {
  const out: string[] = [];
  s.body.tools?.forEach((t, i) => t.cache_control && out.push(`tools[${i}]`));
  if (Array.isArray(s.body.system)) s.body.system.forEach((b, i) => b.cache_control && out.push(`system[${i}]`));
  s.body.messages.forEach((m, mi) => {
    if (typeof m.content === "string") return;
    m.content.forEach((b, bi) => b.cache_control && out.push(`messages[${mi}][${bi}]`));
  });
  return out;
}
const toolCall = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `tu_${i}`, name: "read_file", input: { path: `f${i}` } }));

describe("Claude: プロンプトキャッシュの印", () => {
  it("引き継いだ履歴のある会話: 道具の最後・system・引き継いだ履歴の最後・いちばん新しいメッセージに印を置く (4 つ)", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    const s = make();
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    await s.send("今の依頼");
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "system[0]", "messages[1][0]", "messages[2][0]"]);
    // system はブロックの配列で、文は変わらない
    expect(sent[0]!.body.system).toEqual([{ type: "text", text: "指示", cache_control: { type: "ephemeral" } }]);
    // 印を付けても、文は変わらない
    expect(sent[0]!.body.messages.map((m) => (Array.isArray(m.content) ? m.content[0]!.text : m.content))).toEqual(["前の依頼", "前の返答", "今の依頼"]);
  });

  it("往復のたびに、いちばん新しいメッセージへ置き直す。古い印は外れ、数は上限を超えない", async () => {
    replies.push({ content: [{ type: "text", text: "読みます" }, ...toolCall(1)], stop: "tool_use" }, { content: [...toolCall(1)], stop: "tool_use" }, { content: [{ type: "text", text: "終わり" }], stop: "end_turn" });
    const s = make();
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    await s.send("今の依頼");
    expect(sent).toHaveLength(3);
    // 2 回目: 新しいメッセージ = 道具の結果。1 回目の印 (今の依頼) は外れている
    expect(marksOf(sent[1]!)).toEqual(["tools[1]", "system[0]", "messages[1][0]", "messages[4][0]"]);
    expect(sent[1]!.body.messages[4]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_0", content: JSON.stringify({ ok: true }), cache_control: { type: "ephemeral" } }]);
    expect(marksOf(sent[2]!)).toEqual(["tools[1]", "system[0]", "messages[1][0]", "messages[6][0]"]);
    for (const x of sent) expect(marksOf(x).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it("seed なしの会話: 道具・system・いちばん新しいメッセージの 3 つ", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make().send("依頼");
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "system[0]", "messages[0][0]"]);
  });

  it("道具なしの会話: 道具の印も tools も付けず、system とメッセージだけ", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make({ tools: [] }).send("依頼");
    expect(marksOf(sent[0]!)).toEqual(["system[0]", "messages[0][0]"]);
  });

  it("system が空の会話: system は送らず (空のブロックは断られる)、道具とメッセージだけ", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make({ system: "" }).send("依頼");
    expect(sent[0]!.body).not.toHaveProperty("system");
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "messages[0][0]"]);
  });

  it("1 つの往復で道具を何件も呼んで 20 ブロック近く増えたときは、新しい返答の末尾にも印を置く (道具の印は外して、上限の 4 つのまま)", async () => {
    replies.push({ content: [...toolCall(11)], stop: "tool_use" }, { content: [...toolCall(1)], stop: "tool_use" }, { content: [{ type: "text", text: "終わり" }], stop: "end_turn" });
    const s = make();
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    await s.send("今の依頼");
    // 2 回目 (1 回目の印から 11 + 11 ブロック増えた): 道具の印は外れ、返答の末尾 (messages[3]) の印が増える
    expect(marksOf(sent[1]!)).toEqual(["system[0]", "messages[1][0]", "messages[3][10]", "messages[4][10]"]);
    // 3 回目 (1 + 1 ブロックだけ増えた): ふつうの 4 つに戻る
    expect(marksOf(sent[2]!)).toEqual(["tools[1]", "system[0]", "messages[1][0]", "messages[6][0]"]);
    for (const x of sent) expect(marksOf(x).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it("同じセッションの 2 回目の send でも、新しい依頼へ置き直す (前の send の印は残らない)", async () => {
    replies.push({ content: [{ type: "text", text: "1" }], stop: "end_turn" }, { content: [{ type: "text", text: "2" }], stop: "end_turn" });
    const s = make();
    await s.send("一つ目");
    await s.send("二つ目");
    expect(marksOf(sent[1]!)).toEqual(["tools[1]", "system[0]", "messages[2][0]"]);
  });

  it("ヘッダー (x-api-key・Authorization なし)・Opus のフォールバック・Haiku でのフォールバックなしは今までどおり", async () => {
    replies.push({ content: [{ type: "text", text: "a" }], stop: "end_turn" }, { content: [{ type: "text", text: "b" }], stop: "end_turn" });
    await make().send("x");
    await make({ model: "claude-haiku-5-5" }).send("x");
    expect(sent[0]!.headers.get("x-api-key")).toBe("sk-test");
    expect(sent[0]!.headers.has("authorization")).toBe(false);
    expect(sent[0]!.body).toMatchObject({ fallbacks: "default" });
    expect(sent[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(sent[1]!.body).not.toHaveProperty("fallbacks");
    expect(sent[1]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    // 印の付け方は、フォールバックの有無に関わらない
    expect(marksOf(sent[1]!)).toEqual(marksOf(sent[0]!));
  });

  it("使用量: リクエストごとに onUsage で、入力・出力・キャッシュの書き込み・読み取りを通知する", async () => {
    replies.push(
      { content: [...toolCall(1)], stop: "tool_use", usage: { input: 100, output: 20, write: 5000, read: 0 } },
      { content: [{ type: "text", text: "終わり" }], stop: "end_turn", usage: { input: 30, output: 7, write: 400, read: 5000 } },
    );
    const got: ChatUsage[] = [];
    await make().send("依頼", { onUsage: (u) => got.push(u) });
    expect(got).toEqual([
      { input: 100, output: 20, cacheWrite: 5000, cacheRead: 0 },
      { input: 30, output: 7, cacheWrite: 400, cacheRead: 5000 },
    ]);
    expect(got.map(totalInputTokens)).toEqual([5100, 5430]);
  });

  it("onUsage を渡さなくても動く", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await expect(make().send("依頼")).resolves.toBe("答え");
  });
});

describe("planCacheMarks: 印の割り当て", () => {
  const msg = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: "x" }));
  it("上限の 4 つを超えない (system があれば道具の印から外す。system が無ければ、新しいものを残して古いものから外す)", () => {
    const all = planCacheMarks({ messages: [...msg(2), { role: "assistant", content: Array.from({ length: 12 }, () => ({ type: "text" as const, text: "a" })) }, { role: "user", content: Array.from({ length: 12 }, () => ({ type: "text" as const, text: "a" })) }], seedCount: 2, previousTail: 1, hasTools: true, hasSystem: true });
    expect(all).toEqual({ messages: [3, 1, 2], tools: false });
    const noSystem = planCacheMarks({ messages: [...msg(2), { role: "assistant", content: Array.from({ length: 12 }, () => ({ type: "text" as const, text: "a" })) }, { role: "user", content: Array.from({ length: 12 }, () => ({ type: "text" as const, text: "a" })) }], seedCount: 2, previousTail: 1, hasTools: true, hasSystem: false });
    expect(noSystem).toEqual({ messages: [3, 1, 2], tools: true });
  });
  it("履歴が空でも壊れない", () => {
    expect(planCacheMarks({ messages: [], seedCount: 0, previousTail: -1, hasTools: false, hasSystem: false })).toEqual({ messages: [], tools: false });
  });
});
