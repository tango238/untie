import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection } from "partyserver";
import { validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { getRoots, loadModel, rebuildModel, repairDoc } from "../doc";
import type { Env } from "./env";

/** 1 時間ごとのスナップショットを残す件数 (3.4) */
export const SNAPSHOT_KEEP = 24;
const SNAPSHOT_PREFIX = "snapshot:";
const HOUR_MS = 60 * 60 * 1000;

/**
 * 書き込める役割は owner と editor だけ。viewer・guest・役割が無い接続 (認証を通っていない、state が未設定) は読み取り専用にする。
 * 接続の state.role は onConnect がチケットのヘッダーから写す (Phase 4)
 */
function canWriteRole(role: unknown): boolean {
  return role === "owner" || role === "editor";
}

/**
 * 1 クラウドファイル = 1 Durable Object。ファイルの中身 (Y.Doc) を持ち、同時編集の接続を受ける (設計書 3.4・7.5)。
 * Worker からは getServerByName で RPC (importModel など) を呼ぶ。
 */
export class UntieRoom extends YServer<Env> {
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10000 };

  /** destroy 済み。遅れて来る保存で、消したストレージに書き戻さないための目印 */
  private destroyed = false;

  async onLoad(): Promise<void> {
    const saved = await this.ctx.storage.get<Uint8Array>("ydoc");
    if (saved) Y.applyUpdate(this.document, saved);
  }

  async onSave(): Promise<void> {
    if (this.destroyed) return;
    // 空のルームは保存するものが無い
    if (this.isDocEmpty()) return;
    // 壊れた参照を直してから保存する (直すのはサーバーだけ。6 章)
    const changes = repairDoc(this.document, "repair");
    if (changes.length > 0) console.log(`ルーム ${this.name}: 壊れた参照を直しました`, changes);

    const model = rebuildModel(this.document);
    // 検証に通らない中身は保存しない。直前の正常な ydoc と snapshot を残して記録する (設計書 7.5)
    const result = validateModel(model);
    if (!result.ok) {
      console.error(`ルーム ${this.name}: 検証に通らないので保存しませんでした`, result.errors.slice(0, 5));
      return;
    }

    const previous = await this.ctx.storage.get<UntieModel>("snapshot");
    await this.keepHourlySnapshot(previous);
    await this.ctx.storage.put("ydoc", Y.encodeStateAsUpdate(this.document));
    await this.ctx.storage.put("snapshot", model);
    // 一覧の写し。行が無ければ (取り込みの途中・消したあと) 何もしない
    await this.env.DB.prepare("update files set name = ?, updated_at = ? where id = ?").bind(model.meta.name, Date.now(), this.name).run();
  }

  /**
   * 1 時間に 1 件のスナップショットを残し、直近 SNAPSHOT_KEEP 件より古いものを消す。
   * その時間のキーに入れるのは「その時間の最初の保存の直前の状態」(= 上書きする前の snapshot)。
   * 誤って消したときに、消す直前の状態に戻せるようにするため (クラウドファイルには Undo が無い)。
   * その時間のキーが既にあれば何もしない
   */
  private async keepHourlySnapshot(previous: UntieModel | undefined): Promise<void> {
    if (previous !== undefined) {
      const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString();
      const key = `${SNAPSHOT_PREFIX}${hour}`;
      if ((await this.ctx.storage.get(key)) === undefined) await this.ctx.storage.put(key, previous);
    }
    const keys = [...(await this.ctx.storage.list({ prefix: SNAPSHOT_PREFIX })).keys()].sort();
    const old = keys.slice(0, Math.max(0, keys.length - SNAPSHOT_KEEP));
    if (old.length > 0) await this.ctx.storage.delete(old);
  }

  /** owner と editor 以外 (viewer・guest・役割なし) の sync step2 と update は y-partyserver が捨てる (step1 と awareness は通る) */
  isReadOnly(connection: Connection): boolean {
    return !canWriteRole((connection.state as { role?: unknown } | null)?.role);
  }

  private isDocEmpty(): boolean {
    const roots = getRoots(this.document);
    return roots.meta.size === 0 && roots.elements.size === 0 && roots.relations.size === 0 && roots.boards.size === 0;
  }

  // ---- RPC (Worker から getServerByName で呼ぶ) ----

  /** 空のルームにモデルを取り込む (作成・複製)。既に中身があれば拒む */
  async importModel(model: UntieModel): Promise<void> {
    if (!this.isDocEmpty()) throw new Error("このファイルには既に中身があります");
    const result = validateModel(model);
    if (!result.ok) throw new Error(`モデルの形が正しくありません: ${result.errors.slice(0, 3).join(" / ")}`);
    this.destroyed = false;
    loadModel(this.document, model);
    await this.onSave();
  }

  /** 接続せずに JSON のモデルを読む。Doc も snapshot も無ければ (取り込み前・削除後) 例外 */
  async exportModel(): Promise<UntieModel> {
    if (this.isDocEmpty()) {
      const snapshot = await this.ctx.storage.get<UntieModel>("snapshot");
      if (snapshot === undefined) throw new Error("このファイルには中身がありません");
      return snapshot;
    }
    return rebuildModel(this.document);
  }

  /** 名前を変える (meta.name を書き、すぐ保存する。一覧の写しも onSave が D1 へ反映する) */
  async rename(name: string): Promise<void> {
    this.document.transact(() => getRoots(this.document).meta.set("name", name));
    await this.onSave();
  }

  /** 完全に消す。ストレージを空にし、メモリ上の中身も捨てて、つながっている接続を閉じる */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.ctx.storage.deleteAll();
    const roots = getRoots(this.document);
    this.document.transact(() => {
      roots.meta.clear();
      roots.elements.clear();
      roots.relations.clear();
      roots.boards.clear();
    }, "destroy");
    for (const connection of this.getConnections()) connection.close(1008, "ファイルは削除されました");
  }

  /** 1 時間ごとのスナップショットのキー (新しい順) */
  async listSnapshots(): Promise<string[]> {
    const keys = [...(await this.ctx.storage.list({ prefix: SNAPSHOT_PREFIX })).keys()];
    return keys.sort().reverse();
  }

  async getSnapshot(key: string): Promise<UntieModel | null> {
    if (!key.startsWith(SNAPSHOT_PREFIX)) return null;
    return (await this.ctx.storage.get<UntieModel>(key)) ?? null;
  }
}

