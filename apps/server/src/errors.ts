import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { ErrorBody } from "@untie/api";

/** `{ error: { code, message } }` で返すエラー。メッセージは画面にそのまま出せる日本語 */
export class ApiFailure extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "invalid_request") => new ApiFailure(400, code, message);
export const unauthorized = (message = "ログインしてください", code = "unauthenticated") => new ApiFailure(401, code, message);
export const forbidden = (message = "この操作をする権限がありません", code = "forbidden") => new ApiFailure(403, code, message);
export const notFound = (message = "見つかりません", code = "not_found") => new ApiFailure(404, code, message);
export const conflict = (message: string, code = "conflict") => new ApiFailure(409, code, message);

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

const STATUS_MESSAGES: Record<number, [string, string]> = {
  400: ["invalid_request", "リクエストの形が正しくありません"],
  401: ["unauthenticated", "ログインしてください"],
  403: ["forbidden", "この操作をする権限がありません"],
  404: ["not_found", "見つかりません"],
  405: ["method_not_allowed", "このメソッドは使えません"],
  413: ["too_large", "リクエストが大きすぎます"],
};

/** zod の失敗を、画面に出せる 1 行にする */
export function describeZodError(error: ZodError): string {
  const lines = error.issues.slice(0, 3).map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  return `リクエストの形が正しくありません (${lines.join(" / ")})`;
}

/** 認証の画面遷移 (ブラウザが直接開く) のエラーは JSON ではなく HTML で返す */
const HTML_ERROR_PATHS = new Set(["/auth/login", "/auth/callback", "/auth/dev"]);

export function errorPage(message: string): string {
  const escaped = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untie</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">ログインできませんでした</h1><p>${escaped}</p><p><a href="/">Untie に戻る</a></p></body></html>`;
}

/** app.onError に渡す。想定外の例外は内容をログにだけ出し、画面には汎用の文言を返す */
export function handleError(error: Error, c: Context): Response {
  let status: ContentfulStatusCode = 500;
  let code = "internal";
  let message = "サーバーでエラーが起きました";
  if (error instanceof ApiFailure) {
    ({ status, code, message } = error);
  } else if (error instanceof ZodError) {
    status = 400;
    code = "invalid_request";
    message = describeZodError(error);
  } else if (error instanceof HTTPException) {
    status = error.status as ContentfulStatusCode;
    [code, message] = STATUS_MESSAGES[error.status] ?? ["error", message];
  } else {
    // トークン・チケット・メールの本文を出さないよう、メッセージだけをログに残す
    console.error("想定外のエラー", error.message);
  }
  if (HTML_ERROR_PATHS.has(new URL(c.req.url).pathname)) return c.html(errorPage(message), status);
  return c.json(errorBody(code, message), status);
}
