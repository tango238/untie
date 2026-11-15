// API のエラーを利用者向けの日本語にする (describeChatError)。SDK は本物の例外クラスを使う。
import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { describeChatError, isTransientApiError } from "../chat";

const headers = new Headers();

describe("describeChatError: API のエラー", () => {
  it("Anthropic の残高不足 (400 invalid_request_error) は、生の JSON を出さず、残高を確かめる文にする", () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } };
    const e = Anthropic.APIError.generate(400, body, undefined, headers);
    expect(e.message).toContain('{"type":"error"');
    const text = describeChatError(e);
    expect(text).toBe("API の利用残高が足りません。Anthropic の管理画面で残高を確かめてください。");
    expect(text).not.toContain("{");
  });

  it("OpenAI の insufficient_quota (429) は、レート制限ではなく残高の文にする。通常の 429 は今までどおり", () => {
    const quota = OpenAI.APIError.generate(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }, undefined, headers);
    expect(describeChatError(quota)).toBe("API の利用残高が足りません。OpenAI の管理画面で残高を確かめてください。");
    const rate = OpenAI.APIError.generate(429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, undefined, headers);
    expect(describeChatError(rate)).toBe("利用の上限に達しました。少し待ってから試してください。");
  });

  it("Gemini の前払いの残高切れ (429 RESOURCE_EXHAUSTED) は残高の文に、ふつうの 429・キー・モデルは今までの文に", () => {
    const depleted = new GeminiApiError({ status: 429, message: JSON.stringify({ error: { code: 429, message: "Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.", status: "RESOURCE_EXHAUSTED" } }) });
    expect(describeChatError(depleted)).toBe("API の利用残高が足りません。Google AI Studio の管理画面で残高を確かめてください。");
    const rate = new GeminiApiError({ status: 429, message: JSON.stringify({ error: { code: 429, message: "Quota exceeded for requests per minute", status: "RESOURCE_EXHAUSTED" } }) });
    expect(describeChatError(rate)).toBe("利用の上限に達しました。少し待ってから試してください。");
    expect(describeChatError(new GeminiApiError({ status: 403, message: "{}" }))).toBe("API キーが正しくありません。設定を確かめてください。");
    expect(describeChatError(new GeminiApiError({ status: 404, message: "{}" }))).toBe("モデルが見つかりません。設定のモデル名を確かめてください。");
  });

  it("そのほかの APIError は、JSON の全文ではなく、ステータスと API のメッセージだけを出す", () => {
    const anthropic = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 99999 > 64000, which is the maximum allowed" } }, undefined, headers);
    expect(describeChatError(anthropic)).toBe("API のエラー (400): max_tokens: 99999 > 64000, which is the maximum allowed");
    const overloaded = Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, headers);
    expect(describeChatError(overloaded)).toBe("API のエラー (529): Overloaded");
    const openai = OpenAI.APIError.generate(400, { error: { message: "Unsupported parameter: 'x'", type: "invalid_request_error", code: null } }, undefined, headers);
    expect(describeChatError(openai)).toBe("API のエラー (400): Unsupported parameter: 'x'");
    const gemini = new GeminiApiError({ status: 400, message: JSON.stringify({ error: { code: 400, message: "Invalid value at 'x'", status: "INVALID_ARGUMENT" } }) });
    expect(describeChatError(gemini)).toBe("API のエラー (400): Invalid value at 'x'");
    // 本文が JSON でない・メッセージが取れないときは、状態の接頭辞を除いたメッセージ
    const plain = Anthropic.APIError.generate(502, undefined, "Bad gateway", headers);
    expect(describeChatError(plain)).toBe("API のエラー (502): Bad gateway");
  });

  it("残高不足は、待っても直らないので、一時的なエラーとは扱わない (OpenAI の insufficient_quota は 429 でも)。ふつうの 429 は一時的なまま", () => {
    const anthropic = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, undefined, headers);
    expect(isTransientApiError(anthropic)).toBe(false);
    const quota = OpenAI.APIError.generate(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }, undefined, headers);
    expect(isTransientApiError(quota)).toBe(false);
    const rate = OpenAI.APIError.generate(429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, undefined, headers);
    expect(isTransientApiError(rate)).toBe(true);
  });
});
