// 「ソースコードから作成」の会話を、本物の chat.ts (偽の fetch) で走らせて、実際に送るリクエストのキャッシュの印を確かめる。
// (reverseCache.test.ts は AI の会話を偽物に差し替えているので、送る本文までは確かめられない)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSession } from "../reverse";
import { reverseScreenRequestParts } from "../reversePrompts";
import { memorySourceTree } from "../sourceTree";
import type { ToolDef, ToolOutcome } from "../tools";

type Block = { type: string; text?: string; cache_control?: unknown };
interface Sent {
  tools?: { name: string; cache_control?: unknown }[];
  system?: { text: string; cache_control?: unknown }[];
  messages: { role: string; content: string | Block[] }[];
}
const sent: Sent[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const usage = { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const body =
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage } }) +
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
        ev("content_block_stop", { index: 0 }) +
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }) +
        ev("message_stop", {});
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const stageTools: ToolDef[] = [{ name: "submit_screen", description: "d", parameters: { type: "object", properties: {} } }];
const ok = (): ToolOutcome => ({ ok: true, content: "{}", changed: false });
const strip = (x: object) => JSON.stringify({ ...x, cache_control: undefined });

/** リクエストの中身を、先頭から 1 ブロックずつの列にする (キャッシュの先頭の一致は、この列の先頭からの一致) */
function flat(b: Sent): { key: string; mark: boolean }[] {
  return [
    ...(b.tools ?? []).map((t) => ({ key: strip(t), mark: !!t.cache_control })),
    ...(b.system ?? []).map((t) => ({ key: strip(t), mark: !!t.cache_control })),
    ...b.messages.flatMap((m) => (typeof m.content === "string" ? [{ key: `${m.role}:${m.content}`, mark: false }] : m.content.map((c) => ({ key: `${m.role}:${strip(c)}`, mark: !!c.cache_control })))),
  ];
}

describe("画面 UI の会話: 共通の部分の終わりに印を置き、画面をまたいで読めるようにする (Claude)", () => {
  async function runTwo() {
    const tree = memorySourceTree("t", { "a.ts": "x" });
    const ctx = { tree, o: { provider: "claude" as const, model: "claude-opus-5-5", apiKey: "k" }, budget: { calls: 10, chars: 10000, usedCalls: 0, usedChars: 0 } };
    const seed = [{ role: "user" as const, text: "調査の依頼" }, { role: "assistant" as const, text: "調査結果" }];
    for (const name of ["注文入力", "注文一覧"]) {
      const session = openSession(ctx, { label: "画面 UI", system: "指示", stageTools, cap: { calls: 5, chars: 1000, finish: "submit" }, handlers: { submit_screen: ok }, seed, unavailable: "x" });
      await session.send(reverseScreenRequestParts(`材料 ${name}`, name));
    }
  }

  it("2 つの会話の、共通の部分の終わりまでのブロックが完全に一致し、そこに印がある。画面ごとの部分は別のブロックで、違う", async () => {
    await runTwo();
    expect(sent).toHaveLength(2);
    const [a, b] = [flat(sent[0]!), flat(sent[1]!)];
    const shared = a.findIndex((x) => x.key.includes("画面 UI を作る会話の決まり"));
    expect(shared).toBeGreaterThan(0);
    expect(a[shared]!.mark).toBe(true);
    expect(b[shared]!.mark).toBe(true);
    expect(b.slice(0, shared + 1).map((x) => x.key)).toEqual(a.slice(0, shared + 1).map((x) => x.key));
    expect(b[shared + 1]!.key).not.toBe(a[shared + 1]!.key);
    expect(a[shared + 1]!.key).toContain("注文入力");
    // system の印が道具の定義も覆うので、道具の印は付かない。印は 4 つ以内 (system・seed の最後・共通の部分の終わり・いちばん新しいメッセージ)
    expect(sent[0]!.tools!.some((t) => t.cache_control)).toBe(false);
    expect(a.filter((x) => x.mark)).toHaveLength(4);
  });

  it("OpenAI・Gemini に送る文は、部分をつないだ 1 つの文字列 (今までの依頼と同じ)", async () => {
    const { requestText } = await import("../chat");
    const parts = reverseScreenRequestParts("材料", "注文入力");
    expect(parts).toHaveLength(2);
    expect(requestText(parts)).toBe(parts.map((p) => p.text).join(""));
    expect(requestText(parts).indexOf("======== ここから、この画面の依頼 ========")).toBe(parts[0]!.text.length);
  });
});
