import type { Member } from "@untie/api";
import type { MemberRow } from "./types";

export function toMember(row: MemberRow): Member {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
  };
}

/** メンバー一覧 (所有者が先、あとは追加順) */
export async function listMembers(db: D1Database, fileId: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(
      `select m.user_id, u.email, u.name, u.avatar_url, m.role
       from file_members m join users u on u.id = m.user_id
       where m.file_id = ?
       order by case m.role when 'owner' then 0 else 1 end, m.added_at, m.user_id`,
    )
    .bind(fileId)
    .all<MemberRow>();
  return results;
}
