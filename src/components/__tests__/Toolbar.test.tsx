import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveTextFile } from "../../io/file";
import { addElement, removeBoard } from "../../model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { handleKeyDown } from "../useKeyboard";
import { ConfirmDialog } from "../ConfirmDialog";
import { Toolbar, nextBoardName } from "../Toolbar";

vi.mock("../../io/file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../io/file")>()),
  saveTextFile: vi.fn(),
}));

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  vi.mocked(saveTextFile).mockClear();
});

describe("Toolbar", () => {
  it("ファイルの状態を出す。編集すると未保存の印、保存すると消える", () => {
    render(<Toolbar />);
    const status = () => screen.getByRole("status", { name: "ファイルの状態" }).textContent;
    expect(status()).toContain("サンプル");
    expect(status()).not.toContain("保存していない変更");
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "context", name: "x" }));
    });
    expect(status()).toContain("保存していない変更");
    act(() => st().markSaved({ path: "/tmp/a.json", name: "a.json" }, st().model));
    expect(status()).toContain("ファイル: a.json");
    expect(status()).not.toContain("保存していない変更");
    // 取り消すと保存したときと違うので未保存、やり直すと保存したときに戻る
    act(() => st().undo());
    expect(status()).toContain("保存していない変更");
    act(() => st().redo());
    expect(status()).not.toContain("保存していない変更");
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

  it("ボードの選択肢は固定ボード 10 枚・分析ボード・自由ボードに分かれる。固定ボードでは名前変更・削除ができない", () => {
    render(<Toolbar />);
    const select = screen.getByLabelText("ボード") as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["固定ボード", "分析ボード", "自由ボード"]);
    const fixedOptions = Array.from(select.querySelectorAll('optgroup[label="固定ボード"] option')).map((o) => o.textContent);
    expect(fixedOptions).toHaveLength(10);
    // コンテキストはバリエーションの下
    expect(fixedOptions.slice(-2)).toEqual(["バリエーション", "コンテキスト"]);
    // 分析ボードは課題の分布が先頭
    expect(select.querySelector('optgroup[label="分析ボード"] option')!.textContent).toBe("課題の分布");
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

  it("「空にする」ボタンは無い", () => {
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "空にする" })).toBeNull();
  });

  const clickNew = () => {
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /新規作成/ }));
  };

  it("「新規作成」は未保存の変更が無ければ確認せずに空のモデルにし、未保存の印は付かない", () => {
    render(<Toolbar />);
    clickNew();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(st().model.elements).toEqual([]);
    expect(st().model.boards).toHaveLength(1);
    expect(st().file).toBeNull();
    expect(st().history.past).toEqual([]);
    expect(screen.getByRole("status", { name: "ファイルの状態" }).textContent).not.toContain("保存していない変更");
  });

  it("「新規作成」は未保存の変更があれば保存を促す。キャンセルなら何もしない、保存せずに新規作成なら捨てる", () => {
    render(<Toolbar />);
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "context", name: "x" }));
    });
    clickNew();
    const dialog = screen.getByRole("dialog", { name: "新規作成" });
    expect(dialog.textContent).toContain("保存しますか");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(st().model.elements.length).toBeGreaterThan(0);
    clickNew();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存せずに新規作成" }));
    expect(st().model.elements).toEqual([]);
    expect(saveTextFile).not.toHaveBeenCalled();
  });

  it("「保存して新規作成」は保存してから空にする。保存を取り消したら今のモデルを残す", async () => {
    render(<Toolbar />);
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "context", name: "x" }));
    });
    vi.mocked(saveTextFile).mockResolvedValueOnce(null);
    clickNew();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存して新規作成" }));
    });
    expect(st().model.elements.length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.mocked(saveTextFile).mockResolvedValueOnce({ path: "/tmp/a.json", name: "a.json" });
    clickNew();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存して新規作成" }));
    });
    expect(saveTextFile).toHaveBeenCalledTimes(2);
    expect(st().model.elements).toEqual([]);
    expect(st().file).toBeNull();
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

  it("「検証」で検証パネルを開閉し、辿り着けない要素の数を出す", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "context", name: "空のコンテキスト" }));
    });
    render(<Toolbar />);
    const btn = screen.getByRole("button", { name: /^検証/ });
    expect(btn.textContent).toBe("検証1");
    fireEvent.click(btn);
    expect(st().ui.rightPanel).toBe("trace");
    fireEvent.click(btn);
    expect(st().ui.rightPanel).toBe("properties");
  });
  it("「ファイル」メニューに新規作成・開く・保存・別名で保存・プロンプトから作成・AI の設定があり、プロンプトから作成でダイアログを開く", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["新規作成", "開く…⌘O", "最近開いたファイル▸", "保存⌘S", "別名で保存…⇧⌘S", "プロンプトから作成…", "AI の設定…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /プロンプトから作成/ }));
    expect(screen.getByRole("dialog", { name: "プロンプトから作成" })).toBeDefined();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("「最近開いたファイル」にフォーカスするとサブメニューが開き、選ぶとそのファイルを開く。ほかの項目に移ると閉じる", async () => {
    const recent = await import("../../io/recent");
    const doc = await import("../../io/document");
    const entries = [
      { name: "a.json", path: "/docs/x/a.json" },
      { name: "b.json", path: "/docs/y/b.json" },
    ];
    const load = vi.spyOn(recent, "loadRecentFiles").mockResolvedValue(entries);
    const openRecent = vi.spyOn(doc, "openRecentDocument").mockResolvedValue();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      render(<Toolbar />);
      fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
      await act(async () => {});
      const trigger = screen.getByRole("menuitem", { name: /最近開いたファイル/ });
      expect(screen.queryByRole("menu", { name: "最近開いたファイル" })).toBeNull();
      fireEvent.focus(trigger);
      const sub = screen.getByRole("menu", { name: "最近開いたファイル" });
      expect(within(sub).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["a.jsonx", "b.jsony", "一覧を消去"]);
      fireEvent.focus(screen.getByRole("menuitem", { name: /保存⌘S/ }));
      expect(screen.queryByRole("menu", { name: "最近開いたファイル" })).toBeNull();
      fireEvent.mouseEnter(trigger);
      fireEvent.click(within(screen.getByRole("menu", { name: "最近開いたファイル" })).getByRole("menuitem", { name: /b\.json/ }));
      expect(openRecent).toHaveBeenCalledWith(entries[1]);
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      load.mockRestore();
      openRecent.mockRestore();
    }
  });

  it("「AI」で下の AI エージェントのペインを開閉する", async () => {
    const { useAgentStore } = await import("../../ai/agentStore");
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(useAgentStore.getState().open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(useAgentStore.getState().open).toBe(false);
  });
});

describe("Untie について", () => {
  it("左上の「Untie」で、アイコン・説明・バージョンのダイアログが開き、閉じられる", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Untie" }));
    const dialog = screen.getByRole("dialog", { name: "Untie について" });
    expect(within(dialog).getByText(/^バージョン \d+\.\d+\.\d+$/).textContent).toBe("バージョン 0.1.0");
    expect(within(dialog).getByText(/困りごとが業務のどこに潜んでいるか/)).toBeDefined();
    expect(dialog.querySelector("img.about-icon")?.getAttribute("src")).toBe("/icon.png");
    expect(within(dialog).getByText(/開発者: Go Tanaka/)).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "x.com/tan_go238" })).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog", { name: "Untie について" })).toBeNull();
  });
});
