import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_LAYERS } from "@untie/core/model/fixedBoards";
import { ANALYSIS_KINDS } from "@untie/core/model/analysis";
import { DESIGN_BOARD_KINDS } from "@untie/core/model/design";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { ANALYSIS_KEYS, DESIGN_KEYS, FIXED_KEYS, MODE_KEYS } from "../../shortcuts";
import { getPlatform } from "../../platform";
import { isTextEntry } from "../../shortcuts";
import App from "../../App";
import { useShortcutsUi } from "../../store/shortcutsUi";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();
// jsdom は Mac ではないので、修飾キーは Ctrl
const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document) => {
  fireEvent.keyDown(target, { key, ...init });
};
const mod = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document) => press(key, { ctrlKey: true, ...init }, target);
const dialog = () => screen.queryByRole("dialog", { name: "ショートカット" });

beforeEach(() => {
  // 設計ボード (React Flow) が使う
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  useShortcutsUi.setState({ open: false, waiting: false, waitingSince: 0, systemSelect: null });
  resetStore();
  useUntieStore.setState({ cloud: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ショートカットの表", () => {
  it("固定ボード・分析ボード・設計ボードの数とキーが定義と合い、キーは重ならない", () => {
    expect(Object.keys(FIXED_KEYS).sort()).toEqual([...FIXED_LAYERS].sort());
    expect(Object.keys(ANALYSIS_KEYS).sort()).toEqual([...ANALYSIS_KINDS].sort());
    expect(Object.keys(DESIGN_KEYS).sort()).toEqual([...DESIGN_BOARD_KINDS].sort());
    const keys = [...Object.values(MODE_KEYS), ...Object.values(FIXED_KEYS), ...Object.values(ANALYSIS_KEYS), ...Object.values(DESIGN_KEYS)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("ショートカットの一覧", () => {
  it("Ctrl+/ で開閉し、開くとパネルに focus が移る", () => {
    render(<App />);
    expect(dialog()).toBeNull();
    mod("/");
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(document.activeElement).toBe(d);
    expect(within(d).getByRole("heading", { name: "ショートカット" })).toBeTruthy();
    expect(within(d).queryByText("移りたいボードのキーを押してください")).toBeNull();
    mod("/");
    expect(dialog()).toBeNull();
  });

  it("Esc・幕のクリック・閉じるボタンで閉じる", () => {
    render(<App />);
    mod("/");
    press("Escape");
    expect(dialog()).toBeNull();
    mod("/");
    fireEvent.click(dialog()!.parentElement!);
    expect(dialog()).toBeNull();
    mod("/");
    fireEvent.click(within(dialog()!).getByRole("button", { name: "閉じる" }));
    expect(dialog()).toBeNull();
  });

  it("ファイルメニューの「ショートカット一覧」から開く", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /ショートカット一覧/ }));
    expect(dialog()).not.toBeNull();
  });

  it("入力欄にフォーカスがあるときは拾わない", () => {
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mod("/", {}, input);
    mod("b", {}, input);
    expect(dialog()).toBeNull();
    input.remove();
  });

  it("IME の変換中は拾わない", () => {
    render(<App />);
    mod("/", { isComposing: true });
    expect(dialog()).toBeNull();
  });

  it("行を押すとそのボードへ移って閉じる。いまのボードの行は強調する", () => {
    render(<App />);
    mod("/");
    const current = within(dialog()!).getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "true");
    expect(current.map((b) => b.textContent)).toEqual([expect.stringContaining("分析"), expect.stringContaining("全体")]);
    fireEvent.click(within(dialog()!).getByRole("button", { name: /操作/ }));
    expect(dialog()).toBeNull();
    expect(st().ui.currentBoardId).toBe("fixed:usecase");
  });

  it("自由ボードを名前で並べ、押すと移る", () => {
    render(<App />);
    mod("/");
    fireEvent.click(within(dialog()!).getByRole("button", { name: "全体" }));
    expect(st().ui.currentBoardId).toBe("board_overview");
  });
});

describe("コード (Ctrl+B)", () => {
  it("Ctrl+B でキー待ちの一覧が開き、5 で操作ボードへ移って閉じる", () => {
    render(<App />);
    mod("b");
    expect(within(dialog()!).getByText("移りたいボードのキーを押してください")).toBeTruthy();
    press("5");
    expect(dialog()).toBeNull();
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:usecase");
  });

  it("分析ボードのキー (I) へ移る", () => {
    render(<App />);
    mod("b");
    press("i");
    expect(st().ui.currentBoardId).toBe("analysis:issues");
  });

  it("S: システムが未定なら選択ダイアログを出し、選ぶとサイトマップへ移る", () => {
    render(<App />);
    mod("b");
    press("s");
    expect(dialog()).toBeNull();
    const sel = screen.getByRole("dialog", { name: "システムの選択" });
    expect(st().ui.mode).toBe("analysis");
    fireEvent.click(within(sel).getByRole("radio", { name: /宿泊管理システム/ }));
    fireEvent.click(within(sel).getByRole("button", { name: "設計する" }));
    expect(st().ui.mode).toBe("design");
    expect(st().ui.currentBoardId).toBe("design:sitemap");
  });

  it("設計ボードのキーは、システムが決まっていればそのボードへ移る(ダイアログなし)", () => {
    render(<App />);
    act(() => st().enterDesign("sys_pms"));
    mod("b");
    press("t");
    expect(screen.queryByRole("dialog", { name: "システムの選択" })).toBeNull();
    expect(st().ui.currentBoardId).toBe("design:data");
    mod("b");
    press("a");
    expect(st().ui.mode).toBe("analysis");
  });

  it("システム未定でも、選択ダイアログで選んだあと指定したボード (R: 関連) へ移る", () => {
    render(<App />);
    mod("b");
    press("r");
    const sel = screen.getByRole("dialog", { name: "システムの選択" });
    fireEvent.click(within(sel).getByRole("radio", { name: /宿泊管理システム/ }));
    fireEvent.click(within(sel).getByRole("button", { name: "設計する" }));
    expect(st().ui.currentBoardId).toBe("design:relation");
  });

  it("表に無いキーと Esc は取り消して閉じる", () => {
    render(<App />);
    mod("b");
    press("z");
    expect(dialog()).toBeNull();
    expect(st().ui.currentBoardId).toBe("board_overview");
    mod("b");
    press("Escape");
    expect(dialog()).toBeNull();
  });

  it("3 秒たってもキーが押されなければキー待ちを解く (一覧は開いたまま)", () => {
    vi.useFakeTimers();
    render(<App />);
    mod("b");
    expect(screen.queryByText("移りたいボードのキーを押してください")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(3100));
    expect(screen.queryByText("移りたいボードのキーを押してください")).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it("修飾キーだけの押下ではキー待ちを取り消さない", () => {
    render(<App />);
    mod("b");
    press("Control", { ctrlKey: true });
    expect(dialog()).not.toBeNull();
  });

  it("入力欄では Ctrl+B を拾わない", () => {
    render(<App />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    mod("b", {}, ta);
    expect(dialog()).toBeNull();
    ta.remove();
  });

  it("閲覧専用でも移動できる", () => {
    render(<App />);
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    mod("b");
    press("2");
    expect(st().ui.currentBoardId).toBe("fixed:business");
  });
});

describe("キー待ちと既存のキー処理", () => {
  it("Ctrl+B → Ctrl+S: 保存も移動も起きず、閉じるだけ", () => {
    const save = vi.fn().mockResolvedValue(null);
    getPlatform().saveTextFile = save;
    render(<App />);
    mod("b");
    mod("s");
    expect(dialog()).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(st().ui.currentBoardId).toBe("board_overview");
  });

  it("Ctrl+B → Ctrl+Z: Undo は起きない", () => {
    render(<App />);
    act(() => void st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "変更" } } })));
    const past = st().history.past.length;
    expect(past).toBe(1);
    mod("b");
    mod("z");
    expect(dialog()).toBeNull();
    expect(st().history.past.length).toBe(past);
  });

  it("Ctrl+B を続けて押すと待ち直し、3 秒を数え直す", () => {
    vi.useFakeTimers();
    render(<App />);
    mod("b");
    act(() => void vi.advanceTimersByTime(2000));
    mod("b");
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.queryByText("移りたいボードのキーを押してください")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1200));
    expect(screen.queryByText("移りたいボードのキーを押してください")).toBeNull();
  });

  it("キー待ち中の Tab はキー待ちを解くだけで、一覧は開いたまま", () => {
    render(<App />);
    mod("b");
    press("Tab");
    expect(dialog()).not.toBeNull();
    expect(screen.queryByText("移りたいボードのキーを押してください")).toBeNull();
  });
});

describe("拾う・拾わない", () => {
  it("ほかのモーダルなダイアログの上では拾わない", () => {
    render(<App />);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    mod("/");
    mod("b");
    expect(dialog()).toBeNull();
    modal.remove();
  });

  it("Alt 付きは拾わない", () => {
    render(<App />);
    mod("/", { altKey: true });
    expect(dialog()).toBeNull();
  });

  it("Shift 付きの / と ? でも開く", () => {
    render(<App />);
    mod("/", { shiftKey: true });
    expect(dialog()).not.toBeNull();
    mod("?");
    expect(dialog()).toBeNull();
    mod("?", { shiftKey: true });
    expect(dialog()).not.toBeNull();
  });

  it("contenteditable は拾わず、select は拾う", () => {
    render(<App />);
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    document.body.appendChild(div);
    mod("b", {}, div);
    expect(dialog()).toBeNull();
    const select = document.createElement("select");
    document.body.appendChild(select);
    mod("b", {}, select);
    expect(dialog()).not.toBeNull();
    expect(isTextEntry(select)).toBe(false);
    div.remove();
    select.remove();
  });

  it("macOS では Cmd を拾い、Ctrl は拾わない", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<App />);
    press("/", { ctrlKey: true });
    expect(dialog()).toBeNull();
    press("/", { metaKey: true });
    expect(dialog()).not.toBeNull();
    vi.restoreAllMocks();
  });
});

describe("一覧の表示と移動", () => {
  it("閉じたあと、元の要素に focus が戻る", () => {
    render(<App />);
    const btn = screen.getByRole("button", { name: "ホーム" });
    btn.focus();
    mod("/");
    expect(document.activeElement).toBe(dialog());
    press("Escape");
    expect(document.activeElement).toBe(btn);
  });

  it("ファイルメニューから開いて閉じたら、「ファイル」ボタンに focus が戻る", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /ショートカット一覧/ }));
    press("Escape");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ファイル ▾" }));
  });

  it("自由ボードの行を押しても、設計モードのままモードは変わらない", () => {
    render(<App />);
    act(() => st().enterDesign("sys_pms"));
    mod("/");
    fireEvent.click(within(dialog()!).getByRole("button", { name: "全体" }));
    expect(st().ui.mode).toBe("design");
    expect(st().ui.currentBoardId).toBe("board_overview");
  });

  it("クラウドファイルでは、開く・元に戻すを出さず、保存は JSON の書き出しにする", () => {
    useUntieStore.setState({ cloud: { role: "editor" } as never });
    render(<App />);
    mod("/");
    const text = dialog()!.textContent!;
    expect(text).toContain("JSON に書き出す");
    expect(text).not.toContain("元に戻す");
    expect(text).not.toContain("開く");
  });
});
