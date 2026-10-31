import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";
import { ROOM_HEADERS } from "@untie/api";
import type { AppEnv, Env } from "./env";
import { apiRoutes } from "./api/routes";
import { authRoutes } from "./auth/routes";
import { verifyTicket } from "./auth/ticket";
import { errorBody, handleError } from "./errors";
import { purgeTrash } from "./jobs/purgeTrash";
import { LOCATION_HINT } from "./rooms";

export { UntieRoom } from "@untie/collab/room";

const app = new Hono<AppEnv>();

app.onError(handleError);

app.route("/auth", authRoutes);
app.route("/api", apiRoutes);

// ルームへの接続 (WebSocket)。?ticket= を検めて、ルームに渡す Request に x-untie-* のヘッダーを付ける (設計書 7.5)
const ROOM_PATH = /^\/parties\/untie-room\/[^/]+/;

/** チケットを検めて、通れば役割などのヘッダーを付けた Request を返す。通らなければ 401 / 403 */
async function onBeforeConnect(request: Request, lobby: { name: string }, env: Env): Promise<Request | Response> {
  const token = new URL(request.url).searchParams.get("ticket");
  const claims = token ? await verifyTicket(env, token) : null;
  if (!claims) return Response.json(errorBody("invalid_ticket", "接続のチケットが無効か、期限が切れています。つなぎ直してください"), { status: 401 });
  // 別のファイルのチケットでは入れない
  if (claims.fileId !== lobby.name) return Response.json(errorBody("forbidden", "このファイルには接続できません"), { status: 403 });
  // クライアントが送った x-untie-* は信用しない。すべて set で上書きし、無いものは消す
  const url = new URL(request.url);
  // 接続 id (_pk) はクライアントに選ばせない。同じ id で 2 本つなぐと 1 本目が getConnections() から外れ、kick から逃れられる
  url.searchParams.set("_pk", crypto.randomUUID());
  const headers = new Headers(request.headers);
  if (claims.userId !== null) headers.set(ROOM_HEADERS.user, claims.userId);
  else headers.delete(ROOM_HEADERS.user);
  headers.set(ROOM_HEADERS.name, encodeURIComponent(claims.name));
  headers.set(ROOM_HEADERS.role, claims.role);
  headers.set(ROOM_HEADERS.via, claims.via);
  headers.set(ROOM_HEADERS.iat, String(claims.iat));
  return new Request(url.toString(), new Request(request, { headers }));
}

// ルームへの HTTP は使わない (WebSocket だけ)
const onBeforeRequest = () => Response.json(errorBody("unauthenticated", "ルームには WebSocket でつないでください"), { status: 401 });

app.all("/parties/*", async (c) => {
  // 名前空間が untie-room でないパスは partyserver に渡さない (渡すと本文が JSON でない 400 になる)
  if (!ROOM_PATH.test(new URL(c.req.url).pathname)) return c.json(errorBody("not_found", "見つかりません"), 404);
  const response = await routePartykitRequest(c.req.raw, c.env, {
    locationHint: LOCATION_HINT,
    onBeforeConnect: (request, lobby) => onBeforeConnect(request, lobby, c.env),
    onBeforeRequest,
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
