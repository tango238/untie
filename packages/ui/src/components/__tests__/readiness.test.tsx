import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRelationAlternate } from "@untie/core/model/commands";
import { createHotelSample, createRetailSample } from "@untie/core/sample";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { DesignCheckPanel } from "../design/DesignCheckPanel";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();
const row = (id: string) => screen.getByTestId("readiness").querySelector(`[data-condition="${id}"]`) as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
  resetStore(createHotelSample());
  act(() => st().enterDesign("sys_pms"));
});

describe("検証パネルの「実装を始める準備」", () => {
  it("条件ごとに、そろったか・残りが何件かを出す。内部のモデルの言葉は出さない", () => {
    render(<DesignCheckPanel />);
    const section = screen.getByRole("region", { name: "実装を始める準備" });
    expect(section.textContent).toContain("まだ実装を始められません");
    expect(within(section).getByRole("progressbar", { name: "そろった条件" }).getAttribute("aria-valuemax")).toBe("10");
    expect(row("analysis").className).toContain("is-done");
    expect(row("flow").className).toContain("is-done");
    // 料金プランを登録する操作が無い
    expect(row("origins").className).not.toContain("is-done");
    expect(row("origins").textContent).toContain("残り 1 件");
    expect(row("origins").textContent).toContain("情報「料金プラン」を保存する操作がありません");
    expect(section.textContent).not.toMatch(/集約|コンテキスト|ドメイン/);
  });

  it("行を押すと、決めるところへ移る: 分析の要素・シーケンス図・設計ボード", () => {
    render(<DesignCheckPanel />);
    fireEvent.click(within(row("origins")).getByRole("button", { name: /料金プラン/ }));
    expect(st().ui.currentBoardId).toBe("fixed:information");
    expect(st().ui.selection).toEqual({ type: "element", id: "info_plan" });
  });

  it("設計の検証の警告 (画面 UI が無い・遷移のきっかけが未定) も、残りに数える", () => {
    resetStore(createRetailSample());
    act(() => st().enterDesign("sys_pos"));
    render(<DesignCheckPanel />);
    expect(row("data").className).toContain("is-done");
    expect(row("screens").textContent).toContain("の画面 UI がまだありません");
    fireEvent.click(within(row("screens")).getAllByRole("button")[0]!);
    expect(st().ui.currentBoardId).toBe("design:screen");
    fireEvent.click(within(row("navigation")).getByRole("button", { name: /きっかけが未定/ }));
    expect(st().ui.currentBoardId).toBe("design:sitemap");
  });

  it("業務の流れの残りは、シーケンス図でその業務を開く", () => {
    const m = st().model;
    const rel = m.relations.find((r) => r.kind === "usecaseCondition" && r.alternate)!;
    act(() => void st().dispatch((model) => setRelationAlternate(model, { id: rel.id, alternate: null })));
    render(<DesignCheckPanel />);
    expect(row("flow").textContent).toContain("残り 1 件");
    fireEvent.click(within(row("flow")).getAllByRole("button")[0]!);
    expect(st().ui.currentBoardId).toBe("design:sequence");
    expect(localStorage.getItem("untie.design.sequenceBusiness")).not.toBeNull();
  });

  it("設計がまだ無いシステムでも出す", () => {
    expect(st().model.designs.some((d) => d.systemId === "sys_accounting")).toBe(false);
    act(() => useUntieStore.setState((s) => ({ ui: { ...s.ui, designSystemId: "sys_accounting" } })));
    render(<DesignCheckPanel />);
    expect(row("data").textContent).toContain("設計がまだありません");
  });
});
