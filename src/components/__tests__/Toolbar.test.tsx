import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { handleKeyDown } from "../useKeyboard";
import { ConfirmDialog } from "../ConfirmDialog";
import { Toolbar } from "../Toolbar";

const st = () => useUntieStore.getState();

beforeEach(() => resetStore());

describe("Toolbar", () => {
  it("保存しない旨の注意書きを常に出す", () => {
    render(<Toolbar />);
    expect(screen.getByRole("note").textContent).toContain("保存しません");
  });

  it("ボードを切り替えられる", () => {
    render(<Toolbar />);
    fireEvent.change(screen.getByLabelText("ボード"), { target: { value: "board_flow" } });
    expect(st().ui.currentBoardId).toBe("board_flow");
  });

  it("ボードを追加すると、そのボードに切り替わる", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    expect(st().model.boards).toHaveLength(4);
    expect(st().ui.currentBoardId).toBe(st().model.boards[3]!.id);
  });

  it("ボード名を変更できる (Esc で取り消し)", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "名前変更" }));
    const input = screen.getByLabelText("ボード名");
    fireEvent.change(input, { target: { value: "新しい名前" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(st().model.boards[0]!.name).toBe("全体");
    fireEvent.click(screen.getByRole("button", { name: "名前変更" }));
    fireEvent.change(screen.getByLabelText("ボード名"), { target: { value: "俯瞰" } });
    fireEvent.click(screen.getByRole("button", { name: "決定" }));
    expect(st().model.boards[0]!.name).toBe("俯瞰");
  });

  it("ボード削除は確認ダイアログを経る。最後の 1 枚は削除できない", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ボード削除" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(st().model.boards).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "ボード削除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除する" }));
    expect(st().model.boards).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ボードが 1 枚のときは削除ボタンが使えない", () => {
    const m = st().model;
    resetStore({ ...m, boards: [m.boards[0]!] });
    render(<Toolbar />);
    expect((screen.getByRole("button", { name: "ボード削除" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("「追加」メニューに 11 種が並び、選ぶと要素を作って選択する", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: /＋追加/ }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(11);
    fireEvent.click(screen.getByRole("menuitem", { name: "アクター" }));
    const sel = st().ui.selection!;
    expect(sel.type).toBe("element");
    const created = st().model.elements.find((e) => e.id === sel.id)!;
    expect(created).toMatchObject({ kind: "actor", name: "新しいアクター" });
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === created.id)).toBe(true);
    expect(st().ui.nameFocusNonce).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("課題はボードに置かない。BUC は業務が無いと作れない", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: /＋追加/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "課題" }));
    const issue = st().model.elements.find((e) => e.id === st().ui.selection!.id)!;
    expect(issue.kind).toBe("issue");
    expect(st().model.boards.every((b) => b.nodes.every((n) => n.elementId !== issue.id))).toBe(true);

    resetStore({ ...st().model, elements: [], relations: [] });
    fireEvent.click(screen.getByRole("button", { name: /＋追加/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "BUC" }));
    expect(st().toasts[0]!.message).toContain("業務");
  });

  it("Undo / Redo ボタンは履歴に応じて有効になり、操作できる", () => {
    render(<Toolbar />);
    const undo = screen.getByRole("button", { name: "元に戻す" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "やり直す" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /＋追加/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "条件" }));
    expect(undo.disabled).toBe(false);
    const count = st().model.elements.length;
    fireEvent.click(undo);
    expect(st().model.elements.length).toBe(count - 1);
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(st().model.elements.length).toBe(count);
  });

  it("「課題一覧」で右パネルを切り替える", () => {
    render(<Toolbar />);
    const btn = screen.getByRole("button", { name: "課題一覧" });
    fireEvent.click(btn);
    expect(st().ui.rightPanel).toBe("issues");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("「空にする」は確認のあと全て消し、Undo で戻せる", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "空にする" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    expect(st().model.elements.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "空にする" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "空にする" }));
    expect(st().model.elements).toEqual([]);
    expect(st().model.boards).toHaveLength(1);
    expect(st().ui.currentBoardId).toBe(st().model.boards[0]!.id);
    st().undo();
    expect(st().model.elements.length).toBeGreaterThan(0);
  });
});

describe("ConfirmDialog", () => {
  it("Esc でキャンセルされる", () => {
    let cancelled = false;
    render(<ConfirmDialog title="t" message="m" onCancel={() => (cancelled = true)} onConfirm={() => {}} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(cancelled).toBe(true);
  });
});

describe("キーボードショートカット", () => {
  const key = (init: KeyboardEventInit, target: HTMLElement = document.body) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, "target", { value: target });
    handleKeyDown(e);
  };

  it("Cmd/Ctrl+Z で Undo、Shift 付きで Redo", () => {
    st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変更" } } }));
    key({ key: "z", metaKey: true });
    expect(st().model.meta.name).not.toBe("変更");
    key({ key: "z", ctrlKey: true, shiftKey: true });
    expect(st().model.meta.name).toBe("変更");
  });

  it("入力欄にフォーカス中は無視する", () => {
    st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変更" } } }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    key({ key: "z", metaKey: true }, input);
    expect(st().model.meta.name).toBe("変更");
    input.remove();
  });

  it("Delete で選択中のノードをボードから外し、線なら関係を消す", () => {
    st().select({ type: "element", id: "actor_front" });
    key({ key: "Delete" });
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === "actor_front")).toBe(false);
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(true);
    const rel = st().model.relations[0]!;
    st().select({ type: "relation", id: rel.id });
    key({ key: "Backspace" });
    expect(st().model.relations.some((r) => r.id === rel.id)).toBe(false);
  });
});
