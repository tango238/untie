// AI との会話 (道具を使うループ)。Claude (Anthropic)・Codex (OpenAI)・Gemini (Google) の API を同じ形で扱う。
// どの会社でも、会話の履歴はその会社の API の形のまま持ち、道具の定義と実行は共通にする。
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import OpenAI from "openai";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

export interface ChatEvents {
  /** 返答の文章 (少しずつ届くことがある) */
  onText?: (delta: string) => void;
  /** 道具を使った */
  onTool?: (name: string, outcome: ToolOutcome) => void;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  system: string;
  tools: ToolDef[];
  runTool: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome>;
}

/** これまでの会話 (文章だけ) を引き継ぐときの 1 件 */
export interface SeedTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatSession {
  /** 利用者の発言を送り、道具を使い終えるまで続ける。最後の返答の文章を返す */
  send: (text: string, events?: ChatEvents, signal?: AbortSignal) => Promise<string>;
  /** 以前の会話を履歴に入れる (新しいセッションで続きから話すため) */
  seed: (turns: SeedTurn[]) => void;
}

/** 道具を使う往復の上限 (道具を呼び続けて終わらないのを防ぐ) */
const MAX_STEPS = 60;

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

function claudeSession(o: ChatOptions): ChatSession {
  // デスクトップアプリの中から直接呼ぶ。キーは利用者のもので、利用者の端末から出ない
  const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const tools: Anthropic.Beta.BetaTool[] = o.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const fallback = FALLBACK_MODELS.has(o.model);

  return {
    seed(turns) {
      for (const t of turns) messages.push({ role: t.role, content: t.text });
    },
    async send(text, events = {}, signal) {
      messages.push({ role: "user", content: text });
      let last = "";
      for (let step = 0; step < MAX_STEPS; step++) {
        const stream = client.beta.messages.stream(
          {
            model: o.model,
            max_tokens: 64000,
            system: o.system,
            tools,
            messages,
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        stream.on("text", (delta) => events.onText?.(delta));
        const message = await stream.finalMessage();
        messages.push({ role: "assistant", content: message.content });
        last = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        if (message.stop_reason === "refusal") throw new ChatError("安全のための判定で、この依頼には答えられませんでした。言い方を変えて試してください。");
        if (message.stop_reason === "pause_turn") continue;
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) return last;
        if (message.stop_reason === "max_tokens") throw new ChatError("返答が長すぎて途中で切れました。範囲を絞って依頼してください。");
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const outcome = await o.runTool(call.name, call.input);
          events.onTool?.(call.name, outcome);
          results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, ...(outcome.ok ? {} : { is_error: true }) });
        }
        messages.push({ role: "user", content: results });
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
      input.push({ role: "user", content: text });
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await client.responses.create({ model: o.model, instructions: o.system, input, tools }, { signal });
        // 返ってきた出力 (推論・文章・道具の呼び出し) はそのまま次の入力に足す
        input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
        if (response.output_text) events.onText?.(response.output_text);
        const calls = response.output.filter((x): x is OpenAI.Responses.ResponseFunctionToolCall => x.type === "function_call");
        if (calls.length === 0) return response.output_text;
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
        }
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
      contents.push({ role: "user", parts: [{ text }] });
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await ai.models.generateContent({
          model: o.model,
          contents,
          config: { systemInstruction: o.system, tools: [{ functionDeclarations }], ...(signal ? { abortSignal: signal } : {}) },
        });
        const reply = response.candidates?.[0]?.content;
        if (!reply) throw new ChatError("Gemini から返答がありませんでした。");
        contents.push(reply);
        const textOut = response.text ?? "";
        if (textOut) events.onText?.(textOut);
        const calls = response.functionCalls ?? [];
        if (calls.length === 0) return textOut;
        const parts: Part[] = [];
        for (const call of calls) {
          const name = call.name ?? "";
          const outcome = await o.runTool(name, call.args ?? {});
          events.onTool?.(name, outcome);
          parts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name,
              response: outcome.ok ? { output: JSON.parse(outcome.content) } : { error: JSON.parse(outcome.content) },
            },
          });
        }
        contents.push({ role: "user", parts });
      }
      throw new ChatError("道具を使う回数が上限に達しました。依頼を分けて試してください。");
    },
  };
}

/** API のエラーを、利用者に見せる短い文にする */
export function describeChatError(e: unknown): string {
  if (e instanceof ChatError) return e.message;
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return "API キーが正しくありません。設定を確かめてください。";
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return "利用の上限に達しました。少し待ってから試してください。";
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return "モデルが見つかりません。設定のモデル名を確かめてください。";
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return "API に接続できませんでした。ネットワークを確かめてください。";
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return `API のエラー (${e.status ?? "?"}): ${e.message}`;
  if (e instanceof Error && e.name === "AbortError") return "中断しました。";
  return e instanceof Error ? e.message : String(e);
}
