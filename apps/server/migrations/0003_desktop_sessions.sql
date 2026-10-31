-- デスクトップのセッションは、引換コードを交換する (POST /auth/desktop/exchange) まで使えない (docs/collab-design.md 7.3)。
-- activated_at はその交換の時刻。null のままの desktop セッションは認証に通らず、1 時間以上たった行を毎日の cron が消す。web は常に null
alter table sessions add column activated_at integer;

-- すでにある desktop の行は交換済みとして扱う
update sessions set activated_at = created_at where kind = 'desktop';

-- 掃除 (cron) の delete を index で引く。期限切れは 0001 の sessions_expires、交換されないまま残った desktop の行はこの部分 index
create index sessions_unactivated on sessions(created_at) where kind = 'desktop' and activated_at is null;
