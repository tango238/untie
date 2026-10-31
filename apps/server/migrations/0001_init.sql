-- ユーザー・ファイル・権限 (docs/collab-design.md 3.3)

create table users (
  id          text primary key,           -- usr_ + nanoid
  email       text not null unique,       -- 小文字に正規化
  name        text not null,
  avatar_url  text,
  created_at  integer not null,
  last_login_at integer
);

create table identities (                  -- どのプロバイダーの誰がこのユーザーか
  provider    text not null,               -- 'google' (将来 'microsoft' など)
  subject     text not null,               -- プロバイダー側の id (sub)
  user_id     text not null references users(id),
  primary key (provider, subject)
);

create table sessions (
  id          text primary key,           -- トークンの SHA-256。トークン自体は保存しない
  user_id     text not null references users(id),
  kind        text not null,               -- 'web' | 'desktop'
  created_at  integer not null,
  expires_at  integer not null,            -- web 30 日、desktop 90 日。使うたびに延ばす
  last_seen_at integer not null,
  user_agent  text
);

create table files (
  id          text primary key,           -- nanoid 21 文字 (= ルーム名)
  name        text not null,               -- モデルの meta.name の写し (3.5)
  owner_id    text not null references users(id),
  created_at  integer not null,
  updated_at  integer not null,            -- ルームが onSave で更新する
  deleted_at  integer,                     -- ゴミ箱に入れた日時。null なら生きている
  link_token  text unique                  -- リンク閲覧のトークンの SHA-256。null なら無効 (3.6)
);

create table file_members (
  file_id     text not null references files(id),
  user_id     text not null references users(id),
  role        text not null,               -- 'owner' | 'editor' | 'viewer'
  added_by    text references users(id),
  added_at    integer not null,
  primary key (file_id, user_id)
);

create table invitations (
  id          text primary key,           -- トークンの SHA-256
  file_id     text not null references files(id),
  email       text not null,
  role        text not null,               -- 'editor' | 'viewer'
  created_by  text not null references users(id),
  created_at  integer not null,
  expires_at  integer not null,            -- 14 日
  accepted_at integer
);

create index files_owner on files(owner_id, deleted_at);
create index file_members_user on file_members(user_id);
create index invitations_email on invitations(email, accepted_at);
create index sessions_user on sessions(user_id);           -- すべての端末からログアウト
create index sessions_expires on sessions(expires_at);     -- 期限切れの掃除
create index files_deleted on files(deleted_at);           -- ゴミ箱の掃除
