import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import { CLOSE_LINK_DISABLED, CLOSE_REMOVED, CLOSE_ROLE_CHANGED, CLOSE_UNAUTHENTICATED, ROLES, ROOM_HEADERS, guestName } from "@untie/api";
import type { Role, TicketVia } from "@untie/api";
import { validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { getRoots, loadModel, rebuildModel, repairDoc } from "../doc";
import { CLOSE_REASONS } from "./connectionState";
import type { ConnectionState, KickTarget, PresenceEntry } from "./connectionState";
import type { Env } from "./env";

/** 1 時間ごとのスナップショットを残す件数 (3.4) */
export const SNAPSHOT_KEEP = 24;
const SNAPSHOT_PREFIX = "snapshot:";
const HOUR_MS = 60 * 60 * 1000;

/**
 * 書き込める役割は owner と editor だけ。viewer・guest・役割が無い接続 (認証を通っていない、state が未設定) は読み取り専用にする。
 * 接続の state.role は onConnect がチケットのヘッダーから写す
 */
function canWriteRole(role: unknown): boolean {
  return role === "owner" || role === "editor";
}

/**
 * kick の記録 (DO storage)。この時刻以前に発行されたチケットでの接続を、記録した code で閉じる。
 * チケットは 60 秒使い回せるので、kick で閉じたあとにすぐ同じチケットでつなぎ直されるのを防ぐ
 */
interface Revocation {
  /** kick した時刻 (エポックミリ秒) */
  at: number;
  code: number;
  reason: string;
}
const REVOKED_USER = "revoked:user:";
const REVOKED_LINK = "revoked:link";
const REVOKED_ALL = "revoked:all";
/** 記録を残す期間。チケットの有効期間 (60 秒) より十分長ければよい。過ぎた記録は次の kick で消す */
const REVOKED_KEEP_MS = 5 * 60 * 1000;

/** 接続の state から、onConnect が書いた ConnectionState を取り出す。まだ書かれていない・壊れていれば null */
function readState(connection: Connection): ConnectionState | null {
  const state = connection.state as Partial<ConnectionState> | null | undefined;
  if (!state || typeof state.name !== "string" || typeof state.role !== "string") return null;
  return state as ConnectionState;
}

/** ヘッダー (URL エンコード済み) の名前を戻す。壊れていればそのまま */
function decodeName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

  /**
   * 接続を受けたとき、Worker が付けたヘッダー (チケットの中身) を connection.state に写す。
   * ヘッダーが無い・壊れている接続 (Worker を通らずに来た) は閉じる。ゲストの名前はここで「ゲスト N」にする
   */
  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const state = this.stateFromHeaders(ctx.request.headers);
    const iatHeader = ctx.request.headers.get(ROOM_HEADERS.iat);
    const issuedAt = iatHeader === null || iatHeader === "" ? NaN : Number(iatHeader);
    if (!state || !Number.isFinite(issuedAt)) {
      connection.close(CLOSE_UNAUTHENTICATED, CLOSE_REASONS.unauthenticated);
      return;
    }
    // kick のあとに取り直していないチケット (古い役割) での再接続は閉じる
    const revoked = await this.findRevocation(state, issuedAt);
    if (revoked) {
      connection.close(revoked.code, revoked.reason);
      return;
    }
    if (state.role === "guest") state.name = guestName(this.freeGuestNumber());
    connection.setState(state);
    super.onConnect(connection, ctx);
  }

  /** そのチケット (発行時刻 issuedAt) が、kick より前のものなら記録を返す */
  private async findRevocation(state: ConnectionState, issuedAt: number): Promise<Revocation | null> {
    const keys = [REVOKED_ALL, ...(state.userId !== null ? [`${REVOKED_USER}${state.userId}`] : []), ...(state.via === "link" ? [REVOKED_LINK] : [])];
    const found = await this.ctx.storage.get<Revocation>(keys);
    for (const key of keys) {
      const revocation = found.get(key);
      if (revocation && issuedAt <= revocation.at) return revocation;
    }
    return null;
  }

  private stateFromHeaders(headers: Headers): ConnectionState | null {
    const role = headers.get(ROOM_HEADERS.role);
    const via = headers.get(ROOM_HEADERS.via);
    const name = headers.get(ROOM_HEADERS.name);
    if (role === null || name === null || (via !== "member" && via !== "link")) return null;
    if (!ROLES.includes(role as Role)) return null;
    const userId = headers.get(ROOM_HEADERS.user) || null;
    // メンバーとして来た人には必ず userId がある (無ければ kick の対象にもならない)
    if (via === "member" && userId === null) return null;
    return { userId, name: decodeName(name), role: role as Role, via: via as TicketVia };
  }

  /** いまつながっているゲストの番号と重ならない、いちばん小さい番号 */
  private freeGuestNumber(): number {
    const used = new Set<number>();
    for (const connection of this.getConnections()) {
      const state = readState(connection);
      if (state?.role !== "guest") continue;
      const match = /^ゲスト (\d+)$/.exec(state.name);
      if (match) used.add(Number(match[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return n;
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

  /** 保存を待たず、メモリ上の Y.Doc からモデルを作る (テスト・確認用) */
  async currentModel(): Promise<UntieModel> {
    return rebuildModel(this.document);
  }

  /**
   * 条件に合う接続を閉じ、閉じた数を返す。あわせて「この時刻より前のチケットは使えない」を記録し、
   * kick の直後に同じチケットでつなぎ直されても閉じる (onConnect)。
   * - `{ userId, reason? }`: 役割が変わった (4001、既定)・メンバーから外された (reason: "removed"、4003)。複数のタブも閉じる
   * - `{ via: "link" }`: リンク閲覧が無効になった (4004)。ゲストだけでなく、リンクから開いたメンバーも閉じる
   * - `{ all: true }`: ファイルがゴミ箱に入った (4003)。全員を閉じる
   */
  async kick(target: KickTarget): Promise<number> {
    let code: number;
    let reason: string;
    let key: string;
    let matches: (state: ConnectionState) => boolean;
    if ("all" in target && target.all === true) {
      [code, reason, key, matches] = [CLOSE_REMOVED, CLOSE_REASONS.trashed, REVOKED_ALL, () => true];
    } else if ("via" in target && target.via === "link") {
      [code, reason, key, matches] = [CLOSE_LINK_DISABLED, CLOSE_REASONS.linkDisabled, REVOKED_LINK, (state) => state.via === "link"];
    } else if ("userId" in target && typeof target.userId === "string" && target.userId !== "") {
      // userId が null / 空のまま渡ってもゲスト (userId が null) を巻き込まない
      const userId = target.userId;
      const removed = target.reason === "removed";
      [code, reason, key, matches] = [
        removed ? CLOSE_REMOVED : CLOSE_ROLE_CHANGED,
        removed ? CLOSE_REASONS.removed : CLOSE_REASONS.roleChanged,
        `${REVOKED_USER}${userId}`,
        (state) => state.userId === userId,
      ];
    } else {
      throw new Error("kick の対象が正しくありません");
    }

    await this.revoke(key, { at: Date.now(), code, reason });
    let closed = 0;
    for (const connection of this.getConnections()) {
      const state = readState(connection);
      if (!state || !matches(state)) continue;
      connection.close(code, reason);
      closed++;
    }
    return closed;
  }

  /** 取り消しを記録し、期限を過ぎた記録を消す */
  private async revoke(key: string, revocation: Revocation): Promise<void> {
    await this.ctx.storage.put(key, revocation);
    const now = Date.now();
    const stale: string[] = [];
    for (const [k, v] of await this.ctx.storage.list<Revocation>({ prefix: "revoked:" })) {
      if (now - v.at > REVOKED_KEEP_MS) stale.push(k);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  /** いまつながっている人 (同じ人が複数のタブでつないでいれば、その数だけ出る) */
  async presence(): Promise<PresenceEntry[]> {
    const entries: PresenceEntry[] = [];
    for (const connection of this.getConnections()) {
      const state = readState(connection);
      if (state) entries.push({ userId: state.userId, name: state.name, role: state.role });
    }
    return entries;
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

