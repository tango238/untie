import { Hono } from "hono";
import { emptyModel, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { CreateFileRequestSchema, RenameFileRequestSchema } from "@untie/api";
import type { FileDetail, FilesResponse, PresenceResponse, TicketResponse, TrashResponse } from "@untie/api";
import { issueTicket } from "../auth/ticket";
import type { AppEnv } from "../env";
import { deleteFileRows, getFileForUser, listFiles, listTrash, renameFile, setDeletedAt, toSummary } from "../db/files";
import { listPendingInvitations, toInvitation } from "../db/invitations";
import { isLinkEnabled } from "../db/links";
import { listMembers, toMember } from "../db/members";
import { badRequest, conflict } from "../errors";
import { destroyRoom, exportRoomModel, kickRoom, presenceRoom, renameRoom } from "../rooms";
import { requireRole } from "./authz";
import { limitBody, parseBody } from "./body";
import { createFile, duplicateFile } from "./createFile";
import { exportResponse } from "./exportResponse";
import { invitationRoutes } from "./invitations";
import { linkManageRoutes } from "./links";
import { memberRoutes } from "./members";

export const fileRoutes = new Hono<AppEnv>();

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

// 1 件の情報。メンバー・招待・リンクの状態は owner だけ (リンクの URL はトークンを持たないので返さない。3.6)
fileRoutes.get("/:id", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "read");
  const detail: FileDetail = toSummary(file);
  if (file.role === "owner") {
    const [members, invitations, enabled] = await Promise.all([
      listMembers(c.env.DB, file.id),
      listPendingInvitations(c.env.DB, file.id),
      isLinkEnabled(c.env.DB, file.id),
    ]);
    detail.members = members.map(toMember);
    detail.invitations = invitations.map(toInvitation);
    detail.link = { enabled };
  }
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
  return c.json(await duplicateFile(c, file.id), 201);
});

// JSON に書き出す
fileRoutes.get("/:id/export", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "export");
  const model = await exportRoomModel(c.env, file.id);
  return exportResponse(model);
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

// いまルームにつながっている人。画面が awareness (自己申告) の userId・名前をこれと照らして、偽りを表示から外す。
// メンバーなら読める (ゴミ箱の中のファイルは、チケットと同じく owner 以外は 404、owner には 409)
fileRoutes.get("/:id/presence", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "read");
  if (file.deleted_at !== null) throw conflict("ゴミ箱の中のファイルは開けません。先に戻してください", "in_trash");
  return c.json({ presence: await presenceRoom(c.env, file.id) } satisfies PresenceResponse);
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

// 共有 (メンバー・譲渡・招待・リンク閲覧の管理)。どれも /:id の下
fileRoutes.route("/", memberRoutes);
fileRoutes.route("/", invitationRoutes);
fileRoutes.route("/", linkManageRoutes);
