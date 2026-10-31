import { listExpiredTrash, deleteFileRows } from "../db/files";
import { deleteExpiredSessions } from "../db/sessions";
import type { Env } from "../env";
import { destroyRoom } from "../rooms";

/** ゴミ箱に置いておく日数 (docs/collab-design.md 3.1) */
export const TRASH_RETENTION_DAYS = 30;
/** 1 回の cron で消す上限 (Worker の実行時間とサブリクエストの上限に収める。残りは次の日に消す) */
export const PURGE_BATCH_SIZE = 50;

/**
 * cron (毎日): ゴミ箱に入れてから 30 日を過ぎたファイルのルームを destroy して行を消す (1 回に 50 件まで)。ついでに期限切れのセッションも消す。
 * 1 件が失敗しても残りは続け、失敗したファイルは行を残して次の日にやり直す。消したファイルの数を返す
 */
export async function purgeTrash(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const id of await listExpiredTrash(env.DB, cutoff, PURGE_BATCH_SIZE)) {
    try {
      await destroyRoom(env, id);
      await deleteFileRows(env.DB, id);
      purged++;
    } catch (e) {
      console.error(`ゴミ箱の掃除に失敗しました (${id})`, e instanceof Error ? e.message : e);
    }
  }
  await deleteExpiredSessions(env.DB, now);
  return purged;
}
