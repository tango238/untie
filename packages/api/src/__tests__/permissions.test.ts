import { describe, expect, it } from "vitest";
import { can, ROLE_LABELS } from "../permissions";
import type { Action, Role } from "../permissions";

// 設計書 3.2 の表の行をそのまま写す。○ は true、× は false
const TABLE: Record<Action, Record<Role, boolean>> = {
  // 開く (読む)、プレゼンスに出る
  read: { owner: true, editor: true, viewer: true, guest: true },
  // 編集する
  edit: { owner: true, editor: true, viewer: false, guest: false },
  // JSON に書き出す
  export: { owner: true, editor: true, viewer: true, guest: true },
  // 複製して自分のファイルにする (ゲストはログインすれば ○)
  duplicate: { owner: true, editor: true, viewer: true, guest: true },
  // 名前を変える
  rename: { owner: true, editor: true, viewer: false, guest: false },
  // メンバーを足す・役割を変える・外す、招待する
  manageMembers: { owner: true, editor: false, viewer: false, guest: false },
  // リンク閲覧を有効・無効にする、リンクを作り直す
  manageLink: { owner: true, editor: false, viewer: false, guest: false },
  // 所有者を譲る
  transfer: { owner: true, editor: false, viewer: false, guest: false },
  // ゴミ箱に入れる・戻す・完全に消す
  delete: { owner: true, editor: false, viewer: false, guest: false },
  // 自分をメンバーから外す (所有者は譲ってから、ゲストはメンバーではない)
  leave: { owner: false, editor: true, viewer: true, guest: false },
};

describe("can", () => {
  for (const [action, row] of Object.entries(TABLE) as [Action, Record<Role, boolean>][]) {
    for (const [role, expected] of Object.entries(row) as [Role, boolean][]) {
      it(`${role} は ${action} を${expected ? "できる" : "できない"}`, () => {
        expect(can(role, action)).toBe(expected);
      });
    }
  }

  it("役割が無ければ何もできない", () => {
    expect(can(null, "read")).toBe(false);
    expect(can(undefined, "edit")).toBe(false);
  });

  it("役割の日本語ラベルがある", () => {
    expect(ROLE_LABELS).toEqual({ owner: "所有者", editor: "編集者", viewer: "閲覧者", guest: "ゲスト" });
  });
});
