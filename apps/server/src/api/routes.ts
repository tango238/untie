import { Hono } from "hono";
import type { AppEnv } from "../env";
import { toUser } from "../db/users";
import { requireSession } from "../auth/session";
import { fileRoutes } from "./files";
import { invitationTokenRoutes } from "./invitations";
import { linkRoutes } from "./links";

/** /api の下。/links 以外はすべて requireSession を通る */
export const apiRoutes = new Hono<AppEnv>();

// リンクを知っている人の閲覧はログインしなくても通る (設計書 3.6)。requireSession より前に置き、通さない
apiRoutes.route("/links", linkRoutes);

apiRoutes.use("*", requireSession);

apiRoutes.get("/me", (c) => c.json(toUser(c.var.user)));

apiRoutes.route("/files", fileRoutes);
apiRoutes.route("/invitations", invitationTokenRoutes);
