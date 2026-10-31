// 招待 (設計書 3.1・3.3・7.4)。トークンは D1 に SHA-256 だけを置く。メールの送信はせず、画面から写して送る
import { Hono } from "hono";
import type { Context } from "hono";
import { CreateInvitationRequestSchema } from "@untie/api";
import type { AcceptInvitationResponse, CreateInvitationResponse, InvitationInfo } from "@untie/api";
import type { AppEnv } from "../env";
import { generateToken, sha256Hex } from "../auth/crypto";
import { isEmailAllowed } from "../auth/allowed";
import { appOrigin } from "../auth/session";
import { acceptInvitation, deleteInvitation, getInvitationDetail, replaceInvitation } from "../db/invitations";
import { getMember, putMemberRole } from "../db/members";
import { getUserByEmail } from "../db/users";
import { ApiFailure, badRequest, conflict, forbidden, notFound } from "../errors";
import { kickRoomQuietly } from "../rooms";
import { assertNotInTrash, requireRole } from "./authz";
import { limitBody, parseBody } from "./body";
import { readToken } from "./token";

/** 所有者がファイルの下で使う API (/api/files/:id/invitations) */
export const invitationRoutes = new Hono<AppEnv>();

// メールで招待する。すでにユーザーならその場でメンバーに、そうでなければ招待を作ってリンクを返す
invitationRoutes.post("/:id/invitations", limitBody, async (c) => {
  const file = await requireRole(c, c.req.param("id"), "manageMembers");
  assertNotInTrash(file);
  const { email, role } = await parseBody(c, CreateInvitationRequestSchema);
  // ログインできないドメインへの招待は、受けられないので作らない
  if (!isEmailAllowed(c.env, email)) throw badRequest("このメールアドレスのドメインは招待できません", "email_not_allowed");
  if (email === c.var.user.email) throw conflict("自分自身は招待できません (あなたが所有者です)", "already_owner");

  const user = await getUserByEmail(c.env.DB, email);
  const now = Date.now();
  if (user) {
    if (user.id === file.owner_id) throw conflict("そのユーザーはこのファイルの所有者です", "already_owner");
    const { previous } = await putMemberRole(c.env.DB, { fileId: file.id, userId: user.id, role, addedBy: c.var.user.id, now });
    // (putMemberRole が、そのメール宛の未承諾の招待も同じ batch で消す)。行があったときは役割が同じでも切る
    if (previous !== null) await kickRoomQuietly(c.env, file.id, { userId: user.id, reason: "roleChanged" });
    return c.json({ kind: "member", userId: user.id } satisfies CreateInvitationResponse);
  }

  const token = generateToken();
  const id = await sha256Hex(token);
  await replaceInvitation(c.env.DB, { id, fileId: file.id, email, role, createdBy: c.var.user.id, now });
  return c.json({ kind: "invitation", invitationId: id, url: `${appOrigin(c)}/#/invite/${token}` } satisfies CreateInvitationResponse, 201);
});

// 取り消す
invitationRoutes.delete("/:id/invitations/:invitationId", async (c) => {
  const file = await requireRole(c, c.req.param("id"), "manageMembers");
  assertNotInTrash(file);
  if (!(await deleteInvitation(c.env.DB, file.id, c.req.param("invitationId")))) throw notFound("招待が見つかりません", "invitation_not_found");
  return c.body(null, 204);
});

/** 招待を受ける側の API (/api/invitations/*)。ログインが要る。トークンはパスではなく X-Untie-Token ヘッダーで受ける (パスは Workers のログに残るため) */
export const invitationTokenRoutes = new Hono<AppEnv>();

/** トークンから招待を引き、ログイン中のメールと一致することを確かめる。無ければ 404、メールが違えば 403 */
async function findInvitationFor(c: Context<AppEnv>) {
  const invitation = await getInvitationDetail(c.env.DB, await sha256Hex(readToken(c)));
  if (!invitation) throw notFound("招待が見つかりません。取り消されたか、リンクが正しくありません", "invitation_not_found");
  if (invitation.email !== c.var.user.email) {
    throw forbidden("この招待は別のメールアドレス宛です。招待されたアカウントでログインしてください", "email_mismatch");
  }
  return invitation;
}

// 招待の中身 (受ける画面に出す)
invitationTokenRoutes.get("/info", async (c) => {
  const invitation = await findInvitationFor(c);
  return c.json({
    fileName: invitation.file_name,
    role: invitation.role,
    email: invitation.email,
    inviterName: invitation.inviter_name,
    expired: invitation.expires_at <= Date.now(),
  } satisfies InvitationInfo);
});

// 受ける。メールが一致するときだけ。すでにメンバーなら役割は変えない。受け終わった招待をもう一度受けても同じ結果 (冪等)
invitationTokenRoutes.post("/accept", async (c) => {
  const invitation = await findInvitationFor(c);
  const now = Date.now();
  if (invitation.accepted_at !== null) {
    // 外された人が古い招待で戻れてはいけないので、いまもメンバーのときだけ冪等にする
    if (!(await getMember(c.env.DB, invitation.file_id, c.var.user.id))) throw new ApiFailure(410, "invitation_used", "この招待はすでに使われています。もう一度招待してもらってください");
  } else {
    if (invitation.expires_at <= now) throw new ApiFailure(410, "invitation_expired", "招待の期限が切れています。もう一度招待してもらってください");
    await acceptInvitation(c.env.DB, invitation, c.var.user.id, now);
  }
  return c.json({ fileId: invitation.file_id } satisfies AcceptInvitationResponse);
});
