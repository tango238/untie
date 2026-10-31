import type { Member, MemberRole } from "@untie/api";
import type { MemberRow } from "./types";

export function toMember(row: MemberRow): Member {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    addedAt: row.added_at,
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
  };
}

const SELECT_MEMBER = `
  select m.user_id, u.email, u.name, u.avatar_url, m.role, m.added_at
  from file_members m join users u on u.id = m.user_id`;

/** メンバー一覧 (所有者が先、あとは追加順) */
export async function listMembers(db: D1Database, fileId: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(`${SELECT_MEMBER} where m.file_id = ? order by case m.role when 'owner' then 0 else 1 end, m.added_at, m.user_id`)
    .bind(fileId)
    .all<MemberRow>();
  return results;
}

/** そのファイルのメンバー 1 人 (メンバーでなければ null) */
export async function getMember(db: D1Database, fileId: string, userId: string): Promise<MemberRow | null> {
  return db.prepare(`${SELECT_MEMBER} where m.file_id = ? and m.user_id = ?`).bind(fileId, userId).first<MemberRow>();
}

/** そのユーザーのメール宛の、このファイルの未承諾の招待を消す SQL (外した・足したあとに、古い招待で戻れないように batch へ入れる) */
const DELETE_PENDING_INVITATIONS_OF_USER =
  "delete from invitations where file_id = ? and accepted_at is null and email = (select email from users where id = ?)";

/**
 * editor / viewer として足す。すでにメンバーなら役割を `role` に変える (owner の行は触らない)。
 * 変える前の役割の取得・upsert・そのメール宛の未承諾の招待の削除を 1 つの batch で行う。
 * 返す previous は変える前の役割 (新しく足したなら null)。行があったとき (役割が同じでも) 呼び出し側は kick する
 */
export async function putMemberRole(
  db: D1Database,
  m: { fileId: string; userId: string; role: Exclude<MemberRole, "owner">; addedBy: string; now: number },
): Promise<{ previous: MemberRole | null }> {
  const [before] = await db.batch<{ role: MemberRole }>([
    db.prepare("select role from file_members where file_id = ? and user_id = ?").bind(m.fileId, m.userId),
    db
      .prepare(
        `insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)
         on conflict (file_id, user_id) do update set role = excluded.role where file_members.role != 'owner'`,
      )
      .bind(m.fileId, m.userId, m.role, m.addedBy, m.now),
    db.prepare(DELETE_PENDING_INVITATIONS_OF_USER).bind(m.fileId, m.userId),
  ]);
  return { previous: before.results[0]?.role ?? null };
}

/** メンバーから外す (owner の行は消さない)。そのメール宛の未承諾の招待も同じ batch で消す */
export async function removeMember(db: D1Database, fileId: string, userId: string): Promise<void> {
  await db.batch([
    db.prepare("delete from file_members where file_id = ? and user_id = ? and role != 'owner'").bind(fileId, userId),
    db.prepare(DELETE_PENDING_INVITATIONS_OF_USER).bind(fileId, userId),
  ]);
}

/**
 * 所有者を譲る。files.owner_id と両者の file_members.role を 1 つの batch (= 1 トランザクション) で書き換える。
 * 元の所有者は editor になる。どの update も「いま from が owner で、to がメンバー」という条件を付けてあり、
 * 並行して別の譲渡や削除が先に通っていれば 1 行も変えずに false を返す (呼び出し側は 409 にする)
 */
export async function transferOwner(db: D1Database, fileId: string, fromUserId: string, toUserId: string): Promise<boolean> {
  const [owner] = await db.batch([
    db
      .prepare(
        `update files set owner_id = ?3 where id = ?1 and owner_id = ?2
         and exists (select 1 from file_members where file_id = ?1 and user_id = ?3)`,
      )
      .bind(fileId, fromUserId, toUserId),
    db
      .prepare(
        `update file_members set role = 'owner' where file_id = ?1 and user_id = ?3 and role != 'owner'
         and exists (select 1 from files where id = ?1 and owner_id = ?3)`,
      )
      .bind(fileId, fromUserId, toUserId),
    db
      .prepare(
        `update file_members set role = 'editor' where file_id = ?1 and user_id = ?2 and role = 'owner'
         and exists (select 1 from files where id = ?1 and owner_id = ?3)`,
      )
      .bind(fileId, fromUserId, toUserId),
  ]);
  return owner.meta.changes > 0;
}
