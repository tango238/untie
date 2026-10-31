// リンクを知っている人の閲覧 (設計書 3.6)。トークンは D1 にハッシュ (files.link_token) だけを置く
import { Hono } from "hono";
import type { Context } from "hono";
import { PutLinkRequestSchema } from "@untie/api";
import type { LinkInfo, LinkResponse, PresenceResponse, Role, TicketResponse } from "@untie/api";
import type { AppEnv } from "../env";
import { generateToken, sha256Hex } from "../auth/crypto";
import { appOrigin, optionalUser, requireSession } from "../auth/session";
import { issueTicket } from "../auth/ticket";
import { getFileByLink, getMemberRole, setLinkToken, setLinkTokenIfNone } from "../db/links";
import type { LinkedFile } from "../db/links";
import type { UserRow } from "../db/types";
import { notFound } from "../errors";
import { exportRoomModel, kickRoomQuietly, presenceRoom } from "../rooms";
import { assertNotInTrash, requireRole } from "./authz";
import { duplicateFile } from "./createFile";
import { exportResponse } from "./exportResponse";
import { limitBody, parseOptionalBody } from "./body";
import { readToken } from "./token";

/** 所有者がファイルの下で使う API (/api/files/:id/link) */
export const linkManageRoutes = new Hono<AppEnv>();

// 有効にする。トークンが無ければ新しく作る。regenerate なら作り直す (前のリンクで入っている接続を切る)。
// すでに有効で regenerate でなければ何も変えず、url も返さない (トークンは平文で持たない)。
// 無いときだけ書く update なので、同時に有効にされても先のトークンを壊さない (負けた側は url を返さない)
linkManageRoutes.put("/:id/link", limitBody, async (c) => {
  const file = await requireRole(c, c.req.param("id"), "manageLink");
  assertNotInTrash(file);
  const { regenerate } = await parseOptionalBody(c, PutLinkRequestSchema);
  const token = generateToken();
  const hash = await sha256Hex(token);
  if (regenerate) {
    await setLinkToken(c.env.DB, file.id, hash);
    await kickRoomQuietly(c.env, file.id, { via: "link" });
  } else if (!(await setLinkTokenIfNone(c.env.DB, file.id, hash))) {
    return c.json({ enabled: true } satisfies LinkResponse);
  }
  return c.json({ enabled: true, url: `${appOrigin(c)}/#/link/${token}` } satisfies LinkResponse);
});

// 無効にする。リンクで入っている接続は切る
linkManageRoutes.delete("/:id/link", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "manageLink");
  assertNotInTrash(file);
  await setLinkToken(c.env.DB, file.id, null);
  await kickRoomQuietly(c.env, file.id, { via: "link" });
  return c.body(null, 204);
});

/**
 * /api/links/*。複製以外は**セッションを要求しない** (requireSession の外に置く)。ログインしていればメンバーとして扱う。
 * トークンはパスではなく X-Untie-Token ヘッダーで受ける (パスは Workers のログに残るため)
 */
export const linkRoutes = new Hono<AppEnv>();

// トークンは URL に出るので、応答をキャッシュさせない
linkRoutes.use("*", async (c, next) => {
  // 先に付ける: 404 などのエラー応答にも付く
  c.header("Cache-Control", "no-store");
  await next();
});

/** トークンで引いたファイルと、見ている人の役割。ログインしていてメンバーならその役割、それ以外は guest。無効なトークン・ゴミ箱の中は 404 */
async function resolveLink(c: Context<AppEnv>): Promise<{ file: LinkedFile; user: UserRow | null; role: Role }> {
  const file = await getFileByLink(c.env.DB, await sha256Hex(readToken(c)));
  if (!file) throw notFound("このリンクは無効です", "link_not_found");
  const user = await optionalUser(c);
  const role: Role = (user ? await getMemberRole(c.env.DB, file.id, user.id) : null) ?? "guest";
  return { file, user, role };
}

linkRoutes.get("/info", async (c) => {
  const { file, role } = await resolveLink(c);
  return c.json({ fileId: file.id, name: file.name, role } satisfies LinkInfo);
});

// ルームに接続するチケット。メンバーならその役割と userId、それ以外は userId なしのゲスト (名前はルームが「ゲスト N」に振り直す)
linkRoutes.post("/ticket", async (c) => {
  const { file, user, role } = await resolveLink(c);
  const member = user !== null && role !== "guest";
  const { ticket, expiresAt } = await issueTicket(c.env, {
    fileId: file.id,
    userId: member ? user.id : null,
    name: member ? user.name || user.email.split("@")[0] : "ゲスト",
    role,
    via: "link",
  });
  return c.json({ ticket, role, expiresAt } satisfies TicketResponse);
});

// いまルームにつながっている人 (files の presence と同じ。ゲストも読める)
linkRoutes.get("/presence", async (c) => {
  const { file } = await resolveLink(c);
  return c.json({ presence: await presenceRoom(c.env, file.id) } satisfies PresenceResponse);
});

linkRoutes.get("/export", async (c) => {
  const { file } = await resolveLink(c);
  return exportResponse(await exportRoomModel(c.env, file.id));
});

// 複製して自分の owner のファイルにする (ゲストは「複製するにはログイン」)。ここだけセッションが要る。メンバーでなくてもよい
linkRoutes.post("/duplicate", requireSession, async (c) => {
  const { file } = await resolveLink(c);
  return c.json(await duplicateFile(c, file.id), 201);
});
