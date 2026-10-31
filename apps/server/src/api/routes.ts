import { Hono } from "hono";
import type { AppEnv } from "../env";
import { toUser } from "../db/users";
import { requireSession } from "../auth/session";
import { fileRoutes } from "./files";

/** /api の下。すべて requireSession を通る */
export const apiRoutes = new Hono<AppEnv>();

apiRoutes.use("*", requireSession);

apiRoutes.get("/me", (c) => c.json(toUser(c.var.user)));

apiRoutes.route("/files", fileRoutes);
