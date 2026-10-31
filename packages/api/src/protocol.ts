// ルーム (WebSocket) の取り決め (設計書 7.5)。サーバー (UntieRoom) と画面が同じ値を使う。

/** 接続を閉じるときのコード (RFC 6455 の 4000 番台はアプリが自由に使える) */
export const CLOSE_UNAUTHENTICATED = 4000;
/** 役割が変わった (editor → viewer など)。つなぎ直すとチケットの取得で新しい役割になる */
export const CLOSE_ROLE_CHANGED = 4001;
/** メンバーから外された、またはファイルがゴミ箱に入った。つなぎ直しはチケットの取得で 404 / 409 になる */
export const CLOSE_REMOVED = 4003;
/** リンク閲覧が無効になった・作り直された。つなぎ直しはチケットの取得で 404 になる */
export const CLOSE_LINK_DISABLED = 4004;

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
} as const;

/** チケットの経路。member はログインしたメンバー、link は「リンクを知っている人」の閲覧 (3.6) */
export type TicketVia = "member" | "link";

/** ゲストの表示名の組み立て (番号はルームが、いまつながっているゲストと重ならない最小の番号を振る) */
export const guestName = (n: number) => `ゲスト ${n}`;
