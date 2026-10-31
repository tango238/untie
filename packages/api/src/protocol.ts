// ルーム (WebSocket) の取り決め (設計書 7.5)。サーバー (UntieRoom) と画面が同じ値を使う。

/** 接続を閉じるときのコード (RFC 6455 の 4000 番台はアプリが自由に使える) */
export const CLOSE_UNAUTHENTICATED = 4000;
/** 役割が変わった (editor → viewer など)。つなぎ直すとチケットの取得で新しい役割になる */
export const CLOSE_ROLE_CHANGED = 4001;
/** メンバーから外された、またはファイルがゴミ箱に入った。つなぎ直しはチケットの取得で 404 / 409 になる */
export const CLOSE_REMOVED = 4003;
/** リンク閲覧が無効になった・作り直された。つなぎ直しはチケットの取得で 404 になる */
export const CLOSE_LINK_DISABLED = 4004;

/** ログアウトで閉じたときの理由 (4000)。セッションを消すと、そのセッションで開いていたルームの接続を閉じる */
export const LOGGED_OUT_REASON = "ログアウトしました";
/** 使用済みのチケットでつないだときの理由 (4000)。チケットは 1 回しか使えない。画面は再接続のたびにチケットを取り直すので、これは致命的な閉じ方として扱わない */
export const TICKET_USED_REASON = "このチケットは使用済みです";

/** 閉じるコードの一覧 (reason は日本語でそのまま画面に出せる) */
export const CLOSE_CODES = {
  unauthenticated: CLOSE_UNAUTHENTICATED,
  roleChanged: CLOSE_ROLE_CHANGED,
  removed: CLOSE_REMOVED,
  linkDisabled: CLOSE_LINK_DISABLED,
} as const;

/** チケットの有効期間 (ミリ秒)。接続を始めるまでの短い間だけ使える */
export const TICKET_TTL_MS = 60 * 1000;

/** ルームに付けるヘッダー (Worker がチケットを検めたあと、ルームへ渡す Request に付ける) */
export const ROOM_HEADERS = {
  user: "x-untie-user",
  /** URL エンコードして渡す (日本語の名前をヘッダーに載せるため) */
  name: "x-untie-name",
  role: "x-untie-role",
  via: "x-untie-via",
  /** チケットの発行時刻 (エポックミリ秒)。kick より前に発行されたチケットでの再接続を、ルームが断るために使う */
  iat: "x-untie-iat",
  /** セッションのハッシュの先頭 16 文字。ログアウトしたセッションの接続だけを閉じるために使う。リンクで開いたゲストには付けない */
  sid: "x-untie-sid",
  /** チケットの識別子 (乱数)。ルームが 1 回しか使えないようにする */
  jti: "x-untie-jti",
  /** チケットの期限 (エポックミリ秒)。使用済みの記録を残す期間 */
  exp: "x-untie-exp",
} as const;

/** ルームが接続に流す、Y.Doc とは別の知らせ (y-partyserver の custom message。本文は JSON の文字列) */
export type RoomMessage = { type: "save_failed" } | { type: "save_ok" };

/** サーバーに保存できなくなった・できるようになった知らせの本文 */
export const SAVE_FAILED_MESSAGE = JSON.stringify({ type: "save_failed" } satisfies RoomMessage);
export const SAVE_OK_MESSAGE = JSON.stringify({ type: "save_ok" } satisfies RoomMessage);

/** custom message の本文を読む。知らない形は null */
export function parseRoomMessage(text: string): RoomMessage | null {
  try {
    const value = JSON.parse(text) as { type?: unknown } | null;
    if (value && (value.type === "save_failed" || value.type === "save_ok")) return { type: value.type };
  } catch {
    // JSON でない知らせは無視する
  }
  return null;
}

/** チケットの経路。member はログインしたメンバー、link は「リンクを知っている人」の閲覧 (3.6) */
export type TicketVia = "member" | "link";

/** ゲストの表示名の組み立て (番号はルームが、いまつながっているゲストと重ならない最小の番号を振る) */
export const guestName = (n: number) => `ゲスト ${n}`;
