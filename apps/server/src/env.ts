import type { UntieRoom, RoomEnv } from "@untie/collab/room";
import type { SessionRow, UserRow } from "./db/types";

/** wrangler.jsonc のバインディングと、vars・secrets */
export interface Env extends RoomEnv {
  /** apps/web/dist の静的配信 */
  ASSETS: Fetcher;
  UntieRoom: DurableObjectNamespace<UntieRoom>;

  // vars (wrangler.jsonc)
  /** ログインを許すメールのドメイン (カンマ区切り)。空なら制限なし */
  ALLOWED_EMAIL_DOMAINS: string;
  /** "true" のときだけ開発用ログインを出す */
  DEV_LOGIN: string;
  /** 公開の URL。空なら受けたリクエストのオリジン */
  APP_ORIGIN: string;

  // secrets (wrangler secret put。開発は .dev.vars)
  SESSION_SECRET: string;
  TICKET_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

/** Hono に渡す型。requireSession を通ったあと user と session が入る */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: UserRow;
    session: SessionRow;
  };
}
