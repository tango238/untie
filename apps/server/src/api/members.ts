// メンバーの追加・役割の変更・削除と、所有者の譲渡 (設計書 3.2・7.4)。変えたあとは kickRoomQuietly でその人の接続を切る
import { Hono } from "hono";
import { PutMemberRequestSchema, TransferRequestSchema, can } from "@untie/api";
import type { AppEnv } from "../env";
import { getFileForUser, toSummary } from "../db/files";
import { getMember, putMemberRole, removeMember, toMember, transferOwner } from "../db/members";
import { getUserById } from "../db/users";
import { conflict, forbidden, notFound } from "../errors";
import { kickRoomQuietly } from "../rooms";
import { assertNotInTrash, requireRole } from "./authz";
import { limitBody, parseBody } from "./body";

export const memberRoutes = new Hono<AppEnv>();

// 足す・役割を変える。相手がユーザーでなければ 404 (招待を使う)。owner の役割は変えられない (譲渡を使う)
memberRoutes.put("/:id/members/:userId", limitBody, async (c) => {
  const file = await requireRole(c, c.req.param("id"), "manageMembers");
  assertNotInTrash(file);
  const userId = c.req.param("userId");
  const { role } = await parseBody(c, PutMemberRequestSchema);
  if (!(await getUserById(c.env.DB, userId))) throw notFound("そのユーザーはまだ Untie に登録されていません。招待してください", "user_not_found");
  if (userId === file.owner_id) throw conflict("所有者の役割は変えられません。所有者を譲ってください", "owner_role_fixed");
  const { previous } = await putMemberRole(c.env.DB, { fileId: file.id, userId, role, addedBy: c.var.user.id, now: Date.now() });
  // すでに行があったときは、役割が同じでも切る (前の呼び出しで kick に失敗していても、再試行で切れる)。新しく足しただけなら接続は無い
  if (previous !== null) await kickRoomQuietly(c.env, file.id, { userId, reason: "roleChanged" });
  return c.json(toMember((await getMember(c.env.DB, file.id, userId))!));
});

// 外す。owner は誰でも (自分以外)、editor / viewer は自分だけ
memberRoutes.delete("/:id/members/:userId", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "read");
  assertNotInTrash(file);
  const userId = c.req.param("userId");
  const self = userId === c.var.user.id;
  if (file.role === "owner") {
    if (userId === file.owner_id) throw conflict("所有者はメンバーから外せません。先に所有者を譲ってください", "transfer_first");
  } else if (!self || !can(file.role, "leave")) {
    throw forbidden();
  }
  const member = await getMember(c.env.DB, file.id, userId);
  if (member) await removeMember(c.env.DB, file.id, userId);
  // 外し済みの人への再試行でも切る (前の呼び出しで kick に失敗していて、接続が残っているかもしれない)
  await kickRoomQuietly(c.env, file.id, { userId, reason: "removed" });
  if (!member) throw notFound("そのメンバーはいません", "member_not_found");
  return c.body(null, 204);
});

// 所有者を譲る。相手はすでにメンバーの人。元の所有者は editor になる
memberRoutes.post("/:id/transfer", limitBody, async (c) => {
  const file = await requireRole(c, c.req.param("id"), "transfer");
  assertNotInTrash(file);
  const { userId } = await parseBody(c, TransferRequestSchema);
  if (userId === file.owner_id) throw conflict("すでにあなたが所有者です", "already_owner");
  if (!(await getMember(c.env.DB, file.id, userId))) throw notFound("そのメンバーはいません。先にメンバーにしてください", "member_not_found");
  // 確かめた直後に相手が抜けた・別の譲渡が通った、というときは何も書かれず false
  if (!(await transferOwner(c.env.DB, file.id, file.owner_id, userId))) {
    throw conflict("所有者を譲れませんでした。ほかの操作と重なった可能性があります。もう一度試してください");
  }
  // 両者の役割が変わるので、どちらの接続も切る
  await kickRoomQuietly(c.env, file.id, { userId, reason: "roleChanged" });
  await kickRoomQuietly(c.env, file.id, { userId: file.owner_id, reason: "roleChanged" });
  return c.json(toSummary((await getFileForUser(c.env.DB, file.id, c.var.user.id))!));
});
