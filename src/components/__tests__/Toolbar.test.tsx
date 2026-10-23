import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { removeBoard } from "../../model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { handleKeyDown } from "../useKeyboard";
import { ConfirmDialog } from "../ConfirmDialog";
import { Toolbar, nextBoardName } from "../Toolbar";

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

  it("ボードを切り替えたら select のフォーカスを外す (Undo や Delete を効かせるため)", () => {
    render(<Toolbar />);
    const select = screen.getByLabelText("ボード") as HTMLSelectElement;
    select.focus();
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: "board_flow" } });
    expect(document.activeElement).not.toBe(select);
  });

  it("「＋ボード」の既定名は既存のボード名と被らない", () => {
    expect(nextBoardName(["ボード 1", "ボード 3"])).toBe("ボード 4");
    expect(nextBoardName(["ボード 1", "ボード 2", "ボード 3"])).toBe("ボード 4");
    expect(nextBoardName(["全体", "ボード 2"])).toBe("ボード 3");
    expect(nextBoardName(["ボード 3", "x"])).toBe("ボード 4");
    expect(nextBoardName([])).toBe("ボード 1");
  });

  it("ボードを削除したあとに追加しても名前が重複しない", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    const added = st().model.boards[3]!;
    expect(added.name).toBe("ボード 4");
    st().dispatch((m) => removeBoard(m, { id: st().model.boards[1]!.id }));
    expect(st().model.boards).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    expect(st().model.boards).toHaveLength(5);
    const names = st().model.boards.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
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

  it("ボードの選択肢は固定ボード 10 枚と自由ボードに分かれる。固定ボードでは名前変更・削除ができない", () => {
    render(<Toolbar />);
    const select = screen.getByLabelText("ボード") as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["固定ボード", "自由ボード"]);
    expect(select.querySelectorAll('optgroup[label="固定ボード"] option')).toHaveLength(10);
    fireEvent.change(select, { target: { value: "fixed:buc" } });
    expect(st().ui.currentBoardId).toBe("fixed:buc");
    expect((screen.getByRole("button", { name: "名前変更" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "ボード削除" }) as HTMLButtonElement).disabled).toBe(true);
    // ＋ボードは自由ボードを足して切り替える
    fireEvent.click(screen.getByRole("button", { name: "＋ボード" }));
    expect(st().model.boards.some((b) => b.id === st().ui.currentBoardId)).toBe(true);
  });

  it("Undo / Redo ボタンは履歴に応じて有効になり、操作できる", () => {
    render(<Toolbar />);
    const undo = screen.getByRole("button", { name: "元に戻す" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "やり直す" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変更" } } }));
    });
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(st().model.meta.name).not.toBe("変更");
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(st().model.meta.name).toBe("変更");
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

  it("Delete で選択中のノードを自由ボードから外す。線 (関係) は消さない", () => {
    st().select({ type: "element", id: "actor_front" });
    key({ key: "Delete" });
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === "actor_front")).toBe(false);
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(true);
    const rel = st().model.relations[0]!;
    st().select({ type: "relation", id: rel.id });
    key({ key: "Backspace" });
    expect(st().model.relations.some((r) => r.id === rel.id)).toBe(true);
  });

  it("固定ボードでは Delete は何もしない", () => {
    st().setCurrentBoard("fixed:activity");
    st().select({ type: "element", id: "act_hand_key" });
    const before = st().model;
    key({ key: "Delete" });
    expect(st().model).toBe(before);
  });

  it("Ctrl+Y で Redo", () => {
    st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変更" } } }));
    st().undo();
    key({ key: "y", ctrlKey: true });
    expect(st().model.meta.name).toBe("変更");
  });

  it("要素一覧の行 (ボタン) にフォーカス中の Delete は無効", () => {
    st().select({ type: "element", id: "actor_front" });
    const row = document.createElement("button");
    document.body.appendChild(row);
    key({ key: "Delete" }, row);
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === "actor_front")).toBe(true);
    row.remove();
  });

});
