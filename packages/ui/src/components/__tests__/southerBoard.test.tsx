// 設計ボード「業務ルール (Souther)」: 開発モードのときだけ出す。分析から導いた Souther のソースを見せ、フォルダへ書き出す。
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRelationAlternate } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { isBoardAvailable, setDevModeForTest } from "../../devMode";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { SoutherBoard } from "../design/SoutherBoard";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
  resetStore(createHotelSample());
  setDevModeForTest(true);
  act(() => st().enterDesign("sys_pms"));
});
afterEach(() => setDevModeForTest(undefined));

describe("設計ボード「業務ルール (Souther)」", () => {
  it("開発モードのときだけ、設計ボードの選択肢とショートカット (U) から開ける。右のペインは書き出しの読み方", () => {
    render(<App />);
    const select = screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup[label="設計ボード"] option')].map((o) => o.textContent)).toContain("業務ルール (Souther)");
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    fireEvent.keyDown(document, { key: "u" });
    expect(st().ui.currentBoardId).toBe("design:rules");
    expect(screen.getByRole("region", { name: "設計ボード: 業務ルール (Souther)" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "書き出しの読み方" })).toBeDefined();
  });

  it("開発モードでなければ、選択肢に出さず、開けない", () => {
    setDevModeForTest(false);
    expect(isBoardAvailable("design:rules")).toBe(false);
    render(<App />);
    const select = screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).not.toContain("業務ルール (Souther)");
    act(() => st().setCurrentBoard("design:rules"));
    expect(st().ui.currentBoardId).not.toBe("design:rules");
  });

  it("対象のシステムの操作を Souther のソースで見せ、数と、まだ決まっていない組み合わせを出す", () => {
    const { unmount } = render(<SoutherBoard />);
    const source = screen.getByTestId("souther-source").textContent!;
    expect(source).toContain("module untie.sys_pms");
    expect(source).toContain("behavior 予約を取り消す : (今の予約の状態: 予約の状態, 取消料が発生する: Bool) -> 取消 | 予約を取り消す_取消料が発生する | 予約を取り消す_状態が違う");
    expect(Number(screen.getByTestId("souther-behaviors").textContent)).toBeGreaterThan(5);
    expect(screen.getByTestId("souther-owed").textContent).toBe("0");
    expect(screen.queryByTestId("souther-open")).toBeNull();
    unmount();
    // 分岐を未定に戻すと、答え待ちの行になる
    const rel = st().model.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === "uc_cancel_reservation")!;
    act(() => void st().dispatch((m) => setRelationAlternate(m, { id: rel.id, alternate: null })));
    render(<SoutherBoard />);
    expect(screen.getByTestId("souther-owed").textContent).toBe("1");
    expect(screen.getByTestId("souther-open").textContent).toContain("操作「予約を取り消す」で、条件「取消料が発生する」のときにどうなるかが決まっていません");
    expect(screen.getByTestId("souther-source").querySelectorAll(".souther-line.is-owed")).toHaveLength(1);
  });

  it("「書き出す…」で、すべてのシステムの分を .sou のファイルで書き出す", async () => {
    render(<SoutherBoard />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "書き出す…" }));
    });
    const saved = memory().savedFolders;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.files.map((f) => f.name)).toEqual(["sys_pms.sou", "sys_booking_site.sou"]);
    expect(saved[0]!.options).toMatchObject({ zipFolder: "souther" });
    expect(saved[0]!.files[0]!.text).toContain("module untie.sys_pms");
    expect(st().toasts.some((t) => t.message.includes("業務ルールを") && t.message.includes("2 ファイル"))).toBe(true);
  });
});
