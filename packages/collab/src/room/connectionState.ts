import type { Role, TicketVia } from "@untie/api";

/**
 * 接続ごとの状態 (connection.state)。Worker がチケットを検めて付けたヘッダーを onConnect が写す (設計書 7.5)。
 * y-partyserver が awareness の管理用に別のキーを足すので、読むときはここで決めたキーだけを見る
 */
export interface ConnectionState {
  /** ログインしている人の id。ゲスト (リンク閲覧でログインしていない人) は null */
  userId: string | null;
  /** 表示名。ゲストはルームが「ゲスト 1」のように、空いている最小の番号で振る */
  name: string;
  role: Role;
  via: TicketVia;
}

/** プレゼンスの 1 人分 (presence() の返り値) */
export interface PresenceEntry {
  userId: string | null;
  name: string;
  role: Role;
}

/** 閉じるコードに添える理由 (画面にそのまま出せる) */
export const CLOSE_REASONS = {
  unauthenticated: "認証されていません",
  roleChanged: "役割が変わりました",
  removed: "共有から外されました",
  trashed: "ファイルがゴミ箱に入りました",
  linkDisabled: "リンクが無効になりました",
} as const;

/**
 * kick の対象。
 * - userId: その人の接続 (複数のタブも)。reason が removed なら 4003、それ以外 (roleChanged、省略) は 4001
 * - via: "link": リンクで入っている接続 (ゲストと、リンクから開いたメンバー)。4004
 * - all: 全員。ファイルがゴミ箱に入ったとき。4003
 */
export type KickTarget = { userId: string; reason?: "roleChanged" | "removed" } | { via: "link" } | { all: true };
