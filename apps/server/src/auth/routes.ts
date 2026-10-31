import { Hono } from "hono";
import type { ProvidersResponse } from "@untie/api";
import type { AppEnv } from "../env";
import { deleteSessionsOfUser } from "../db/sessions";
import { ApiFailure } from "../errors";
import { deleteCookie } from "hono/cookie";
import { exchangeDesktopCode, isValidAppState, isValidChallenge } from "./desktop";
import { devLogin, devLoginEnabled, devLoginForm } from "./providers/dev";
import { AUTH_COOKIE, finishGoogleLogin, googleEnabled, newAuthCookie, sanitizeReturn, setAuthCookie, startGoogleLogin } from "./providers/google";
import { clearSessionCookie, endSession, isSecureRequest, requireSession } from "./session";

export const authRoutes = new Hono<AppEnv>();

/** 使えるログイン方法 */
authRoutes.get("/providers", (c) => {
  const providers: ProvidersResponse["providers"] = [];
  if (googleEnabled(c.env)) providers.push("google");
  if (devLoginEnabled(c)) providers.push("dev");
  return c.json({ providers } satisfies ProvidersResponse);
});

/**
 * GET /auth/login?provider=google|dev&return=<hash>
 * デスクトップは既定のブラウザで `&client=desktop&state=<乱数>&code_challenge=<PKCE>` を付けて開く。戻りは Cookie ではなく引換コード (7.3)
 */
authRoutes.get("/login", async (c) => {
  const provider = c.req.query("provider");
  const client = c.req.query("client");
  if (client !== undefined && client !== "web" && client !== "desktop") throw new ApiFailure(400, "unknown_client", "ログインの種類が正しくありません");
  const appState = c.req.query("state");
  const challenge = c.req.query("code_challenge");
  if (client === "desktop" && (!isValidAppState(appState) || !isValidChallenge(challenge))) {
    throw new ApiFailure(400, "invalid_state", "state か code_challenge が正しくありません。アプリからもう一度ログインしてください");
  }
  const desktop = client === "desktop" ? { appState: appState as string, challenge: challenge as string } : undefined;
  // デスクトップでない経路は、前のデスクトップのログインが残した untie_auth を消してから進む
  // (残っていると、開発用ログインの POST が引換コードのページを返してしまう)。Google は新しい untie_auth で上書きする
  if (!desktop && provider !== "google") deleteCookie(c, AUTH_COOKIE, { path: "/auth", secure: isSecureRequest(c) });

  if (provider === "google") return startGoogleLogin(c, desktop);
  if (provider === "dev") {
    if (!devLoginEnabled(c)) throw new ApiFailure(404, "not_found", "見つかりません");
    if (desktop) await setAuthCookie(c, newAuthCookie({ state: desktop.appState, client: "desktop", ...desktop }));
    const returnTo = sanitizeReturn(c.req.query("return"));
    return c.redirect(returnTo ? `/auth/dev?return=${encodeURIComponent(returnTo)}` : "/auth/dev", 302);
  }
  throw new ApiFailure(400, "unknown_provider", "ログイン方法が正しくありません");
});

authRoutes.get("/callback", finishGoogleLogin);

/** デスクトップ: 引換コードをセッションのトークンに交換する (セッションは要らない。CORS は index.ts) */
authRoutes.post("/desktop/exchange", exchangeDesktopCode);

authRoutes.get("/dev", devLoginForm);
authRoutes.post("/dev", devLogin);

/** ログアウト。セッションが無くても成功にする (Cookie を消す) */
authRoutes.post("/logout", async (c) => {
  await endSession(c);
  return c.body(null, 204);
});

/** すべての端末からログアウト */
authRoutes.post("/logout-all", requireSession, async (c) => {
  await deleteSessionsOfUser(c.env.DB, c.var.user.id);
  clearSessionCookie(c);
  return c.body(null, 204);
});
