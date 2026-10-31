import type { SessionKind, SessionRow, UserRow } from "./types";

export interface NewSession {
  /** トークンの SHA-256 (トークン自体は保存しない) */
  id: string;
  userId: string;
  kind: SessionKind;
  userAgent: string | null;
  now: number;
  expiresAt: number;
}

export async function createSession(db: D1Database, s: NewSession): Promise<void> {
  await db
    .prepare("insert into sessions (id, user_id, kind, created_at, expires_at, last_seen_at, user_agent) values (?, ?, ?, ?, ?, ?, ?)")
    .bind(s.id, s.userId, s.kind, s.now, s.expiresAt, s.now, s.userAgent)
    .run();
}

/** 期限内のセッションとそのユーザーを引く。引換コードをまだ交換していないデスクトップのセッション (activated_at が null) は使えない */
export async function findSession(db: D1Database, id: string, now: number): Promise<{ session: SessionRow; user: UserRow } | null> {
  const row = await db
    .prepare(
      `select s.id as s_id, s.user_id as s_user_id, s.kind as s_kind, s.created_at as s_created_at, s.expires_at as s_expires_at,
              s.last_seen_at as s_last_seen_at, s.user_agent as s_user_agent, s.activated_at as s_activated_at,
              u.id as u_id, u.email as u_email, u.name as u_name, u.avatar_url as u_avatar_url, u.created_at as u_created_at, u.last_login_at as u_last_login_at
       from sessions s join users u on u.id = s.user_id
       where s.id = ? and s.expires_at > ? and (s.kind <> 'desktop' or s.activated_at is not null)`,
    )
    .bind(id, now)
    .first<Record<string, string | number | null>>();
  if (!row) return null;
  return {
    session: {
      id: row.s_id as string,
      user_id: row.s_user_id as string,
      kind: row.s_kind as SessionKind,
      created_at: row.s_created_at as number,
      expires_at: row.s_expires_at as number,
      last_seen_at: row.s_last_seen_at as number,
      user_agent: row.s_user_agent as string | null,
      activated_at: row.s_activated_at as number | null,
    },
    user: {
      id: row.u_id as string,
      email: row.u_email as string,
      name: row.u_name as string,
      avatar_url: row.u_avatar_url as string | null,
      created_at: row.u_created_at as number,
      last_login_at: row.u_last_login_at as number | null,
    },
  };
}

export async function extendSession(db: D1Database, id: string, now: number, expiresAt: number): Promise<void> {
  await db.prepare("update sessions set last_seen_at = ?, expires_at = ? where id = ?").bind(now, expiresAt, id).run();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("delete from sessions where id = ?").bind(id).run();
}

/** すべての端末からログアウト */
export async function deleteSessionsOfUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("delete from sessions where user_id = ?").bind(userId).run();
}

/** 交換されないまま残ったデスクトップのセッションを消すまでの時間 (引換コードの寿命は 5 分なので、それより十分長ければよい) */
export const UNACTIVATED_TTL_MS = 60 * 60 * 1000;

/**
 * 期限切れと、引換コードが交換されないまま 1 時間以上たったデスクトップのセッションを消す。
 * 2 本の delete に分けるのは、それぞれ index (sessions_expires・sessions_unactivated) を使えるようにするため
 */
export async function deleteExpiredSessions(db: D1Database, now: number): Promise<void> {
  await db.prepare("delete from sessions where expires_at < ?").bind(now).run();
  await db
    .prepare("delete from sessions where kind = 'desktop' and activated_at is null and created_at < ?")
    .bind(now - UNACTIVATED_TTL_MS)
    .run();
}

/**
 * デスクトップのセッションを使えるようにする (引換コードの交換)。行の id を、新しいトークンのハッシュ (newId) に入れ替えて
 * activated_at を書く。activated_at が null のときだけ書くので、同じコードの 2 回目は false を返す。消えている・期限切れ・web のセッションも false。
 * 作った時点の id は引換コードの中にしか無く、トークンは誰も知らない (トークンはこの交換で初めて作られる)
 */
export async function activateSession(db: D1Database, id: string, newId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare("update sessions set id = ?, activated_at = ?, last_seen_at = ? where id = ? and kind = 'desktop' and activated_at is null and expires_at > ?")
    .bind(newId, now, now, id, now)
    .run();
  return result.meta.changes === 1;
}
