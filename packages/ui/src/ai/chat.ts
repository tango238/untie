// AI との会話 (道具を使うループ)。Claude (Anthropic)・Codex (OpenAI)・Gemini (Google) の API を同じ形で扱う。
// どの会社でも、会話の履歴はその会社の API の形のまま持ち、道具の定義と実行は共通にする。
import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import OpenAI from "openai";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

/**
 * 1 回のリクエストの使用量 (トークン)。会社ごとに数え方が違うので、次の 4 つに揃える (どれも重ならない。入力の合計 = input + cacheWrite + cacheRead)。
 * - input: キャッシュを使わずに読ませた入力
 * - cacheWrite: キャッシュに書いた入力 (Claude だけ。ほかの会社は自動でキャッシュするので、書き込みは分からず 0)
 * - cacheRead: キャッシュから読んだ入力
 */
export interface ChatUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** 入力の合計 (キャッシュの書き込み・読み取りを含む) */
export const totalInputTokens = (u: ChatUsage): number => u.input + u.cacheWrite + u.cacheRead;

export interface ChatEvents {
  /** 返答の文章 (少しずつ届くことがある) */
  onText?: (delta: string) => void;
  /** 道具を使った */
  onTool?: (name: string, outcome: ToolOutcome) => void;
  /** リクエストが 1 つ終わるたびに、その使用量 (API が返さなかったときは呼ばない) */
  onUsage?: (usage: ChatUsage) => void;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  system: string;
  tools: ToolDef[];
  runTool: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome>;
  /** 会話の名前 (調査・画面 UI など。使用量の記録の見分けに使う。API には送らない) */
  label?: string;
}

/** これまでの会話 (文章だけ) を引き継ぐときの 1 件 */
export interface SeedTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * 利用者の発言の 1 つの部分。Claude では、部分ごとに別々の text ブロックにする (OpenAI・Gemini は、つないだ 1 つの文字列で送る)。
 * shared は、会話どうしで同じ部分の最後 (その終わりまでのブロックを、別の会話がキャッシュから読めるように、Claude ではそこに印を置く)
 */
export interface RequestPart {
  text: string;
  shared?: boolean;
}

/** 利用者の発言: 文字列、または部分の並び (共通の部分 → この会話だけの部分の順) */
export type UserRequest = string | readonly RequestPart[];

/** 発言を 1 つの文字列にする (部分は、そのままつなぐ) */
export const requestText = (r: UserRequest): string => (typeof r === "string" ? r : r.map((p) => p.text).join(""));

export interface ChatSession {
  /** 利用者の発言を送り、道具を使い終えるまで続ける。最後の返答の文章を返す。道具の結果が finish を示したときは、その往復で終える (そのときの返答の文章を返す) */
  send: (text: UserRequest, events?: ChatEvents, signal?: AbortSignal) => Promise<string>;
  /** 以前の会話を履歴に入れる (新しいセッションで続きから話すため) */
  seed: (turns: SeedTurn[]) => void;
}

/** 道具を使う往復の上限 (道具を呼び続けて終わらないのを防ぐ。「ソースコードから作成」の会話ごとの上限の検査も、これを使う) */
export const MAX_STEPS = 60;

export class ChatError extends Error {}

export function createChatSession(provider: ProviderId, options: ChatOptions): ChatSession {
  switch (provider) {
    case "claude":
      return claudeSession(options);
    case "codex":
      return openaiSession(options);
    case "gemini":
      return geminiSession(options);
  }
}

// ---------------------------------------------------------------- Claude (Anthropic)

/** サーバー側のフォールバック (安全のための判定で断られたとき、別のモデルで続ける) を使えるモデル */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

/**
 * Anthropic のクライアント。画面 (WebView・ブラウザ) から直接呼ぶ。キーは利用者のもので、利用者の端末から出ない。
 * SDK は apiKey を `Authorization: Bearer` で送るが、ブラウザから直接呼ぶ経路 (anthropic-dangerous-direct-browser-access)
 * では API が Bearer を受け付けず `x-api-key` を求めるので、x-api-key で送り、Authorization は外す。
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { "x-api-key": apiKey, Authorization: null },
  });
}

// プロンプトキャッシュ: リクエストは tools → system → messages の順に、先頭から一致したところまでが読まれる (実際の API で確かめたもの。
// 印 (cache_control) を置いた箇所までの先頭がキャッシュされ、次のリクエストで先頭が同じなら読み取りになる。短すぎる入力は、エラーにならず、キャッシュされないだけ)。
// 1 回のリクエストに置ける印は 4 つまで (超えると 400)。
//
// 印から前へさかのぼって前のキャッシュを探す範囲は 20 ブロック (API の決まり。リクエストの中のほかの印は、まだキャッシュに無いので手がかりにならない)。
// 1 つの往復で道具を何件も呼んでブロックが増えると、いちばん新しいメッセージの印は、前のリクエストの印から 20 ブロックより遠くなり、前のキャッシュを
// 読めずに、履歴全体を書き直す (書き込みは入力の 1.25 倍なので、キャッシュなしより高くつく)。そこで、前のリクエストの最後の印から
// 18 ブロック以内に「中間の印」を置く (印は、新しい返答の途中のブロックにも置ける)。読み取りは、どれか 1 つの印が前のキャッシュに届けば足りる。
// 中間の印より先は、いちばん新しい印まで書き込みになり、次のリクエストはそこから数える。
//
// 印の配り方 (優先順位。上限 4 つ。system があれば、その分の 1 つを先に取る):
//   1. いちばん新しいメッセージの最後 (次のリクエストが、ここから前のキャッシュを探す)
//   2. 中間の印 (前のリクエストの最後の印から 18 ブロックより遠いときだけ。前のキャッシュを読むための印なので、ほかより先に取る)
//   3. 会話どうしで共通の部分の終わり (RequestPart の shared)
//   4. 引き継いだ履歴 (seed) の最後
//   5. 道具の定義の最後 (空きがあるときだけ。道具の定義は system より前にあり、system の印がそこまでを含めて覆うので、system があるときは、
//      外しても、同じ道具・同じ system の会話どうしで読める範囲は変わらない。この印が効くのは、道具の定義が同じで system だけが違う会話の間だけ)
// 空きが無いとき、後ろの番号から落とす。落としても、前のキャッシュを読めることは変わらない (1 と 2 は、いつも残る)。

/** 1 回のリクエストに置ける印の数の上限 (API の決まり) */
export const MAX_CACHE_BREAKPOINTS = 4;
/** 印から前へさかのぼって、前の印のキャッシュを探す範囲 (内容のブロック数) */
const CACHE_LOOKBACK_BLOCKS = 20;
/** 中間の印を、前の印からこのブロック数以内に置く (探す範囲 20 に、余裕を持たせる) */
const CACHE_REACH_BLOCKS = CACHE_LOOKBACK_BLOCKS - 2;
const EPHEMERAL = { type: "ephemeral" } as const;

/** 会話の履歴の 1 件 (user か assistant) */
type ClaudeMessage = Anthropic.Beta.BetaUserMessageParam | Anthropic.Beta.BetaAssistantMessageParam;

/** 印 (cache_control) を持てないブロックの type (SDK の型で cache_control の項目が無いもの。空の文・空白だけの文も、API が断るので付けない) */
const UNMARKABLE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "mcp_tool_listing", "fallback"]);

const isMarkable = (b: { type: string; text?: unknown }): boolean => !UNMARKABLE_BLOCK_TYPES.has(b.type) && !(b.type === "text" && typeof b.text === "string" && b.text.trim() === "");

/** 履歴のブロックを、先頭から 1 列に並べたもの (リクエストの中のブロックの並びと同じ。文字列のメッセージは 1 ブロック) */
interface FlatBlock {
  message: number;
  block: number;
  markable: boolean;
}

function flattenMessages(messages: readonly ClaudeMessage[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  messages.forEach((m, message) => {
    if (typeof m.content === "string") out.push({ message, block: 0, markable: m.content.trim() !== "" });
    else m.content.forEach((b, block) => out.push({ message, block, markable: isMarkable(b) }));
  });
  return out;
}

/** 履歴の中の、ブロックの位置 (メッセージの番号と、その中のブロックの番号) */
export interface BlockRef {
  message: number;
  block: number;
}

/** 印を置く計画。marks は印を置くブロックの位置 (先頭からの通し番号 flat の昇順)。tools は、道具の定義の最後にも印を置くか */
export interface CachePlan {
  marks: (BlockRef & { flat: number })[];
  tools: boolean;
}

/**
 * リクエストに置く印を決める (配り方は、このファイルの上の説明)。previous は、前のリクエストが置いた最後の印の、通し番号 (無ければ -1)。
 * shared は、会話どうしで共通の部分の終わりのブロック (呼ぶ側が控えたもの)
 */
export function planCacheMarks(a: { messages: readonly ClaudeMessage[]; seedCount: number; previous: number; shared?: readonly BlockRef[]; hasTools: boolean; hasSystem: boolean }): CachePlan {
  const blocks = flattenMessages(a.messages);
  const flatOf = (r: BlockRef): number => blocks.findIndex((x) => x.message === r.message && x.block === r.block);
  /** メッセージの最後のブロックの通し番号 */
  const lastFlatOf = (message: number): number => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.message === message) return i;
    return -1;
  };
  /** from 以前で、lowerExclusive より後ろの、印を持てるブロックのうち、いちばん後ろの通し番号 (無ければ -1) */
  const markableAtOrBefore = (from: number, lowerExclusive = -1): number => {
    for (let i = Math.min(from, blocks.length - 1); i > lowerExclusive; i--) if (blocks[i]!.markable) return i;
    return -1;
  };
  const slots = MAX_CACHE_BREAKPOINTS - (a.hasSystem ? 1 : 0);
  const picked: number[] = [];
  const add = (flat: number): void => {
    if (flat >= 0 && picked.length < slots && !picked.includes(flat)) picked.push(flat);
  };
  const tail = markableAtOrBefore(blocks.length - 1);
  // 1. いちばん新しいメッセージの最後
  add(tail);
  // 2. 中間の印: 前の印から届く範囲 (18 ブロック以内) の、いちばん後ろ。前の印より後ろに、印を持てるブロックが無ければ置けない
  if (tail >= 0 && a.previous >= 0 && tail - a.previous > CACHE_REACH_BLOCKS) {
    const mid = markableAtOrBefore(a.previous + CACHE_REACH_BLOCKS, a.previous);
    if (mid > a.previous) add(mid);
  }
  // 3. 共通の部分の終わり (いちばん新しいメッセージの最後と同じなら、重ねない)
  for (const r of a.shared ?? []) add(markableAtOrBefore(flatOf(r)));
  // 4. 引き継いだ履歴の最後
  if (a.seedCount > 0) add(markableAtOrBefore(lastFlatOf(a.seedCount - 1)));
  // 5. 道具の定義の最後 (空きがあるときだけ。system があれば、system の印が道具の定義も覆うので、無くても読める範囲は変わらない)
  return {
    marks: picked.sort((x, y) => x - y).map((flat) => ({ message: blocks[flat]!.message, block: blocks[flat]!.block, flat })),
    tools: a.hasTools && picked.length < slots,
  };
}

/** 印を付けたコピーを作る (元の履歴は変えない)。文字列のメッセージは、text ブロック 1 つの配列になる */
function applyMarks(messages: readonly ClaudeMessage[], marks: readonly BlockRef[]): ClaudeMessage[] {
  if (marks.length === 0) return messages.slice();
  return messages.map((m, mi) => {
    const here = marks.filter((x) => x.message === mi).map((x) => x.block);
    if (here.length === 0) return m;
    if (typeof m.content === "string") return { ...m, content: [{ type: "text" as const, text: m.content, cache_control: EPHEMERAL }] } as ClaudeMessage;
    const content = m.content.slice();
    for (const bi of here) content[bi] = { ...content[bi]!, cache_control: EPHEMERAL } as (typeof content)[number];
    return { ...m, content } as ClaudeMessage;
  });
}

/** Anthropic の使用量を、会社をまたいだ形にする */
function claudeUsage(u: Anthropic.Beta.BetaUsage | undefined): ChatUsage | null {
  if (!u) return null;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
}

function claudeSession(o: ChatOptions): ChatSession {
  const client = createAnthropicClient(o.apiKey);
  const messages: ClaudeMessage[] = [];
  const tools: Anthropic.Beta.BetaTool[] = o.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const fallback = FALLBACK_MODELS.has(o.model);
  // 空白だけの system は、送らず、印も付けない (空のブロックは API が断る)
  const hasSystem = o.system.trim() !== "";
  /** 引き継いだ履歴の数 (この数までが、別の会話と先頭を分け合える部分) */
  let seedCount = 0;
  /** 前のリクエストが置いた最後の印の、通し番号 (履歴は足されるだけなので、あとのリクエストでも同じブロックを指す)。置かなかったときは -1 */
  let previousMark = -1;
  /** 発言の共通の部分の終わりのブロック */
  const shared: BlockRef[] = [];

  /** 利用者の発言を履歴に足す。直前が道具の結果 (終わりの印で終えた往復) なら、その user のメッセージの末尾に足す (user が続かないように) */
  function pushUser(input: UserRequest): void {
    const last = messages[messages.length - 1];
    if (typeof input === "string" && !(last && last.role === "user" && Array.isArray(last.content))) {
      messages.push({ role: "user", content: input });
      return;
    }
    const parts: RequestPart[] = typeof input === "string" ? [{ text: input }] : input.filter((p) => p.text.trim() !== "");
    const blocks = parts.map((p) => ({ type: "text" as const, text: p.text }));
    const base = last && last.role === "user" && Array.isArray(last.content) ? last.content : [];
    const message = base.length > 0 ? messages.length - 1 : messages.length;
    const content = [...base, ...blocks] as Anthropic.Beta.BetaContentBlockParam[];
    if (base.length > 0) messages[message] = { role: "user", content };
    else messages.push({ role: "user", content });
    const lastShared = parts.map((p) => !!p.shared).lastIndexOf(true);
    if (lastShared >= 0) shared.push({ message, block: base.length + lastShared });
  }

  return {
    seed(turns) {
      for (const t of turns) messages.push({ role: t.role, content: t.text });
      seedCount = messages.length;
    },
    async send(text, events = {}, signal) {
      pushUser(text);
      let last = "";
      for (let step = 0; step < MAX_STEPS; step++) {
        // 印は、リクエストごとに付け直す (保存している履歴には付けない。古い印は残らない)
        const plan = planCacheMarks({ messages, seedCount, previous: previousMark, shared, hasTools: tools.length > 0, hasSystem });
        const sent = applyMarks(messages, plan.marks);
        const sentTools = plan.tools ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)) : tools;
        const stream = client.beta.messages.stream(
          {
            model: o.model,
            max_tokens: 64000,
            ...(hasSystem ? { system: [{ type: "text" as const, text: o.system, cache_control: EPHEMERAL }] } : {}),
            tools: sentTools,
            messages: sent,
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        stream.on("text", (delta) => events.onText?.(delta));
        const message = await stream.finalMessage();
        if (plan.marks.length > 0) previousMark = plan.marks[plan.marks.length - 1]!.flat;
        const usage = claudeUsage(message.usage);
        if (usage) events.onUsage?.(usage);
        messages.push({ role: "assistant", content: message.content });
        last = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        if (message.stop_reason === "refusal") throw new ChatError("安全のための判定で、この依頼には答えられませんでした。言い方を変えて試してください。");
        if (message.stop_reason === "pause_turn") continue;
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) return last;
        if (message.stop_reason === "max_tokens") throw new ChatError("返答が長すぎて途中で切れました。範囲を絞って依頼してください。");
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        let finish = false;
        for (const call of calls) {
          const outcome = await o.runTool(call.name, call.input);
          events.onTool?.(call.name, outcome);
          results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, ...(outcome.ok ? {} : { is_error: true }) });
          if (outcome.finish) finish = true;
        }
        // 呼んだ道具の結果は、終えるときも履歴に残す (呼び出しと結果が対になる。あとで同じ会話に send しても、結果の無い呼び出しが残らない)
        messages.push({ role: "user", content: results });
        if (finish) return last;
      }
      throw new ChatError("道具を使う回数が上限に達しました。依頼を分けて試してください。");
    },
  };
}

// ---------------------------------------------------------------- Codex (OpenAI)

function openaiSession(o: ChatOptions): ChatSession {
  const client = new OpenAI({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  const tools: OpenAI.Responses.FunctionTool[] = o.tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));

  return {
    seed(turns) {
      for (const t of turns) input.push({ role: t.role, content: t.text });
    },
    async send(text, events = {}, signal) {
      input.push({ role: "user", content: requestText(text) });
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await client.responses.create({ model: o.model, instructions: o.system, input, tools }, { signal });
        // 返ってきた出力 (推論・文章・道具の呼び出し) はそのまま次の入力に足す
        input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
        if (response.output_text) events.onText?.(response.output_text);
        const u = response.usage;
        if (u) {
          const cached = u.input_tokens_details?.cached_tokens ?? 0;
          events.onUsage?.({ input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cacheWrite: 0, cacheRead: cached });
        }
        const calls = response.output.filter((x): x is OpenAI.Responses.ResponseFunctionToolCall => x.type === "function_call");
        if (calls.length === 0) return response.output_text;
        let finish = false;
        for (const call of calls) {
          let args: unknown = {};
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch {
            const outcome: ToolOutcome = { ok: false, content: JSON.stringify({ error: "引数が JSON として読めません" }), changed: false };
            events.onTool?.(call.name, outcome);
            input.push({ type: "function_call_output", call_id: call.call_id, output: outcome.content });
            continue;
          }
          const outcome = await o.runTool(call.name, args);
          events.onTool?.(call.name, outcome);
          input.push({ type: "function_call_output", call_id: call.call_id, output: outcome.content });
          if (outcome.finish) finish = true;
        }
        // 呼び出しと結果は、履歴に対で残してある。終えてよいと示されたら、次のリクエストを送らない
        if (finish) return response.output_text;
      }
      throw new ChatError("道具を使う回数が上限に達しました。依頼を分けて試してください。");
    },
  };
}

// ---------------------------------------------------------------- Gemini (Google)

function geminiSession(o: ChatOptions): ChatSession {
  const ai = new GoogleGenAI({ apiKey: o.apiKey });
  const contents: Content[] = [];
  const functionDeclarations = o.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));

  return {
    seed(turns) {
      for (const t of turns) contents.push({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] });
    },
    async send(text, events = {}, signal) {
      // 直前が道具の結果 (終わりの印で終えた往復) なら、その user の発言の末尾に足す (user が続かないように)
      const prev = contents[contents.length - 1];
      if (prev && prev.role === "user" && prev.parts?.some((p) => p.functionResponse)) contents[contents.length - 1] = { ...prev, parts: [...prev.parts, { text: requestText(text) }] };
      else contents.push({ role: "user", parts: [{ text: requestText(text) }] });
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await ai.models.generateContent({
          model: o.model,
          contents,
          config: { systemInstruction: o.system, tools: [{ functionDeclarations }], ...(signal ? { abortSignal: signal } : {}) },
        });
        const um = response.usageMetadata;
        if (um) {
          const cached = um.cachedContentTokenCount ?? 0;
          events.onUsage?.({ input: Math.max(0, (um.promptTokenCount ?? 0) - cached), output: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0), cacheWrite: 0, cacheRead: cached });
        }
        const reply = response.candidates?.[0]?.content;
        if (!reply) throw new ChatError("Gemini から返答がありませんでした。");
        contents.push(reply);
        const textOut = response.text ?? "";
        if (textOut) events.onText?.(textOut);
        const calls = response.functionCalls ?? [];
        if (calls.length === 0) return textOut;
        const parts: Part[] = [];
        let finish = false;
        for (const call of calls) {
          const name = call.name ?? "";
          const outcome = await o.runTool(name, call.args ?? {});
          events.onTool?.(name, outcome);
          if (outcome.finish) finish = true;
          parts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name,
              response: outcome.ok ? { output: JSON.parse(outcome.content) } : { error: JSON.parse(outcome.content) },
            },
          });
        }
        contents.push({ role: "user", parts });
        // 呼び出しと結果は、履歴に対で残してある。終えてよいと示されたら、次のリクエストを送らない
        if (finish) return textOut;
      }
      throw new ChatError("道具を使う回数が上限に達しました。依頼を分けて試してください。");
    },
  };
}

/** 利用者の中断か (Anthropic・OpenAI は APIUserAbortError、Gemini や fetch は AbortError) */
export function isAbortError(e: unknown): boolean {
  return e instanceof Anthropic.APIUserAbortError || e instanceof OpenAI.APIUserAbortError || (e instanceof Error && e.name === "AbortError");
}

/** 利用残高が足りないときの文 (provider は管理画面を持つ会社の名前) */
const noBalanceMessage = (provider: string): string => `API の利用残高が足りません。${provider} の管理画面で残高を確かめてください。`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * SDK の例外から、API が返したメッセージだけを取り出す (「400 {"type":"error",…}」のような、状態と JSON の全文は出さない)。
 * Anthropic は本文全体が error ({type:"error", error:{type, message}}) に入り、OpenAI は error が内側の {message, type, code} になっている。
 * Gemini (@google/genai の ApiError) は message が本文の JSON 文字列 ({error:{code, message, status}})。取り出せなければ undefined
 */
function apiMessageOf(e: InstanceType<typeof Anthropic.APIError> | InstanceType<typeof OpenAI.APIError> | GeminiApiError): string | undefined {
  if (e instanceof GeminiApiError) {
    try {
      const body: unknown = JSON.parse(e.message);
      const inner = isRecord(body) && isRecord(body.error) ? body.error : body;
      return isRecord(inner) && typeof inner.message === "string" ? inner.message : undefined;
    } catch {
      return e.message || undefined;
    }
  }
  const body: unknown = e.error;
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : undefined;
}

/** API が利用残高の不足を返したか (Anthropic: 400 の本文に「credit balance is too low」。OpenAI: code が insufficient_quota。Gemini: 前払いの残高が尽きた旨の本文) */
function providerOfNoBalance(e: unknown): string | null {
  if (e instanceof Anthropic.APIError) return /credit balance is too low/i.test(apiMessageOf(e) ?? e.message) ? "Anthropic" : null;
  if (e instanceof OpenAI.APIError) return e.code === "insufficient_quota" || e.type === "insufficient_quota" ? "OpenAI" : null;
  if (e instanceof GeminiApiError) return /credits are depleted|insufficient (funds|balance)/i.test(apiMessageOf(e) ?? "") ? "Google AI Studio" : null;
  return null;
}

/** API のエラーを、利用者に見せる短い文にする */
export function describeChatError(e: unknown): string {
  if (e instanceof ChatError) return e.message;
  // 中断は、API のエラー (APIError を継承する) より先に見る
  if (isAbortError(e)) return "中断しました。";
  // 残高不足は、状態 (400・429) によらず、ほかの API のエラーより先に見る
  const noBalance = providerOfNoBalance(e);
  if (noBalance) return noBalanceMessage(noBalance);
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return "API キーが正しくありません。設定を確かめてください。";
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return "利用の上限に達しました。少し待ってから試してください。";
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return "モデルが見つかりません。設定のモデル名を確かめてください。";
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return "API に接続できませんでした。ネットワークを確かめてください。";
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError || e instanceof GeminiApiError) {
    // Gemini の例外は、キー・モデル・上限の別を状態から決める
    if (e instanceof GeminiApiError) {
      if (e.status === 401 || e.status === 403) return "API キーが正しくありません。設定を確かめてください。";
      if (e.status === 404) return "モデルが見つかりません。設定のモデル名を確かめてください。";
      if (e.status === 429) return "利用の上限に達しました。少し待ってから試してください。";
    }
    // 状態と API のメッセージだけを出す (本文の JSON の全文は出さない)
    const message = apiMessageOf(e);
    return `API のエラー (${e.status ?? "?"}): ${message ?? e.message.replace(/^\d{3}\s+/, "").slice(0, 300)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 繰り返しても直らない HTTP の状態 (リクエストの誤り・キーの誤り・権限・モデルが無い・形式の誤り) */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);

/**
 * 一時的な API のエラーか (過負荷 529・サーバーの 5xx・接続断・タイムアウト・レート制限 429・408)。
 * キーの誤り (401/403)・モデルが無い (404)・リクエストの誤り (400 ほか) のように、繰り返しても直らないものと、中断、判定できないものは false。
 * Anthropic・OpenAI は APIError の status (接続断は APIConnectionError で status が無い)、Gemini は ApiError の status で調べる
 */
export function isTransientApiError(e: unknown): boolean {
  if (isAbortError(e)) return false;
  // 残高が足りないのは、待っても (429 でも) 直らない
  if (providerOfNoBalance(e)) return false;
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return e.status === undefined || !PERMANENT_STATUSES.has(e.status);
  if (e instanceof GeminiApiError) return typeof e.status === "number" && !PERMANENT_STATUSES.has(e.status);
  return false;
}
