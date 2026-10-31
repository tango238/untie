-- 古い招待の掃除 (cron。jobs/purgeTrash.ts) が使う index。期限が切れたまま受けられなかった招待と、受けて30日たった招待を消す。
-- 全表を読まずに済むよう、条件に合う行だけの部分 index にする。
create index invitations_expired on invitations(expires_at) where accepted_at is null;
create index invitations_accepted on invitations(accepted_at) where accepted_at is not null;
