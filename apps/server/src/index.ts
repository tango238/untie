import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";
import type { AppEnv, Env } from "./env";
import { apiRoutes } from "./api/routes";
import { authRoutes } from "./auth/routes";
import { errorBody, handleError } from "./errors";
import { purgeTrash } from "./jobs/purgeTrash";
import { LOCATION_HINT } from "./rooms";

export { UntieRoom } from "@untie/collab/room";

const app = new Hono<AppEnv>();

app.onError(handleError);

app.route("/auth", authRoutes);
app.route("/api", apiRoutes);

// ルームへの接続 (WebSocket)。チケットの検査は Phase 4。それまでは入口で 401 を返す
const unauthorized = () => Response.json(errorBody("unauthenticated", "ルームへの接続にはチケットが必要です"), { status: 401 });
const ROOM_PATH = /^\/parties\/untie-room\/[^/]+/;
app.all("/parties/*", async (c) => {
  // 名前空間が untie-room でないパスは partyserver に渡さない (渡すと本文が JSON でない 400 になる)
  if (!ROOM_PATH.test(new URL(c.req.url).pathname)) return c.json(errorBody("not_found", "見つかりません"), 404);
  const response = await routePartykitRequest(c.req.raw, c.env, {
    locationHint: LOCATION_HINT,
    onBeforeConnect: unauthorized,
    onBeforeRequest: unauthorized,
  });
  // 名前空間が無いパス (/parties/<無い名前>/x) も JSON の 404 にする
  return response ?? c.json(errorBody("not_found", "見つかりません"), 404);
});

// /api と /auth の存在しないパスは JSON の 404。それ以外は Web の静的ファイル (SPA)
app.all("/api/*", (c) => c.json(errorBody("not_found", "見つかりません"), 404));
app.all("/auth/*", (c) => c.json(errorBody("not_found", "見つかりません"), 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, _ctx) {
    await purgeTrash(env);
  },
} satisfies ExportedHandler<Env>;
