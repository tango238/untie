import type { FileSummary } from "@untie/api";
import type { FileRow } from "./types";

/** 見ている人 (?1) の役割付きで files を引く共通部分 */
const SELECT_FILE = `
  select f.id, f.name, f.owner_id, o.name as owner_name, m.role,
         (select count(*) from file_members c where c.file_id = f.id) as member_count,
         f.created_at, f.updated_at, f.deleted_at
  from file_members m
  join files f on f.id = m.file_id
  join users o on o.id = f.owner_id`;

export function toSummary(row: FileRow): FileSummary {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    role: row.role,
    memberCount: row.member_count,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
  };
}

/** ファイルと所有者のメンバー行を 1 回で作る */
export async function insertFile(db: D1Database, f: { id: string; name: string; ownerId: string; now: number }): Promise<void> {
  await db.batch([
    db.prepare("insert into files (id, name, owner_id, created_at, updated_at) values (?, ?, ?, ?, ?)").bind(f.id, f.name, f.ownerId, f.now, f.now),
    db
      .prepare("insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, 'owner', ?, ?)")
      .bind(f.id, f.ownerId, f.ownerId, f.now),
  ]);
}

/** 行を消す (完全削除。invitations・file_members・files)。ルームの destroy は呼び出し側 */
export async function deleteFileRows(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("delete from invitations where file_id = ?").bind(id),
    db.prepare("delete from file_members where file_id = ?").bind(id),
    db.prepare("delete from files where id = ?").bind(id),
  ]);
}

/** 自分が所有するファイル (mine) と、共有されたファイル (shared)。ゴミ箱の中は含めない */
export async function listFiles(db: D1Database, userId: string): Promise<{ mine: FileRow[]; shared: FileRow[] }> {
  const { results } = await db
    .prepare(`${SELECT_FILE} where m.user_id = ? and f.deleted_at is null order by f.updated_at desc, f.id`)
    .bind(userId)
    .all<FileRow>();
  return { mine: results.filter((r) => r.role === "owner"), shared: results.filter((r) => r.role !== "owner") };
}

/** 自分が所有するゴミ箱の中のファイル (消した日の新しい順) */
export async function listTrash(db: D1Database, userId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare(`${SELECT_FILE} where m.user_id = ? and m.role = 'owner' and f.deleted_at is not null order by f.deleted_at desc, f.id`)
    .bind(userId)
    .all<FileRow>();
  return results;
}

/** そのユーザーから見たファイル (メンバーでなければ null)。ゴミ箱の中のものも返すので、呼び出し側が扱いを決める */
export async function getFileForUser(db: D1Database, fileId: string, userId: string): Promise<FileRow | null> {
  return db.prepare(`${SELECT_FILE} where f.id = ? and m.user_id = ?`).bind(fileId, userId).first<FileRow>();
}

export async function renameFile(db: D1Database, id: string, name: string, now: number): Promise<void> {
  await db.prepare("update files set name = ?, updated_at = ? where id = ?").bind(name, now, id).run();
}

/** ゴミ箱に入れる (deletedAt = 日時)・戻す (null) */
export async function setDeletedAt(db: D1Database, id: string, deletedAt: number | null): Promise<void> {
  await db.prepare("update files set deleted_at = ? where id = ?").bind(deletedAt, id).run();
}

/** deleted_at が cutoff より前のファイルの id (古いものから limit 件まで) */
export async function listExpiredTrash(db: D1Database, cutoff: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("select id from files where deleted_at is not null and deleted_at < ? order by deleted_at limit ?")
    .bind(cutoff, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
