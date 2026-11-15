// Claude の会話のプロンプトキャッシュ: 本物の SDK に偽の fetch を渡して、実際に送るリクエストの本文 (印の位置・数) と、使用量の通知を確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatSession, MAX_CACHE_BREAKPOINTS, planCacheMarks, totalInputTokens, type ChatUsage, type RequestPart } from "../chat";
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
  it("引き継いだ履歴のある会話: 道具の最後・system・引き継いだ履歴の最後・いちばん新しいメッセージに印を置く (4 つ。道具の印は、空きがあるときだけ)", async () => {
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

  it("system が空の会話: system は送らず (空のブロックは断られる)、道具の印とメッセージだけ", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make({ system: "" }).send("依頼");
    expect(sent[0]!.body).not.toHaveProperty("system");
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "messages[0][0]"]);
  });

  it("system が空白だけの会話も、送らず、印も付けない (空白だけの text ブロックは断られる)", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make({ system: " \n\t " }).send("依頼");
    expect(sent[0]!.body).not.toHaveProperty("system");
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "messages[0][0]"]);
  });

  it("1 つの往復で道具を 11 件呼んで 20 ブロック近く増えたときは、前の印から 18 ブロック以内に中間の印を置く (上限の 4 つのまま)", async () => {
    replies.push({ content: [...toolCall(11)], stop: "tool_use" }, { content: [...toolCall(1)], stop: "tool_use" }, { content: [{ type: "text", text: "終わり" }], stop: "end_turn" });
    const s = make();
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    await s.send("今の依頼");
    // 2 回目: 1 回目の最後の印 (messages[2]) から、返答 11 + 結果 11 ブロック増えた (22 > 18)。前の印から 18 ブロック目 (結果の 7 番目) に中間の印を置く。
    // 引き継いだ履歴の最後の印は、空きがあるので残る。道具の定義の印は、空きが無いので外れる (system の印が覆う)
    expect(marksOf(sent[1]!)).toEqual(["system[0]", "messages[1][0]", "messages[4][6]", "messages[4][10]"]);
    // 3 回目 (1 + 1 ブロックだけ増えた): 中間の印は要らないので、道具の印も付く
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

describe("Claude: 発言を部分に分けて送る", () => {
  it("部分は別々の text ブロックになり、共通の部分 (shared) の終わりに印を置く。文は変わらない", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    const s = make();
    s.seed([{ role: "user", text: "前の依頼" }, { role: "assistant", text: "前の返答" }]);
    const parts: RequestPart[] = [{ text: "共通の決まり。", shared: true }, { text: "この画面だけ。" }];
    await s.send(parts);
    const last = sent[0]!.body.messages[2]!.content as Block[];
    expect(last.map((b) => b.text)).toEqual(["共通の決まり。", "この画面だけ。"]);
    // 印: system・seed の最後・共通の部分の終わり・いちばん新しいメッセージの最後 (4 つ。道具の印は、空きが無いので付けない)
    expect(marksOf(sent[0]!)).toEqual(["system[0]", "messages[1][0]", "messages[2][0]", "messages[2][1]"]);
  });

  it("空の部分は送らない (空の text ブロックは断られる)。共通の部分の番号は、空の部分を除いたあとの位置", async () => {
    replies.push({ content: [{ type: "text", text: "答え" }], stop: "end_turn" });
    await make().send([{ text: "" }, { text: "共通", shared: true }, { text: "  " }, { text: "固有" }]);
    const content = sent[0]!.body.messages[0]!.content as Block[];
    expect(content.map((b) => b.text)).toEqual(["共通", "固有"]);
    expect(marksOf(sent[0]!)).toEqual(["tools[1]", "system[0]", "messages[0][0]", "messages[0][1]"]);
  });

  it("画面ごとの 2 つの会話: 共通の部分の終わりまでのブロックが完全に一致し、そこに印がある", async () => {
    replies.push({ content: [{ type: "text", text: "a" }], stop: "end_turn" }, { content: [{ type: "text", text: "b" }], stop: "end_turn" });
    const seed = [{ role: "user" as const, text: "調査の依頼" }, { role: "assistant" as const, text: "調査結果" }];
    for (const own of ["画面 A の材料", "画面 B の材料と、少し長めの別の中身"]) {
      const s = make();
      s.seed(seed);
      await s.send([{ text: "共通の決まり (どの画面でも同じ)。", shared: true }, { text: own }]);
    }
    const upTo = (x: Sent) => {
      const blocks = simBlocks(x.body);
      const end = blocks.findIndex((b, i) => b.mark && i > 0 && x.body.messages.length > 0 && JSON.stringify(b.key).includes("共通の決まり"));
      return { end, head: blocks.slice(0, end + 1).map((b) => b.key) };
    };
    const [a, b] = [upTo(sent[0]!), upTo(sent[1]!)];
    expect(a.end).toBeGreaterThan(0);
    expect(a.head).toEqual(b.head);
    expect(simBlocks(sent[0]!.body)[a.end]!.mark).toBe(true);
    // 2 つ目の会話は、共通の部分の終わりまでを、1 つ目のキャッシュから読める
    const sim = new CacheSim();
    sim.run(sent[0]!.body);
    expect(sim.run(sent[1]!.body).hit).toBe(a.end);
  });
});

// ---- API のキャッシュの決まりを写した模型 (印ごとに、前の 20 ブロックまでさかのぼって、前のリクエストが書いたキャッシュを探す。
// 同じリクエストの中の印は、まだキャッシュに無いので手がかりにならない。読み取りは、どれかの印が届いた、いちばん長い先頭まで)
function simBlocks(body: Sent["body"]): { key: string; size: number; mark: boolean }[] {
  const strip = (x: object): string => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "cache_control")));
  const out: { key: string; size: number; mark: boolean }[] = [];
  for (const t of body.tools ?? []) out.push({ key: strip(t), size: strip(t).length, mark: !!t.cache_control });
  const sys = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? []);
  for (const b of sys) out.push({ key: strip(b), size: strip(b).length, mark: !!(b as { cache_control?: unknown }).cache_control });
  for (const m of body.messages) {
    const content: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    content.forEach((b, i) => out.push({ key: `${m.role}${i === 0 ? "|start|" : "|"}${strip(b)}`, size: strip(b).length, mark: !!b.cache_control }));
  }
  return out;
}
class CacheSim {
  private cache = new Set<string>();
  run(body: Sent["body"]): { marks: number[]; hit: number; read: number; write: number; uncached: number; total: number } {
    const blocks = simBlocks(body);
    const prefix: string[] = [];
    let acc = "";
    for (const b of blocks) prefix.push((acc += `\u0000${b.key}`));
    const sizes: number[] = [];
    let sum = 0;
    for (const b of blocks) sizes.push((sum += b.size));
    const marks = blocks.flatMap((b, i) => (b.mark ? [i] : []));
    let hit = -1;
    for (const i of marks) for (let j = i; j >= Math.max(0, i - 20); j--) if (this.cache.has(prefix[j]!)) { hit = Math.max(hit, j); break; }
    for (const i of marks) this.cache.add(prefix[i]!);
    const read = hit >= 0 ? sizes[hit]! : 0;
    const upto = marks.length > 0 ? sizes[marks[marks.length - 1]!]! : 0;
    return { marks, hit, read, write: Math.max(0, upto - read), uncached: sum - Math.max(upto, read), total: sum };
  }
}
const costOf = (r: { read: number; write: number; uncached: number }) => r.uncached + 1.25 * r.write + 0.1 * r.read;

describe("Claude: 1 往復の道具の数が多くても、前のキャッシュを読む", () => {
  for (const n of [9, 10, 19, 20, 21, 30, 40, 100]) {
    it(`道具 ${n} 件の往復を続ける: 印は 4 つ以内で、どのリクエストも、前のリクエストの最後の印までをキャッシュから読め、キャッシュなしより高くならない`, async () => {
      const round = (r: number): Block[] => Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `tu_${r}_${i}`, name: "read_file", input: { path: `src/f${r}_${i}.ts` } }));
      replies.push({ content: round(0), stop: "tool_use" }, { content: round(1), stop: "tool_use" }, { content: round(2), stop: "tool_use" }, { content: [{ type: "text", text: "終わり" }], stop: "end_turn" });
      const s = make();
      s.seed([{ role: "user", text: "調査の依頼" }, { role: "assistant", text: "調査結果" }]);
      await s.send([{ text: "共通の決まり", shared: true }, { text: "この会話の依頼" }]);
      expect(sent).toHaveLength(4);
      const sim = new CacheSim();
      let previousLast = -1;
      let total = 0;
      let nocache = 0;
      sent.forEach((x, k) => {
        const r = sim.run(x.body);
        expect(r.marks.length).toBeGreaterThan(0);
        expect(r.marks.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
        // 前のリクエストの最後の印の位置まで、読めている (読めない書き込みを作らない)
        if (k > 0) expect(r.hit).toBeGreaterThanOrEqual(previousLast);
        previousLast = r.marks[r.marks.length - 1]!;
        total += costOf(r);
        nocache += r.total;
        // 3 回目以降は、1 回ごとの費用もキャッシュなしより安い
        if (k >= 2) expect(costOf(r)).toBeLessThan(r.total);
      });
      expect(total).toBeLessThan(nocache);
    });
  }
});

describe("planCacheMarks: 印の割り当て", () => {
  const text = (t: string) => ({ type: "text" as const, text: t });
  const filler = (n: number) => Array.from({ length: n }, () => text("a"));
  it("上限を超えない。system があれば、system・いちばん新しいメッセージ・中間の印を先に取り、残りの 1 つを共通の部分・seed の順で使う", () => {
    const messages = [{ role: "user" as const, content: "前" }, { role: "assistant" as const, content: "答" }, { role: "user" as const, content: [text("共通"), text("固有")] }, { role: "assistant" as const, content: filler(30) }, { role: "user" as const, content: filler(30) }];
    const plan = planCacheMarks({ messages, seedCount: 2, previous: 3, shared: [{ message: 2, block: 0 }], hasTools: true, hasSystem: true });
    // 通し番号: 前 0・答 1・共通 2・固有 3・返答 4〜33・結果 34〜63。最後の印は 63。前の印 (3) から 18 ブロック先は 21
    expect(plan.marks.map((m) => m.flat)).toEqual([2, 21, 63]);
    expect(plan.tools).toBe(false);
  });
  it("道具の定義の最後にも、空きがあれば印を置く (いちばん後ろの優先順位。system があっても、空きがあれば置く)", () => {
    const messages = [{ role: "user" as const, content: "前" }, { role: "assistant" as const, content: "答" }, { role: "user" as const, content: "今" }];
    expect(planCacheMarks({ messages, seedCount: 2, previous: -1, hasTools: true, hasSystem: false })).toMatchObject({ tools: true });
    expect(planCacheMarks({ messages, seedCount: 2, previous: -1, hasTools: true, hasSystem: true })).toMatchObject({ tools: true });
    expect(planCacheMarks({ messages, seedCount: 2, previous: -1, hasTools: false, hasSystem: true })).toMatchObject({ tools: false });
    // seed・最後・共通・中間が揃って 4 つになったら、道具の印は外れる
    const long = [...messages, { role: "assistant" as const, content: filler(40) }, { role: "user" as const, content: filler(2) }];
    const plan = planCacheMarks({ messages: long, seedCount: 2, previous: 2, shared: [{ message: 2, block: 0 }], hasTools: true, hasSystem: false });
    expect(plan.marks).toHaveLength(MAX_CACHE_BREAKPOINTS);
    expect(plan.tools).toBe(false);
    // system があれば、system の分を引いた 3 つが埋まった時点で、道具の印は外れる
    const withSystem = planCacheMarks({ messages: long, seedCount: 2, previous: 2, shared: [{ message: 2, block: 0 }], hasTools: true, hasSystem: true });
    expect(withSystem.marks).toHaveLength(MAX_CACHE_BREAKPOINTS - 1);
    expect(withSystem.tools).toBe(false);
  });
  it("印を持てないブロック (thinking・redacted_thinking・fallback・mcp_tool_listing・空白だけの文) は、手前へ飛ばす", () => {
    const blocks = [{ type: "tool_use", id: "t", name: "x", input: {} }, { type: "thinking", thinking: "", signature: "" }, { type: "redacted_thinking", data: "" }, { type: "fallback" }, { type: "mcp_tool_listing" }, { type: "text", text: " " }];
    const messages = [{ role: "user" as const, content: "依頼" }, { role: "assistant" as const, content: blocks }] as unknown as Parameters<typeof planCacheMarks>[0]["messages"];
    const plan = planCacheMarks({ messages, seedCount: 0, previous: -1, hasTools: false, hasSystem: true });
    expect(plan.marks).toEqual([{ message: 1, block: 0, flat: 1 }]);
  });
  it("前の印から 18 ブロック以内は、中間の印を置かない。19 ブロックを超えたら置き、その位置は前の印から 18 ブロック以内", () => {
    const base = [{ role: "user" as const, content: "依頼" }];
    for (const added of [1, 17, 18]) {
      const plan = planCacheMarks({ messages: [...base, { role: "assistant" as const, content: filler(added) }], seedCount: 0, previous: 0, hasTools: false, hasSystem: true });
      expect(plan.marks).toHaveLength(1);
    }
    for (const added of [19, 40, 100]) {
      const plan = planCacheMarks({ messages: [...base, { role: "assistant" as const, content: filler(added) }], seedCount: 0, previous: 0, hasTools: false, hasSystem: true });
      expect(plan.marks.map((m) => m.flat)).toEqual([18, added]);
    }
  });
  it("履歴が空でも壊れない", () => {
    expect(planCacheMarks({ messages: [], seedCount: 0, previous: -1, hasTools: false, hasSystem: false })).toEqual({ marks: [], tools: false });
  });
});
