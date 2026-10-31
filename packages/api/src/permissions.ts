// 役割と権限の規則 (設計書 3.2)。サーバーの判定と画面の見せ方がこの 1 か所を共有する。
// 画面側は見せ方を変えるだけで、判定の正本はサーバー。

/** ファイルに対する役割。guest はリンクで閲覧している人 (メンバーではない) */
export type Role = "owner" | "editor" | "viewer" | "guest";

/** D1 の file_members に入る役割 (guest はメンバーにならない) */
export type MemberRole = Exclude<Role, "guest">;

export type Action =
  | "read"
  | "edit"
  | "export"
  | "duplicate"
  | "rename"
  | "manageMembers"
  | "manageLink"
  | "transfer"
  | "delete"
  | "leave";

export const ROLES: readonly Role[] = ["owner", "editor", "viewer", "guest"];
export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "editor", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "所有者",
  editor: "編集者",
  viewer: "閲覧者",
  guest: "ゲスト",
};

// 操作 → その操作ができる役割。設計書 3.2 の表の行をそのまま写している
const ALLOWED: Record<Action, readonly Role[]> = {
  // 開く (読む)、プレゼンスに出る
  read: ["owner", "editor", "viewer", "guest"],
  // 編集する (コマンド、ドラッグ、AI エージェント)
  edit: ["owner", "editor"],
  // JSON に書き出す
  export: ["owner", "editor", "viewer", "guest"],
  // 複製して自分のファイルにする。ゲストはログインが前提 (ログインの確認は呼び出し側)
  duplicate: ["owner", "editor", "viewer", "guest"],
  // 名前を変える
  rename: ["owner", "editor"],
  // メンバーを足す・役割を変える・外す、招待する
  manageMembers: ["owner"],
  // リンク閲覧を有効・無効にする、リンクを作り直す
  manageLink: ["owner"],
  // 所有者を譲る
  transfer: ["owner"],
  // ゴミ箱に入れる・戻す・完全に消す
  delete: ["owner"],
  // 自分をメンバーから外す (所有者は譲ってから。ゲストはメンバーではない)
  leave: ["editor", "viewer"],
};

/** その役割でその操作ができるか */
export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return ALLOWED[action].includes(role);
}
