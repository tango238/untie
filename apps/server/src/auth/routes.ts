import { Hono } from "hono";
import type { ProvidersResponse } from "@untie/api";
import type { AppEnv } from "../env";
import { deleteSessionsOfUser } from "../db/sessions";
import { ApiFailure } from "../errors";
import { devLogin, devLoginEnabled, devLoginForm } from "./providers/dev";
import { finishGoogleLogin, googleEnabled, sanitizeReturn, startGoogleLogin } from "./providers/google";
import { clearSessionCookie, endSession, requireSession } from "./session";

export const authRoutes = new Hono<AppEnv>();

/** 使えるログイン方法 */
authRoutes.get("/providers", (c) => {
  const providers: ProvidersResponse["providers"] = [];
  if (googleEnabled(c.env)) providers.push("google");
  if (devLoginEnabled(c)) providers.push("dev");
  return c.json({ providers } satisfies ProvidersResponse);
});

/** GET /auth/login?provider=google|dev&return=<hash> */
authRoutes.get("/login", (c) => {
  const provider = c.req.query("provider");
  if (provider === "google") return startGoogleLogin(c);
  if (provider === "dev") {
    if (!devLoginEnabled(c)) throw new ApiFailure(404, "not_found", "見つかりません");
    const returnTo = sanitizeReturn(c.req.query("return"));
    return c.redirect(returnTo ? `/auth/dev?return=${encodeURIComponent(returnTo)}` : "/auth/dev", 302);
  }
  throw new ApiFailure(400, "unknown_provider", "ログイン方法が正しくありません");
});

authRoutes.get("/callback", finishGoogleLogin);

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
