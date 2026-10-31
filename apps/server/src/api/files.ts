import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { ZodType } from "zod";
import { emptyModel, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { CreateFileRequestSchema, RenameFileRequestSchema } from "@untie/api";
import type { FileDetail, FilesResponse, TicketResponse, TrashResponse } from "@untie/api";
import { issueTicket } from "../auth/ticket";
import type { AppEnv } from "../env";
import { deleteFileRows, getFileForUser, insertFile, listFiles, listTrash, renameFile, setDeletedAt, toSummary } from "../db/files";
import { newFileId } from "../db/ids";
import { listMembers, toMember } from "../db/members";
import { badRequest, conflict, errorBody } from "../errors";
import { destroyRoom, exportRoomModel, importRoomModel, kickRoom, renameRoom } from "../rooms";
import { requireRole } from "./authz";

export const fileRoutes = new Hono<AppEnv>();

/** リクエスト本文の上限 (モデルは数百 KB まで。取り込みの JSON が大きすぎるものを入口で断る) */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(errorBody("too_large", "リクエストが大きすぎます (2 MB まで)"), 413),
});

/** JSON の本文を zod で検める。JSON でない・形が違うときは 400 */
async function parseBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest("リクエストの本文が JSON ではありません");
  }
  return schema.parse(json);
}

/** 書き出した JSON の整形 (ui の serializeModel と同じ: 2 スペース + 末尾の改行) */
export function serialize(model: UntieModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/** RFC 5987 の attr-char 以外をパーセントエンコードする */
function encodeRfc5987(text: string): string {
  return encodeURIComponent(text).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** ファイル名に使えない文字を置き換える */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100);
  return `${cleaned || "untie"}.json`;
}

/** 行を作り、ルームに取り込む。取り込みに失敗したら行を消して元に戻す */
async function createFile(c: Context<AppEnv>, model: UntieModel) {
  const id = newFileId();
  const now = Date.now();
  const name = model.meta.name;
  await insertFile(c.env.DB, { id, name, ownerId: c.var.user.id, now });
  try {
    await importRoomModel(c.env, id, model);
  } catch (e) {
    // ルームに一部でも書かれていたら消してから、行を消す。後始末の失敗は元の例外を隠さない
    await destroyRoom(c.env, id).catch(() => {});
    await deleteFileRows(c.env.DB, id);
    throw e;
  }
  const row = await getFileForUser(c.env.DB, id, c.var.user.id);
  return toSummary(row!);
}

// 自分のファイルと共有されたファイル
fileRoutes.get("/", async (c) => {
  const { mine, shared } = await listFiles(c.env.DB, c.var.user.id);
  return c.json({ mine: mine.map(toSummary), shared: shared.map(toSummary) } satisfies FilesResponse);
});

// 作る。{ name } で空のモデル、{ model } で JSON を取り込む
fileRoutes.post("/", limitBody, async (c) => {
  const body = await parseBody(c, CreateFileRequestSchema);
  let model: UntieModel;
  if ("name" in body) {
    model = emptyModel(body.name);
  } else {
    const result = validateModel(body.model);
    if (!result.ok) {
      const shown = result.errors.slice(0, 3).join(" / ");
      throw badRequest(`モデルの形が正しくありません: ${shown}${result.errors.length > 3 ? ` ほか ${result.errors.length - 3} 件` : ""}`, "invalid_model");
    }
    model = result.model;
  }
  return c.json(await createFile(c, model), 201);
});

// ゴミ箱の一覧 (/:id より先に置く)
fileRoutes.get("/trash", async (c) => {
  const rows = await listTrash(c.env.DB, c.var.user.id);
  return c.json({ files: rows.map(toSummary) } satisfies TrashResponse);
});

// 1 件の情報。メンバー一覧は owner だけ
fileRoutes.get("/:id", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "read");
  const detail: FileDetail = toSummary(file);
  if (file.role === "owner") detail.members = (await listMembers(c.env.DB, file.id)).map(toMember);
  return c.json(detail);
});

// 名前を変える (ルームの meta.name と D1 の両方)
fileRoutes.patch("/:id", limitBody, async (c) => {
  const file = await requireRole(c, c.req.param("id"), "rename");
  const { name } = await parseBody(c, RenameFileRequestSchema);
  await renameRoom(c.env, file.id, name);
  await renameFile(c.env.DB, file.id, name, Date.now());
  return c.json(toSummary((await getFileForUser(c.env.DB, file.id, c.var.user.id))!));
});

// 複製して自分の owner のファイルにする
fileRoutes.post("/:id/duplicate", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "duplicate");
  const model = await exportRoomModel(c.env, file.id);
  // 壊れた中身を新しいファイルに写さない (500 ではなく画面に出せる 409 で返す)
  if (!validateModel(model).ok) throw conflict("ファイルの中身が壊れているため複製できません", "broken_model");
  const copy: UntieModel = { ...model, meta: { ...model.meta, name: `${model.meta.name} のコピー`.slice(0, 200) } };
  return c.json(await createFile(c, copy), 201);
});

// JSON に書き出す
fileRoutes.get("/:id/export", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "export");
  const model = await exportRoomModel(c.env, file.id);
  const filename = safeFilename(model.meta.name);
  return new Response(serialize(model), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="untie.json"; filename*=UTF-8''${encodeRfc5987(filename)}`,
      "Cache-Control": "no-store",
    },
  });
});

// ルームに接続するチケット (60 秒だけ有効。設計書 7.5)。ゴミ箱の中のファイルは owner 以外は 404 (requireRole)、owner には 409
fileRoutes.post("/:id/ticket", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "read");
  if (file.deleted_at !== null) throw conflict("ゴミ箱の中のファイルは開けません。先に戻してください", "in_trash");
  const user = c.var.user;
  const { ticket, expiresAt } = await issueTicket(c.env, {
    fileId: file.id,
    userId: user.id,
    // 表示名が空なら、メールアドレスの @ より前 (メールアドレスそのものは他のメンバーに見せない)
    name: user.name || user.email.split("@")[0],
    role: file.role,
    via: "member",
  });
  return c.json({ ticket, role: file.role, expiresAt } satisfies TicketResponse);
});

// ゴミ箱へ
fileRoutes.delete("/:id", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "delete");
  if (file.deleted_at === null) await setDeletedAt(c.env.DB, file.id, Date.now());
  // つながっている人を全員外す (つなぎ直しは、チケットの取得が 404 / 409 になる)
  await kickRoom(c.env, file.id, { all: true });
  return c.body(null, 204);
});

// ゴミ箱から戻す
fileRoutes.post("/:id/restore", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "delete");
  if (file.deleted_at !== null) await setDeletedAt(c.env.DB, file.id, null);
  return c.json(toSummary((await getFileForUser(c.env.DB, file.id, c.var.user.id))!));
});

// 完全に消す (ゴミ箱の中のファイルだけ)
fileRoutes.delete("/:id/purge", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "delete");
  if (file.deleted_at === null) throw conflict("先にゴミ箱に入れてください", "not_in_trash");
  await destroyRoom(c.env, file.id);
  await deleteFileRows(c.env.DB, file.id);
  return c.body(null, 204);
});

