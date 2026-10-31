import type { Invitation } from "@untie/api";
import type { InvitationRow } from "./types";

/** 招待の有効期間 (設計書 3.3: 14 日) */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function toInvitation(row: InvitationRow): Invitation {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at };
}

/** まだ受けられていない招待 (期限切れも含む。所有者が取り消す・出し直すため)。古い順 */
export async function listPendingInvitations(db: D1Database, fileId: string): Promise<InvitationRow[]> {
  const { results } = await db
    .prepare("select * from invitations where file_id = ? and accepted_at is null order by created_at, id")
    .bind(fileId)
    .all<InvitationRow>();
  return results;
}

/**
 * 招待を作る。同じファイル・同じメールの未承諾の招待は 1 つの batch で消して置き換える。
 * id はトークンの SHA-256 (トークン自体は保存しない)
 */
export async function replaceInvitation(
  db: D1Database,
  i: { id: string; fileId: string; email: string; role: "editor" | "viewer"; createdBy: string; now: number },
): Promise<void> {
  await db.batch([
    db.prepare("delete from invitations where file_id = ? and email = ? and accepted_at is null").bind(i.fileId, i.email),
    db
      .prepare("insert into invitations (id, file_id, email, role, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(i.id, i.fileId, i.email, i.role, i.createdBy, i.now, i.now + INVITATION_TTL_MS),
  ]);
}

/** 取り消す。消えたら true (そのファイルの招待でなければ false) */
export async function deleteInvitation(db: D1Database, fileId: string, invitationId: string): Promise<boolean> {
  const result = await db.prepare("delete from invitations where id = ? and file_id = ?").bind(invitationId, fileId).run();
  return result.meta.changes > 0;
}

/** 招待を受ける画面に出す中身 (トークンの SHA-256 で引く)。ゴミ箱の中のファイルの招待は無いものとして扱う */
export interface InvitationDetail extends InvitationRow {
  file_name: string;
  inviter_name: string;
}

export async function getInvitationDetail(db: D1Database, id: string): Promise<InvitationDetail | null> {
  return db
    .prepare(
      `select i.*, f.name as file_name, coalesce(nullif(u.name, ''), u.email) as inviter_name
       from invitations i
       join files f on f.id = i.file_id and f.deleted_at is null
       join users u on u.id = i.created_by
       where i.id = ?`,
    )
    .bind(id)
    .first<InvitationDetail>();
}

/**
 * 受ける。メンバーに足し (すでにメンバーなら役割を変えない)、accepted_at を書く。1 つの batch。
 * 招待者が消えていても足せるよう added_by は招待者の id をそのまま入れる (users への外部キーは招待の作成時に満たしている)
 */
export async function acceptInvitation(db: D1Database, invitation: InvitationRow, userId: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare("insert or ignore into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)")
      .bind(invitation.file_id, userId, invitation.role, invitation.created_by, now),
    db.prepare("update invitations set accepted_at = ? where id = ? and accepted_at is null").bind(now, invitation.id),
  ]);
}
