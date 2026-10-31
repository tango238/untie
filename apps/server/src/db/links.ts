import type { Role } from "@untie/api";

/** リンクで引いたファイル。ゴミ箱の中のものは返さない */
export interface LinkedFile {
  id: string;
  name: string;
}

/** トークンの SHA-256 で、リンクが有効な (ゴミ箱の外の) ファイルを引く */
export async function getFileByLink(db: D1Database, tokenHash: string): Promise<LinkedFile | null> {
  return db.prepare("select id, name from files where link_token = ? and deleted_at is null").bind(tokenHash).first<LinkedFile>();
}

/** そのユーザーのそのファイルでの役割 (メンバーでなければ null) */
export async function getMemberRole(db: D1Database, fileId: string, userId: string): Promise<Exclude<Role, "guest"> | null> {
  const row = await db.prepare("select role from file_members where file_id = ? and user_id = ?").bind(fileId, userId).first<{ role: Exclude<Role, "guest"> }>();
  return row?.role ?? null;
}

/** リンクのトークンのハッシュを書く (作り直し)。null で無効にする */
export async function setLinkToken(db: D1Database, fileId: string, tokenHash: string | null): Promise<void> {
  await db.prepare("update files set link_token = ? where id = ?").bind(tokenHash, fileId).run();
}

/** まだトークンが無いときだけ書く。書けたら true (同時に有効にされて先を越されたら false で、先のトークンを壊さない) */
export async function setLinkTokenIfNone(db: D1Database, fileId: string, tokenHash: string): Promise<boolean> {
  const result = await db.prepare("update files set link_token = ? where id = ? and link_token is null").bind(tokenHash, fileId).run();
  return result.meta.changes > 0;
}

export async function isLinkEnabled(db: D1Database, fileId: string): Promise<boolean> {
  const row = await db.prepare("select link_token is not null as enabled from files where id = ?").bind(fileId).first<{ enabled: number }>();
  return row?.enabled === 1;
}
