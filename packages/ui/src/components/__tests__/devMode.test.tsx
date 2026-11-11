// 開発モード (devMode.ts): 内部のドメインモデルを見せる画面は、開発モードのときだけ出す。ふだん (off) は選択肢にも出さず、開けない。
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeContextRelation } from "@untie/core/model/domainCommands";
import { createNetshopSample } from "@untie/core/sample";
import { isBoardAvailable, isDevMode, setDevModeForTest, visibleAnalysisKinds, visibleDesignKinds } from "../../devMode";
import { analysisEntries, designEntries, resolveChordKey } from "../../shortcuts";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { DesignCheckPanel } from "../design/DesignCheckPanel";
import { PropertyPanel } from "../PropertyPanel";
import { Toolbar } from "../Toolbar";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();
const boardOptions = () => [...(screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement).querySelectorAll("option")].map((o) => o.textContent);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixStub {
  m22 = 1;
  constructor(_init?: string) {}
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixStub;
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
  resetStore(createNetshopSample());
  setDevModeForTest(undefined);
});
afterEach(() => setDevModeForTest(undefined));

describe("開発モード", () => {
  it("既定は off。開発用のボード (イベントストーミング・ドメイン・コンテキストマップ) は、選べるボードに入らない", () => {
    expect(isDevMode()).toBe(false);
    expect(visibleAnalysisKinds()).toEqual(["issues", "people", "informationLocation"]);
    expect(visibleDesignKinds()).toEqual(["sitemap", "navigation", "screen", "data", "relation"]);
    for (const id of ["analysis:storming", "design:domain", "design:contextmap"]) expect(isBoardAvailable(id)).toBe(false);
    for (const id of ["analysis:issues", "design:sitemap", "fixed:activity", "board_overview"]) expect(isBoardAvailable(id)).toBe(true);
    setDevModeForTest(true);
    expect(visibleAnalysisKinds()).toContain("storming");
    expect(visibleDesignKinds()).toEqual(["sitemap", "navigation", "screen", "data", "relation", "domain", "contextmap"]);
    expect(isBoardAvailable("design:domain")).toBe(true);
  });

  it("off のとき: ボードの選択肢・ショートカットに出ず、開こうとしても開けない", () => {
    render(<Toolbar />);
    expect(boardOptions()).not.toContain("イベントストーミング");
    act(() => st().enterDesign("sys_oms"));
    const options = boardOptions();
    expect(options.slice(0, 5)).toEqual(["サイトマップ", "ナビゲーション", "画面", "データ", "関連"]);
    expect(options).not.toContain("ドメイン");
    expect(options).not.toContain("コンテキストマップ");
    // ショートカット (E・M・K) も効かない
    expect(analysisEntries().map((e) => e.key)).not.toContain("e");
    expect(designEntries().map((e) => e.key)).toEqual(["s", "v", "g", "t", "r"]);
    for (const key of ["e", "m", "k"]) expect(resolveChordKey(key)).toBeNull();
    // 直に開こうとしても、今のボードのまま
    const before = st().ui.currentBoardId;
    act(() => st().setCurrentBoard("design:domain"));
    act(() => st().setCurrentBoard("design:contextmap"));
    expect(st().ui.currentBoardId).toBe(before);
    act(() => st().enterDesign("sys_accounting", "design:domain"));
    expect(st().ui.currentBoardId).not.toBe("design:domain");
    act(() => st().setMode("analysis"));
    act(() => st().setCurrentBoard("analysis:storming"));
    expect(st().ui.currentBoardId).not.toBe("analysis:storming");
  });

  it("on のとき: 選択肢とショートカットに出て、開ける", () => {
    setDevModeForTest(true);
    render(<App />);
    expect(boardOptions()).toContain("イベントストーミング");
    expect(resolveChordKey("e")).toEqual({ type: "analysis", kind: "storming" });
    act(() => st().enterDesign("sys_oms"));
    expect(boardOptions()).toContain("ドメイン");
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    fireEvent.keyDown(document, { key: "k" });
    expect(st().ui.currentBoardId).toBe("design:contextmap");
  });

  it("off のとき: ドメインモデルの検証・書き出しのメニュー・検証のバッジへの加算を出さない", () => {
    // 関係を 1 つ消して、ドメインモデルの検証に警告が出る状態にする
    act(() => {
      st().dispatch((m) => removeContextRelation(m, { id: "cr_ordering_inventory" }));
      st().enterDesign("sys_oms");
    });
    const { unmount } = render(
      <>
        <Toolbar />
        <DesignCheckPanel />
      </>,
    );
    expect(screen.queryByRole("heading", { name: "検証: ドメインモデル" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^ファイル/ }));
    expect(screen.queryByRole("menuitem", { name: /ドメインモデルを書き出す/ })).toBeNull();
    unmount();
    setDevModeForTest(true);
    render(
      <>
        <Toolbar />
        <DesignCheckPanel />
      </>,
    );
    expect(screen.getByRole("heading", { name: "検証: ドメインモデル" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^ファイル/ }));
    expect(screen.getByRole("menuitem", { name: /ドメインモデルを書き出す/ })).toBeDefined();
    expect(memory().savedFolders).toEqual([]);
  });

  it("off のとき: 要素を消す確認には、内部のドメインモデルの言葉 (集約など) を出さず、1 行にまとめる", () => {
    // 固定ボード (情報) で要素を選ぶと、プロパティ欄に「削除」が出る
    act(() => st().setCurrentBoard("fixed:information"));
    act(() => st().select({ type: "element", id: "info_order" }));
    const { unmount } = render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("実装のための内部の設計 (この要素を使っているところ)");
    expect(dialog.textContent).not.toContain("集約");
    unmount();
    setDevModeForTest(true);
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.getByRole("dialog").textContent).toContain("集約");
  });
});
