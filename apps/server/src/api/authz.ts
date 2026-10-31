import type { Context } from "hono";
import { can } from "@untie/api";
import type { Action } from "@untie/api";
import type { AppEnv } from "../env";
import { getFileForUser } from "../db/files";
import type { FileRow } from "../db/types";
import { forbidden, notFound } from "../errors";

/**
 * そのファイルでの自分の役割を file_members から引き、`can(role, action)` で判定する。
 * - メンバーでないファイルは 404 (存在を知らせない)
 * - ゴミ箱の中のファイルは owner 以外は 404
 * - メンバーだが権限が足りなければ 403
 */
export async function requireRole(c: Context<AppEnv>, fileId: string, action: Action): Promise<FileRow> {
  const file = await getFileForUser(c.env.DB, fileId, c.var.user.id);
  if (!file || (file.deleted_at !== null && file.role !== "owner")) throw notFound("ファイルが見つかりません", "file_not_found");
  if (!can(file.role, action)) throw forbidden();
  return file;
}
