// SDK を偽物にせず、本物のクライアントに偽の fetch を渡して、リクエストの形 (ヘッダー) と API のエラーの種類の判定を確かめる。
import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { createAnthropicClient, isTransientApiError, MAX_STEPS } from "../chat";

describe("Anthropic のクライアント: ストリーミングの呼び出し", () => {
  it("beta.messages.stream でも、キーを x-api-key で送り、Authorization (Bearer) は付けない", async () => {
    const sent: Headers[] = [];
    const client = createAnthropicClient("sk-ant-stream").withOptions({
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "テスト" } }), { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await expect(client.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()).rejects.toBeDefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("x-api-key")).toBe("sk-ant-stream");
    expect(sent[0]!.has("authorization")).toBe(false);
    expect(sent[0]!.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  });
});

describe("isTransientApiError: 繰り返せば通るかもしれない API のエラー", () => {
  const anthropic = (status: number | undefined) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "m" } }, "m", new Headers());
  const openai = (status: number | undefined) => OpenAI.APIError.generate(status, { message: "m" }, "m", new Headers());
  const gemini = (status: number) => new GeminiApiError({ message: "m", status });

  it("過負荷 (529)・サーバーのエラー (5xx)・レート制限 (429)・タイムアウト (408)・接続断は一時的", () => {
    for (const status of [529, 500, 502, 503, 429, 408]) {
      expect(isTransientApiError(anthropic(status))).toBe(true);
      expect(isTransientApiError(openai(status))).toBe(true);
      expect(isTransientApiError(gemini(status))).toBe(true);
    }
    expect(isTransientApiError(new Anthropic.APIConnectionError({ message: "down" }))).toBe(true);
    expect(isTransientApiError(new OpenAI.APIConnectionError({ message: "down" }))).toBe(true);
    expect(isTransientApiError(new Anthropic.APIConnectionTimeoutError())).toBe(true);
  });

  it("キーの誤り (401/403)・モデルが無い (404)・リクエストの誤り (400) は繰り返しても直らない", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientApiError(anthropic(status))).toBe(false);
      expect(isTransientApiError(openai(status))).toBe(false);
      expect(isTransientApiError(gemini(status))).toBe(false);
    }
  });

  it("中断と、判定できないエラーは一時的としない", () => {
    expect(isTransientApiError(new Anthropic.APIUserAbortError())).toBe(false);
    expect(isTransientApiError(new OpenAI.APIUserAbortError())).toBe(false);
    expect(isTransientApiError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isTransientApiError(new Error("boom"))).toBe(false);
    expect(isTransientApiError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isTransientApiError("503")).toBe(false);
  });
});

describe("MAX_STEPS", () => {
  it("export されている (「ソースコードから作成」の上限の検査が使う)", () => {
    expect(MAX_STEPS).toBeGreaterThan(0);
  });
});
