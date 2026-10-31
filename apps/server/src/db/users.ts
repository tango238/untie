import type { User } from "@untie/api";
import { newId } from "./ids";
import type { UserRow } from "./types";

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}) };
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("select * from users where id = ?").bind(id).first<UserRow>();
}

export interface ProviderProfile {
  provider: string;
  /** プロバイダー側の id (Google なら sub) */
  subject: string;
  /** 小文字に正規化済み */
  email: string;
  name: string;
  avatarUrl?: string;
}

/**
 * ログインしたユーザーを users / identities に反映して返す。
 * identity が既にあればそのユーザー、無ければ同じメールのユーザー (別のプロバイダーで作った)、それも無ければ新しく作る。
 */
export async function upsertUser(db: D1Database, profile: ProviderProfile, now = Date.now()): Promise<UserRow> {
  const name = profile.name.trim() || profile.email.split("@")[0];
  const identity = await db
    .prepare("select user_id from identities where provider = ? and subject = ?")
    .bind(profile.provider, profile.subject)
    .first<{ user_id: string }>();
  let userId = identity?.user_id ?? null;
  if (!userId) {
    userId = (await db.prepare("select id from users where email = ?").bind(profile.email).first<{ id: string }>())?.id ?? null;
  }
  if (!userId) {
    // 同時に 2 つのログインが来ても email の一意制約で 1 人にまとまる
    await db
      .prepare("insert or ignore into users (id, email, name, avatar_url, created_at) values (?, ?, ?, ?, ?)")
      .bind(newId("usr"), profile.email, name, profile.avatarUrl ?? null, now)
      .run();
    userId = (await db.prepare("select id from users where email = ?").bind(profile.email).first<{ id: string }>())!.id;
  }
  await db.batch([
    db.prepare("insert or ignore into identities (provider, subject, user_id) values (?, ?, ?)").bind(profile.provider, profile.subject, userId),
    db
      .prepare("update users set name = ?, avatar_url = coalesce(?, avatar_url), last_login_at = ? where id = ?")
      .bind(name, profile.avatarUrl ?? null, now, userId),
  ]);
  return (await getUserById(db, userId))!;
}
