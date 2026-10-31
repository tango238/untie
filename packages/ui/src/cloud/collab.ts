// クラウドドキュメントの同時編集 (設計書 4.2・5・8.2・8.3)。
// 中核の attachCloudDoc は provider を知らず、Y.Doc とストアだけをつなぐ (テストでは Y.Doc を 2 つ作って使う)。
// その外側の openCloudFile が、チケットを取って y-partyserver の YProvider をつなぎ、接続の状態とプレゼンスを写す。
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import YProvider from "y-partyserver/provider";
import {
  ApiError,
  CLOSE_CODES,
  CLOSE_LINK_DISABLED,
  CLOSE_REMOVED,
  CLOSE_UNAUTHENTICATED,
  type Role,
} from "@untie/api";
import { observeModelChanges, rebuildModel } from "@untie/collab";
import { useAgentStore } from "../ai/agentStore";
import { getPlatform } from "../platform";
import { LOCAL_ORIGIN, useUntieStore, type Peer, type Selection } from "../store";
import { getApi } from "./api";
import { useSessionStore } from "./session";

/** サーバーが接続を閉じたときの理由 (サーバーが理由を付けなかったときの文言) */
export const CLOSE_REASONS: Record<number, string> = {
  [CLOSE_CODES.unauthenticated]: "認証されていません。ログインし直してください",
  [CLOSE_CODES.roleChanged]: "役割が変わりました。開き直してください",
  [CLOSE_CODES.removed]: "共有から外されたか、ファイルがゴミ箱に入りました",
  [CLOSE_CODES.linkDisabled]: "リンクが無効になりました",
};

/** サーバーが再接続を許さない閉じ方か (4000〜4004) */
export const isFatalClose = (code: number) => code >= CLOSE_UNAUTHENTICATED && code <= CLOSE_LINK_DISABLED;

// ---------------------------------------------------------------- Y.Doc とストア

export interface AttachOptions {
  fileId: string;
  role: Role;
  /** リンクで開いたときのトークン (5 段階目) */
  link?: string;
}

/**
 * Y.Doc をストアにつなぐ。ストアに cloud を入れて Doc から組み立てたモデルを読み込み、
 * 自分以外の origin の変更 (他の人の update やサーバーの修復) を組み立て直してストアへ反映する。
 * 戻り値の detach() で購読を外し、ストアをサンプルに戻す。provider は持たない。
 */
export function attachCloudDoc(doc: Y.Doc, options: AttachOptions): () => void {
  const store = useUntieStore;
  store.getState().loadCloudDocument(rebuildModel(doc), { fileId: options.fileId, role: options.role, doc, link: options.link });
  const stop = observeModelChanges(doc, (_changed, origin) => {
    // 自分の編集は dispatch の中で組み立て直し済み
    if (origin === LOCAL_ORIGIN) return;
    const s = store.getState();
    if (s.cloud?.doc !== doc) return;
    // ドラッグ中は反映が後回しになるので、組み立て直さない (commitDrag / cancelDrag のあとで揃う)。
    // 届いた id だけの部分的な組み立て直しはしない: 消えた BUC を指す bucId のように、
    // 変わる範囲が届く id と一致しないため (設計書 6 章)。構造共有で変わった分だけが新しい参照になる
    s.applyRemoteModel(s.dragBase ? s.model : rebuildModel(doc, s.model));
  });
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    stop();
    // 別のファイルを開いていたら触らない
    if (store.getState().cloud?.doc === doc) store.getState().closeCloud();
  };
}

// ---------------------------------------------------------------- プレゼンス

/** 参加者の色。ユーザー id (ゲストは接続 id) のハッシュで決める */
export const PEER_COLORS = ["#e5484d", "#f76b15", "#ab8a00", "#30a46c", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f"] as const;

export function colorFor(key: string): string {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PEER_COLORS[h % PEER_COLORS.length]!;
}

export interface PresenceIdentity {
  /** ゲストは null */
  userId: string | null;
  name: string;
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 他の人の awareness の状態は信用できないので、形を確かめて Peer にする (読めなければ null) */
function toPeer(clientId: number, state: unknown): Peer | null {
  if (typeof state !== "object" || state === null) return null;
  const s = state as Record<string, unknown>;
  const userId = typeof s.userId === "string" ? s.userId : null;
  const name = typeof s.name === "string" && s.name !== "" ? s.name.slice(0, 100) : "(名前なし)";
  const color = typeof s.color === "string" && COLOR_PATTERN.test(s.color) ? s.color : colorFor(userId ?? String(clientId));
  const boardId = typeof s.boardId === "string" ? s.boardId : null;
  let selection: Selection = null;
  const sel = s.selection as { type?: unknown; id?: unknown } | null | undefined;
  if (sel && typeof sel.id === "string" && (sel.type === "element" || sel.type === "relation")) selection = { type: sel.type, id: sel.id };
  return { clientId, userId, name, color, boardId, selection };
}

function samePeer(a: Peer, b: Peer): boolean {
  return (
    a.userId === b.userId &&
    a.name === b.name &&
    a.color === b.color &&
    a.boardId === b.boardId &&
    a.selection?.type === b.selection?.type &&
    a.selection?.id === b.selection?.id
  );
}

/**
 * プレゼンスをつなぐ。自分の { userId, name, color, boardId, selection } を awareness に出し、
 * ストアの currentBoardId / selection が変わるたびに更新する。他の人の状態は peers としてストアへ写す。
 * 戻り値で解除し、自分の状態を消す
 */
export function attachPresence(awareness: Awareness, identity: PresenceIdentity): () => void {
  const store = useUntieStore;
  const color = colorFor(identity.userId ?? String(awareness.clientID));
  const current = () => {
    const { ui } = store.getState();
    return { boardId: ui.currentBoardId, selection: ui.selection };
  };
  awareness.setLocalState({ userId: identity.userId, name: identity.name, color, ...current() });

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.ui.currentBoardId !== prev.ui.currentBoardId) awareness.setLocalStateField("boardId", state.ui.currentBoardId);
    if (state.ui.selection !== prev.ui.selection) awareness.setLocalStateField("selection", state.ui.selection);
  });

  const sync = () => {
    const previous = new Map(store.getState().peers.map((p) => [p.clientId, p]));
    const peers: Peer[] = [];
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return;
      const peer = toPeer(clientId, state);
      if (!peer) return;
      // 自分の別のタブは、他の人として数えない (ゲストは userId が無いので clientId で区別する)
      if (identity.userId !== null && peer.userId === identity.userId) return;
      // 変わっていない人は同じ参照を使い回す (選択の変化を読むカードの再描画を、変わった分だけにする)
      const before = previous.get(clientId);
      peers.push(before && samePeer(before, peer) ? before : peer);
    });
    peers.sort((a, b) => a.clientId - b.clientId);
    const current = store.getState().peers;
    if (peers.length === current.length && peers.every((p, i) => p === current[i])) return;
    store.getState().setPeers(peers);
  };
  // 自分の状態を書き換えただけの change (選択のたびに起きる) では、組み立て直さない
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if ([...added, ...updated, ...removed].every((id) => id === awareness.clientID)) return;
    sync();
  };
  awareness.on("change", onChange);
  sync();

  return () => {
    awareness.off("change", onChange);
    unsubscribe();
    awareness.setLocalState(null);
    store.getState().setPeers([]);
  };
}

// ---------------------------------------------------------------- 接続

interface Opened {
  fileId: string;
  doc: Y.Doc;
  provider: YProvider;
  detach: () => void;
  stopPresence: () => void;
}

let opened: Opened | null = null;
/** 開く処理の世代。閉じる・開き直すたびに進め、古い開く処理が結果を捨てられるようにする */
let generation = 0;

/** 接続先のホストとプロトコル。サーバーの URL が空なら、いま開いているページのもの */
function endpoint(): { host: string; protocol: "ws" | "wss" } {
  const origin = getPlatform().serverOrigin();
  const url = new URL(origin || window.location.origin);
  return { host: url.host, protocol: url.protocol === "https:" ? "wss" : "ws" };
}

/** チケットの失敗 (サーバーがもう開かせない) を、閉じられたときと同じ形にする。それ以外の失敗は null */
function closedByTicketError(e: unknown): { code: number; reason: string } | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return { code: CLOSE_UNAUTHENTICATED, reason: e.message };
  if (e.status === 403 || e.status === 404 || e.status === 409) return { code: CLOSE_REMOVED, reason: e.message };
  return null;
}

/**
 * クラウドファイルを開く。チケットを取り (401/403/404/409 ならその ApiError を投げる)、Y.Doc と YProvider をつないでストアに付ける。
 * 開く途中で closeCloudFile() や別の openCloudFile() が呼ばれたら、何も付けずに戻る。
 * 閉じられた (kick など) ときは store の cloud.closed に入れる。呼び出し側が見てホームへ戻す
 */
export async function openCloudFile(fileId: string, options: { link?: string } = {}): Promise<void> {
  closeCloudFile();
  // ファイルを開く前から走っていたローカルの AI エージェントが、開いたクラウドファイルを書き換えないよう止める
  useAgentStore.getState().cancel();
  const mine = ++generation;
  const api = getApi();
  // 5 段階目まではメンバーだけ。link は覚えるだけで、チケットは files.ticket で取る
  const first = await api.files.ticket(fileId);
  if (mine !== generation) return;

  const store = useUntieStore;
  const doc = new Y.Doc();
  const detach = attachCloudDoc(doc, { fileId, role: first.role, link: options.link });
  let provider: YProvider | null = null;
  // attach 以降のどこかで例外になったら、ストアに cloud を残さない
  try {
    // 最初の 1 回は取ったチケットを使い、再接続のたびに取り直す (チケットは 60 秒で切れる)
    let firstTicket: string | null = first.ticket;
    let synced = false;
    let closing = false;
    // 一度切れたら、つなぎ直して同期が済むまでは「切断」のままにする (再接続に失敗し続けても、接続中と出さない)
    let offline = false;

    const close = (closed: { code: number; reason: string }) => {
      if (closing) return;
      closing = true;
      store.getState().setCloudClosed(closed);
      // 再接続させない。Doc とストアは呼び出し側が closeCloudFile() するまで残す
      provider?.disconnect();
    };

    const { host, protocol } = endpoint();
    provider = new YProvider(host, fileId, doc, {
      party: "untie-room",
      protocol,
      disableBc: true,
      connect: false,
      params: async () => {
        if (firstTicket) {
          const ticket = firstTicket;
          firstTicket = null;
          return { ticket };
        }
        try {
          const next = await getApi().files.ticket(fileId);
          // 切れている間に役割が変わっていたら、新しい役割にする
          store.getState().setCloudRole(next.role);
          return { ticket: next.ticket };
        } catch (e) {
          const closed = closedByTicketError(e);
          if (closed) close(closed);
          throw e;
        }
      },
    });
    const p = provider;

    p.on("status", ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
      if (closing || !synced) return;
      if (status === "disconnected") offline = true;
      const next = status === "connected" && p.synced ? "connected" : offline ? "offline" : "connecting";
      if (next === "connected") offline = false;
      store.getState().setCloudStatus(next);
    });
    p.on("sync", (isSynced: boolean) => {
      if (!isSynced || closing) return;
      synced = true;
      offline = false;
      const s = store.getState();
      if (s.cloud?.doc === doc) {
        // 最初の同期で Doc が埋まる。観測側が反映済みでも、取りこぼしがないよう揃えておく
        if (!s.dragBase) s.applyRemoteModel(rebuildModel(doc, s.model));
        s.setCloudStatus("connected");
      }
    });
    p.on("connection-close", (event: CloseEvent) => {
      if (!isFatalClose(event.code)) return;
      close({ code: event.code, reason: event.reason || CLOSE_REASONS[event.code] || "接続が閉じられました" });
    });

    const user = useSessionStore.getState().user;
    const stopPresence = attachPresence(p.awareness, {
      userId: user?.id ?? null,
      name: user ? user.name || user.email.split("@")[0]! : "ゲスト",
    });

    opened = { fileId, doc, provider: p, detach, stopPresence };
    void p.connect().catch(() => {
      // チケットの失敗は params の中で閉じた扱いにしてある。それ以外 (ネットワーク) は provider の再接続に任せる
    });
  } catch (e) {
    provider?.destroy();
    detach();
    doc.destroy();
    throw e;
  }
}

/** 開いているクラウドファイルを閉じる。接続を切り、購読を外し、ストアをサンプルに戻す。開いていなくても呼んでよい */
export function closeCloudFile(): void {
  generation++;
  const o = opened;
  opened = null;
  if (!o) return;
  o.stopPresence();
  o.provider.destroy();
  o.provider.awareness.destroy();
  o.detach();
  o.doc.destroy();
}
