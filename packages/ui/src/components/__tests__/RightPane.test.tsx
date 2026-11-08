import { fireEvent, render, screen } from "@testing-library/react";
import { createHotelSample } from "@untie/core/sample";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { Toolbar } from "../Toolbar";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  // React Flow を使わない固定ボードで確かめる
  st().setCurrentBoard("fixed:activity");
});

describe("右のペイン", () => {
  it("閉じると中身を隠して細い帯だけにし、帯かボタンで開き直せる", () => {
    const { container } = render(<App />);
    expect(screen.getByRole("complementary", { name: "プロパティ" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    expect(st().ui.rightPanelOpen).toBe(false);
    expect(screen.queryByRole("complementary", { name: "プロパティ" })).toBeNull();
    expect(container.querySelector(".main")!.classList.contains("panel-closed")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "プロパティ" }));
    expect(screen.getByRole("complementary", { name: "プロパティ" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "右のペインを開く" }));
    expect(st().ui.rightPanelOpen).toBe(true);
  });

  it("閉じているとき「課題一覧」を押すと、開いて課題一覧を出す", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "課題一覧" }));
    expect(screen.getByRole("complementary", { name: "課題一覧" })).toBeDefined();
  });
});

/** 狭い画面 (スマートフォン) では、ペインが画面の上に重なるドロワーになる (見た目は CSS。ここでは開閉の状態を確かめる) */
describe("狭い画面のペイン", () => {
  const original = window.matchMedia;
  const setNarrow = (narrow: boolean) => {
    window.matchMedia = ((query: string) => ({ matches: narrow && query.includes("max-width"), media: query })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
  });

  it("ファイルを開いた直後はペインを閉じ、広い画面では右のペインを開いておく", () => {
    setNarrow(true);
    st().newDocument(createHotelSample(), { pristine: true });
    expect(st().ui.rightPanelOpen).toBe(false);
    expect(st().ui.elementListOpen).toBe(false);
    setNarrow(false);
    st().newDocument(createHotelSample(), { pristine: true });
    expect(st().ui.rightPanelOpen).toBe(true);
  });

  it("ツールバーのボタンでペインを開き、外側の幕を押すと閉じる", () => {
    setNarrow(true);
    st().newDocument(createHotelSample(), { pristine: true });
    st().setCurrentBoard("fixed:activity");
    render(<App />);
    expect(screen.queryByTestId("pane-backdrop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "プロパティを表示" }));
    expect(st().ui.rightPanelOpen).toBe(true);
    expect(st().ui.rightPanel).toBe("properties");
    fireEvent.click(screen.getByTestId("pane-backdrop"));
    expect(st().ui.rightPanelOpen).toBe(false);
    expect(screen.queryByTestId("pane-backdrop")).toBeNull();
  });

  it("閉じているとき「課題一覧」を押すと、すでに課題一覧でも開く", () => {
    st().setRightPanel("issues");
    st().setRightPanelOpen(false);
    render(<App />);
    // 閉じた帯にも同じ名前のボタンがあるので、ツールバーの方 (aria-pressed を持つ) を押す
    fireEvent.click(screen.getAllByRole("button", { name: "課題一覧" }).find((b) => b.hasAttribute("aria-pressed"))!);
    expect(st().ui.rightPanelOpen).toBe(true);
    expect(st().ui.rightPanel).toBe("issues");
  });

  it("自由ボードでは「要素一覧」ボタンで左のペインを開閉できる (固定ボードには出さない)", () => {
    st().setElementListOpen(false);
    st().setCurrentBoard(st().model.boards[0]!.id);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "要素一覧を表示" }));
    expect(st().ui.elementListOpen).toBe(true);
    expect(screen.getByRole("button", { name: "要素一覧を隠す" })).toBeDefined();
  });
});
