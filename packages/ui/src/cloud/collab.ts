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
  type PresenceEntry,
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
  /** リンクで開いたときのトークン */
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

/** サーバーの一覧を取り直す間隔の下限 (ミリ秒)。awareness の変化が続いても、これより短い間隔では取りにいかない */
export const PRESENCE_REFRESH_MS = 1000;
/** 一覧に載っていない人がいるとき、載るのを待って取り直す回数の上限 (接続の直後は、サーバーの一覧が一歩遅れることがある) */
const PRESENCE_RETRIES = 3;

/** ゲストとして出すときの名前 */
const GUEST_NAME = "ゲスト";

export interface PresenceOptions {
  /**
   * サーバーがいまつながっている人の一覧を返す (接続のチケットから決めた userId・名前。awareness の自己申告と違って偽れない)。
   * 渡すと、他の人の awareness の userId・名前をこれと照らす: 一覧に userId が無い人は「ゲスト」扱い (名前と userId を捨てる)、
   * ある人の名前はサーバーの値を使う。最初の一覧が届くまでは自己申告のまま出す。取れなかったときは前の一覧のまま
   */
  verify?: () => Promise<PresenceEntry[]>;
}

/**
 * プレゼンスをつなぐ。自分の { userId, name, color, boardId, selection } を awareness に出し、
 * ストアの currentBoardId / selection が変わるたびに更新する。他の人の状態は peers としてストアへ写す。
 * `verify` があれば、他の人の userId・名前をサーバーの一覧で照らす (接続の直後と、人が増減・入れ替わったときに取る。
 * 取り直しは PRESENCE_REFRESH_MS に 1 回まで)。戻り値で解除し、自分の状態を消す
 */
export function attachPresence(awareness: Awareness, identity: PresenceIdentity, options: PresenceOptions = {}): () => void {
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

  /** サーバーの一覧。null は「まだ届いていない」 */
  let server: PresenceEntry[] | null = null;
  /** 一覧を取った時点でいた人 (clientId)。あとから来た人は、次の一覧が届くまでは自己申告のまま出す (本物の参加者が一瞬ゲストに見えないように) */
  let covered = new Set<number>();
  /** 一覧を取ったときの、他の人の自己申告 (clientId, userId, 名前) の並び。これが変わらなければ取り直さない */
  let fetchedKey: string | null = null;
  let lastFetchAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fetchSeq = 0;
  let retries = 0;
  let stopped = false;

  /** 自己申告を、サーバーの一覧で照らした Peer にする */
  const verified = (peer: Peer): Peer => {
    if (!options.verify || server === null || !covered.has(peer.clientId)) return peer;
    const entry = peer.userId === null ? undefined : server.find((e) => e.userId === peer.userId);
    if (entry) return peer.name === entry.name ? peer : { ...peer, name: entry.name };
    // 一覧に無い (ゲスト、または userId を偽った人) は、名前も userId も自己申告を捨てて「ゲスト」にする
    return peer.userId === null && peer.name === GUEST_NAME ? peer : { ...peer, userId: null, name: GUEST_NAME };
  };

  const claims = (): Peer[] => {
    const list: Peer[] = [];
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return;
      const peer = toPeer(clientId, state);
      if (peer) list.push(peer);
    });
    return list;
  };
  const claimKey = (list: Peer[]) =>
    list
      .map((p) => `${p.clientId}:${p.userId ?? ""}:${p.name}`)
      .sort()
      .join("|");

  const refreshServer = async () => {
    if (!options.verify || stopped) return;
    timer = null;
    lastFetchAt = Date.now();
    const list = claims();
    fetchedKey = claimKey(list);
    const mine = ++fetchSeq;
    try {
      const entries = await options.verify();
      // 古い応答・解除したあとの応答は捨てる
      if (stopped || mine !== fetchSeq) return;
      server = entries;
      covered = new Set(list.map((p) => p.clientId));
    } catch {
      // 取れなかったら前の一覧のまま (取れたことが無ければ自己申告のまま)
      return;
    }
    sync();
    // 一覧に載っていない userId の人がいれば、載るのを待って取り直す (接続の直後は一覧が一歩遅れることがある。回数に上限あり)
    const missing = claims().some((p) => p.userId !== null && !server!.some((e) => e.userId === p.userId));
    if (missing && retries < PRESENCE_RETRIES) {
      retries++;
      fetchedKey = null;
      request();
    } else if (!missing) {
      retries = 0;
    }
  };

  /** 取り直しを頼む。自己申告の顔ぶれが変わっていなければ何もしない。前の取得から間が短ければ、間を空けてから取る */
  const request = () => {
    if (!options.verify || stopped) return;
    if (fetchedKey !== null && claimKey(claims()) === fetchedKey) return;
    if (timer !== null) return;
    const wait = Math.max(0, lastFetchAt + PRESENCE_REFRESH_MS - Date.now());
    if (wait === 0) void refreshServer();
    else timer = setTimeout(() => void refreshServer(), wait);
  };

  const sync = () => {
    const previous = new Map(store.getState().peers.map((p) => [p.clientId, p]));
    const peers: Peer[] = [];
    for (const claimed of claims()) {
      const peer = verified(claimed);
      // 自分の別のタブは、他の人として数えない (ゲストは userId が無いので clientId で区別する)
      if (identity.userId !== null && peer.userId === identity.userId) continue;
      // 変わっていない人は同じ参照を使い回す (選択の変化を読むカードの再描画を、変わった分だけにする)
      const before = previous.get(peer.clientId);
      peers.push(before && samePeer(before, peer) ? before : peer);
    }
    peers.sort((a, b) => a.clientId - b.clientId);
    const current = store.getState().peers;
    if (peers.length === current.length && peers.every((p, i) => p === current[i])) return;
    store.getState().setPeers(peers);
  };
  // 自分の状態を書き換えただけの change (選択のたびに起きる) では、組み立て直さない
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if ([...added, ...updated, ...removed].every((id) => id === awareness.clientID)) return;
    sync();
    request();
  };
  awareness.on("change", onChange);
  sync();
  // 接続の直後。この時点の一覧には、あとから来る人は載っていないので、人が来るたびに request で取り直す
  request();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
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
 * `link` を渡すと、リンクを知っている人の閲覧として開く: チケットは `links.ticket(link)` で取り (再接続のたびも同じ)、
 * ログインしていなければゲスト、メンバーならその役割で開く (サーバーが決める。3.6)。
 * 開く途中で closeCloudFile() や別の openCloudFile() が呼ばれたら、何も付けずに戻る。
 * 閉じられた (kick など) ときは store の cloud.closed に入れる。呼び出し側が見てホームへ戻す
 */
export async function openCloudFile(fileId: string, options: { link?: string } = {}): Promise<void> {
  closeCloudFile();
  // ファイルを開く前から走っていたローカルの AI エージェントが、開いたクラウドファイルを書き換えないよう止める
  useAgentStore.getState().cancel();
  const mine = ++generation;
  const link = options.link;
  // リンクで開くときは links.ticket (セッションが無くてもよい)、メンバーとして開くときは files.ticket
  const fetchTicket = () => (link !== undefined ? getApi().links.ticket(link) : getApi().files.ticket(fileId));
  const first = await fetchTicket();
  if (mine !== generation) return;

  const store = useUntieStore;
  const doc = new Y.Doc();
  const detach = attachCloudDoc(doc, { fileId, role: first.role, link });
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
          const next = await fetchTicket();
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

    // ゲスト (リンクで開いた、メンバーでない人) は、ログインしていても名前を出さない。
    // サーバーが付ける「ゲスト n」の番号は使わず、awareness には自分で「ゲスト」と載せる
    const user = first.role === "guest" ? null : useSessionStore.getState().user;
    const stopPresence = attachPresence(
      p.awareness,
      {
        userId: user?.id ?? null,
        name: user ? user.name || user.email.split("@")[0]! : "ゲスト",
      },
      // 他の人の自己申告は、サーバーがチケットから決めた一覧で照らす (偽れない)
      { verify: () => (link !== undefined ? getApi().links.presence(link) : getApi().files.presence(fileId)) },
    );

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
