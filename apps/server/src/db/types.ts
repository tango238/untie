// D1 の行の形 (docs/collab-design.md 3.3)。時刻はエポックミリ秒。

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number | null;
}

export type SessionKind = "web" | "desktop";

export interface SessionRow {
  id: string;
  user_id: string;
  kind: SessionKind;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

/** ファイルの一覧・詳細に使う行 (files に、見ている人の役割と所有者名・メンバー数を足したもの) */
export interface FileRow {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  role: "owner" | "editor" | "viewer";
  member_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface MemberRow {
  user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: "owner" | "editor" | "viewer";
  added_at: number;
}

export interface InvitationRow {
  id: string;
  file_id: string;
  email: string;
  role: "editor" | "viewer";
  created_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}
