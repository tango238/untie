import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { ZodType } from "zod";
import type { AppEnv } from "../env";
import { badRequest, errorBody } from "../errors";

/**
 * リクエスト本文の上限。モデルは 1 MB まで (設計書 3.4)。Durable Object の 1 つの値には上限があり、
 * 取り込んだ JSON が大きいと保存できないため、入口で断る
 */
export const MAX_BODY_BYTES = 1024 * 1024;
export const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(errorBody("too_large", "リクエストが大きすぎます (1 MB まで)"), 413),
});

/** JSON の本文を zod で検める。JSON でない・形が違うときは 400 */
export async function parseBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest("リクエストの本文が JSON ではありません");
  }
  return schema.parse(json);
}

/** 本文が無くてもよい API 用。空の本文は `{}` として検める (形が違う・JSON でないなら 400) */
export async function parseOptionalBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const text = await c.req.text();
  if (text.trim() === "") return schema.parse({});
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest("リクエストの本文が JSON ではありません");
  }
  return schema.parse(json);
}
