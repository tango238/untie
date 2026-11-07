import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDesign, removeElement } from "@untie/core/model/commands";
import { emptyModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { loadLastDesignSystemId, saveLastDesignSystemId } from "../../store/designPrefs";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { Toolbar } from "../Toolbar";

// キャンバス (ResizeObserver を使う) は代役にする
vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

const openModeMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /^モード/ }));
  return screen.getByRole("menu", { name: "モード" });
};
const boardOptions = () => within(screen.getByLabelText("ボード")).getAllByRole("option").map((o) => o.textContent);

describe("モードのメニュー", () => {
  it("ファイルメニューに「モード」があり、分析・設計を並べて今のモードに ✓ を付ける", () => {
    render(<Toolbar />);
    const sub = openModeMenu();
    const items = within(sub).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["分析✓", "設計"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("設計を選ぶとシステムの選択が出て、選ぶと設計モードのサイトマップへ移る", () => {
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    const dialog = screen.getByRole("dialog", { name: "システムの選択" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /宿泊管理システム/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "設計する" }));
    expect(screen.queryByRole("dialog", { name: "システムの選択" })).toBeNull();
    expect(st().ui.mode).toBe("design");
    expect(st().ui.designSystemId).toBe("sys_pms");
    expect(st().ui.currentBoardId).toBe("design:sitemap");
    // 設計モードに入るだけではモデルに書かない (設計と既定のデータベースは、最初の編集が ensureDesign で作る)
    expect(st().model.designs).toEqual([]);
    expect(st().model.databases).toEqual([]);
    expect(st().history.past).toHaveLength(0);
    expect(loadLastDesignSystemId()).toBe("sys_pms");
    // メニューの印が移る
    const sub = openModeMenu();
    expect(within(sub).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["分析", "設計✓"]);
  });

  it("キャンセルしたら分析モードのまま、設計も足さない", () => {
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog", { name: "システムの選択" })).toBeNull();
    expect(st().ui.mode).toBe("analysis");
    expect(st().model.designs).toEqual([]);
  });

  it("分析を選ぶと分析モード (analysis:issues) に戻る。対象のシステムが決まっていれば、設計は選択なしで戻れる", () => {
    render(<Toolbar />);
    act(() => st().enterDesign("sys_pms"));
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "分析" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("analysis:issues");
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(st().ui.mode).toBe("design");
  });
});

describe("システムの選択", () => {
  it("すべてのシステムを名前順に並べ、設計があるものに「設計あり」を付ける", () => {
    act(() => {
      st().dispatch((m) => ensureDesign(m, { systemId: "sys_booking_site" }));
    });
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    const rows = within(screen.getByRole("dialog", { name: "システムの選択" })).getAllByRole("radio");
    const names = rows.map((r) => r.closest("label")!.textContent);
    const expected = st()
      .model.elements.filter((e) => e.kind === "system")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "ja"));
    expect(names.map((n) => n!.replace("設計あり", ""))).toEqual(expected);
    expect(names.filter((n) => n!.includes("設計あり"))).toEqual(["予約サイト設計あり"]);
  });

  it("初期選択は最後に設計したシステム (モデルにあるときだけ)", () => {
    saveLastDesignSystemId("sys_accounting");
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    expect((screen.getByRole("radio", { name: /会計システム/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("覚えていたシステムがモデルに無ければ、何も選ばれず、決定は押せない", () => {
    saveLastDesignSystemId("sys_gone");
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole("button", { name: "設計する" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("システムが 1 つもないときは案内を出し、選べない", () => {
    resetStore(emptyModel());
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    const dialog = screen.getByRole("dialog", { name: "システムの選択" });
    expect(within(dialog).getByText("システムがまだありません。登場人物ボードでシステムを足してください。")).toBeDefined();
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect((within(dialog).getByRole("button", { name: "設計する" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(st().ui.mode).toBe("analysis");
  });
});

describe("キーボード操作", () => {
  it("システムの選択は、選ばれているラジオ (無ければ先頭) にフォーカスし、Enter (フォームの送信) で決定できる", () => {
    saveLastDesignSystemId("sys_accounting");
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /会計システム/ }));
    fireEvent.submit(screen.getByRole("dialog", { name: "システムの選択" }).querySelector("form")!);
    expect(st().ui.mode).toBe("design");
    expect(st().ui.designSystemId).toBe("sys_accounting");
  });

  it("何も選ばれていなければ先頭のラジオにフォーカスし、送信しても何も起きない", () => {
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    const first = screen.getAllByRole("radio")[0]!;
    expect(document.activeElement).toBe(first);
    fireEvent.submit(screen.getByRole("dialog", { name: "システムの選択" }).querySelector("form")!);
    expect(st().ui.mode).toBe("analysis");
  });

  it("「モード」を → で開くと、今のモード (✓) の項目へフォーカスが移る", async () => {
    render(<Toolbar />);
    act(() => st().enterDesign("sys_pms"));
    fireEvent.click(screen.getByRole("button", { name: "ファイル ▾" }));
    const trigger = screen.getByRole("menuitem", { name: /^モード/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: /設計/ })));
  });
});

describe("設計モードのツールバー", () => {
  it("ボードの select は設計ボード + 自由ボードだけ。分析モードでは固定ボード + 分析ボード + 自由ボード", () => {
    render(<Toolbar />);
    expect(boardOptions()).toContain("課題の分布");
    expect(boardOptions()).not.toContain("サイトマップ");
    act(() => st().enterDesign("sys_pms"));
    const options = boardOptions();
    expect(options.slice(0, 4)).toEqual(["サイトマップ", "レイアウト", "画面", "データ"]);
    expect(options).toHaveLength(4 + st().model.boards.length);
    expect(options).not.toContain("課題の分布");
    expect(within(screen.getByLabelText("ボード")).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["設計ボード", "自由ボード"]);
  });

  it("「設計: ○○」のボタンを出し、押すと同じダイアログで切り替えられる。キャンセルすれば今のまま", () => {
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: /^設計:/ })).toBeNull();
    act(() => st().enterDesign("sys_pms"));
    const button = screen.getByRole("button", { name: "設計: 宿泊管理システム" });
    fireEvent.click(button);
    let dialog = screen.getByRole("dialog", { name: "システムの選択" });
    // 切り替え中の初期選択は今のシステム
    expect((within(dialog).getByRole("radio", { name: /宿泊管理システム/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /会計システム/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(st().ui.designSystemId).toBe("sys_pms");

    fireEvent.click(button);
    dialog = screen.getByRole("dialog", { name: "システムの選択" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /会計システム/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "設計する" }));
    expect(st().ui.designSystemId).toBe("sys_accounting");
    expect(screen.getByRole("button", { name: "設計: 会計システム" })).toBeDefined();
  });

  it("サイトマップは案内を、データは DSL のエディタを、レイアウトは仮置きの画面を出す。ボードを切り替えると名前が変わる", () => {
    render(<App />);
    act(() => st().enterDesign("sys_pms"));
    const board = screen.getByRole("region", { name: "設計ボード: サイトマップ" });
    expect(within(board).getByText("左の一覧で活動や作業を選ぶと、関連する画面が遷移と一緒に加わります")).toBeDefined();
    fireEvent.change(screen.getByLabelText("ボード"), { target: { value: "design:layout" } });
    expect(within(screen.getByRole("region", { name: "設計ボード: レイアウト" })).getByText("この画面は次の段階で作ります")).toBeDefined();
    fireEvent.change(screen.getByLabelText("ボード"), { target: { value: "design:data" } });
    // データボードは DSL のエディタ (データベースがまだ無いので案内を出す)
    expect(within(screen.getByRole("region", { name: "DSL の編集" })).getByText(/＋データベース/)).toBeDefined();
    // 設計ボードでは名前変更・ボード削除は押せない
    expect((screen.getByRole("button", { name: "名前変更" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("対象のシステムが消えると分析に戻り、「設計: ○○」も消える", () => {
    render(<Toolbar />);
    act(() => st().enterDesign("sys_pms"));
    act(() => {
      st().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    });
    expect(screen.queryByRole("button", { name: /^設計:/ })).toBeNull();
    expect(st().ui.mode).toBe("analysis");
  });

  it("設計モードでは「課題一覧」ボタンを出さず、課題一覧のペインをプロパティに替えて開く。「検証」は今のまま", () => {
    act(() => st().setRightPanel("issues"));
    render(<Toolbar />);
    expect(screen.getByRole("button", { name: "課題一覧" })).toBeDefined();
    act(() => st().enterDesign("sys_pms"));
    expect(screen.queryByRole("button", { name: "課題一覧" })).toBeNull();
    expect(screen.getByRole("button", { name: /^検証/ })).toBeDefined();
    expect(st().ui.rightPanelOpen).toBe(true);
    expect(st().ui.rightPanel).toBe("properties");
    act(() => st().setMode("analysis"));
    expect(screen.getByRole("button", { name: "課題一覧" })).toBeDefined();
  });

  it("閲覧専用でも設計は見られる (モードは移れる)", () => {
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<Toolbar />);
    fireEvent.click(within(openModeMenu()).getByRole("menuitemradio", { name: "設計" }));
    fireEvent.click(screen.getByRole("radio", { name: /宿泊管理システム/ }));
    fireEvent.click(screen.getByRole("button", { name: "設計する" }));
    expect(st().ui.mode).toBe("design");
    expect(st().model.designs).toEqual([]);
  });
});
