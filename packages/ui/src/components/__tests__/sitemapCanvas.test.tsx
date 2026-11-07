import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DesignScreen, SystemDesign } from "@untie/core/model/types";
import { createRetailSample } from "@untie/core/sample";
import { setDesignScreenView } from "@untie/core/model/commands";
import { okModel } from "@untie/core/testing";
import { entryNotes } from "@untie/core/model/sitemap";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { SitemapCanvas } from "../design/SitemapCanvas";
import { SITEMAP_NODE_HEIGHT, SITEMAP_NODE_WIDTH, buildSitemapFlow, sitemapLayers, sitemapPositions } from "../design/sitemapFlow";

const st = () => useUntieStore.getState();

// React Flow は jsdom に無い API を使う
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
  useUntieStore.setState({ cloud: null });
  resetStore(createRetailSample());
  act(() => st().enterDesign("sys_pos"));
});

const ds = (id: string): DesignScreen => ({ id, source: { kind: "screen", screenId: id } });
const design = (screens: string[], transitions: [string, string][]): Pick<SystemDesign, "screens" | "transitions"> => ({
  screens: screens.map(ds),
  transitions: transitions.map(([from, to], i) => ({ id: `t${i}`, from, to })),
});

describe("サイトマップの自動配置", () => {
  it("入ってくる遷移が無い画面から幅優先で層に分け、左から右へ並べる", () => {
    const d = design(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]);
    expect(Object.fromEntries(sitemapLayers(d))).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    const pos = sitemapPositions(d);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    // 同じ層は縦に並ぶ
    expect(pos.get("b")!.x).toBe(pos.get("c")!.x);
    expect(pos.get("c")!.y).toBeGreaterThanOrEqual(pos.get("b")!.y + SITEMAP_NODE_HEIGHT);
    expect(pos.get("d")!.x).toBe(2 * pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeGreaterThanOrEqual(SITEMAP_NODE_WIDTH);
  });

  it("遷移が 1 本も無い孤立した画面は最後の列。輪だけの画面も落ちない", () => {
    const d = design(["a", "b", "x", "p", "q"], [["a", "b"], ["p", "q"], ["q", "p"]]);
    const layers = sitemapLayers(d);
    expect(layers.get("x")).toBe(Math.max(layers.get("a")!, layers.get("b")!, layers.get("p")!, layers.get("q")!) + 1);
    expect(layers.get("p")).toBe(0);
    expect(layers.get("q")).toBe(1);
  });
});

describe("ノードとエッジ", () => {
  it("画面名・入口の印・注記・選択がノードに、via のラベルと未定の破線がエッジに入る", () => {
    const m = st().model;
    const d = m.designs[0]!;
    const sel = d.screens.find((s) => s.source.kind === "builtin" && s.source.builtin === "top")!;
    const { nodes, edges } = buildSitemapFlow(m, d, entryNotes(m, "sys_pos", d), sel.id, undefined);
    expect(nodes).toHaveLength(d.screens.length);
    const byName = new Map(nodes.map((n) => [n.data.name, n]));
    expect(byName.get("トップページ")!.data.selected).toBe(true);
    expect(byName.get("トップページ")!.data.entry).toBe(false);
    expect(byName.get("在庫の調整")!.data.entry).toBe(true);
    expect(byName.get("在庫の調整")!.data.note).toBe("作業「棚卸をする」から引き継ぎ");
    expect(byName.get("サインイン")!.data.builtin).toBe(true);
    expect(edges).toHaveLength(d.transitions.length);
    const labels = edges.map((e) => e.label);
    expect(labels).toContain("メニュー");
    expect(labels).toContain("送信のあと");
    expect(labels.some((l) => String(l).startsWith("ボタン"))).toBe(true);
    const undecided = edges.find((e) => e.label === "未定")!;
    expect(undecided.style?.strokeDasharray).toBe("5 4");
    expect(edges.find((e) => e.label === "メニュー")!.style?.strokeDasharray).toBeUndefined();
  });

  it("画面 UI (view) のある画面は hasView が true、無い画面は false", () => {
    const m0 = st().model;
    const noView = m0.designs[0]!.screens.filter((x) => x.view === undefined);
    const target = noView[0]!;
    const m = okModel(setDesignScreenView(m0, { systemId: "sys_pos", id: target.id, view: { title: "t", goal: "g", sections: [] } }));
    const d = m.designs[0]!;
    const { nodes } = buildSitemapFlow(m, d, entryNotes(m, "sys_pos", d), undefined, undefined);
    for (const n of nodes) expect(n.data.hasView).toBe(d.screens.find((x) => x.id === n.id)!.view !== undefined);
  });

  it("選んだ遷移のエッジは太くする", () => {
    const m = st().model;
    const d = m.designs[0]!;
    const { edges } = buildSitemapFlow(m, d, entryNotes(m, "sys_pos", d), undefined, d.transitions[0]!.id);
    expect(edges[0]!.style?.strokeWidth).toBe(3);
    expect(edges[1]!.style?.strokeWidth).toBe(1.5);
  });
});

describe("SitemapCanvas", () => {
  it("画面が 1 つも無いときは案内を出す", () => {
    resetStore(createRetailSample());
    act(() => st().enterDesign("sys_accounting"));
    render(<SitemapCanvas />);
    expect(screen.getByText("左の一覧で活動や作業を選ぶと、関連する画面が遷移と一緒に加わります")).toBeDefined();
  });

  it("画面をノードに描き (data-sitemap-node)、押すとその画面を選ぶ", () => {
    render(<SitemapCanvas />);
    const d = st().model.designs[0]!;
    const nodes = document.querySelectorAll("[data-sitemap-node]");
    expect(nodes).toHaveLength(d.screens.length);
    const top = d.screens.find((s) => s.source.kind === "builtin" && s.source.builtin === "top")!;
    fireEvent.click(document.querySelector(`[data-sitemap-node="${top.id}"]`)!);
    expect(st().ui.designScreenId).toBe(top.id);
    expect(document.querySelector(`[data-sitemap-node="${top.id}"]`)!.className).toContain("is-selected");
    expect(screen.getAllByText("入口").length).toBeGreaterThan(0);
  });

  it("ノードに「UI あり」/「UI なし」の印を出し、aria-label にも入れる", () => {
    const noView = st().model.designs[0]!.screens.filter((x) => x.view === undefined);
    const target = noView[0]!;
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_pos", id: target.id, view: { title: "t", goal: "g", sections: [] } }));
    });
    render(<SitemapCanvas />);
    const withUi = document.querySelector(`[data-sitemap-node="${target.id}"]`) as HTMLElement;
    expect(within(withUi).getByText("UI あり")).toBeDefined();
    expect(withUi.getAttribute("aria-label")).toMatch(/UI あり\)$/);
    const other = document.querySelector(`[data-sitemap-node="${noView[1]!.id}"]`) as HTMLElement;
    expect(within(other).getByText("UI なし")).toBeDefined();
    expect(other.getAttribute("aria-label")).toMatch(/UI なし\)$/);
    expect(other.getAttribute("aria-label")).toMatch(/^[^(]*\([^()]*\)$/);
  });

  it("ノードはキーボードで選べる (Tab で止まり、Enter / Space で選択)", () => {
    render(<SitemapCanvas />);
    const d = st().model.designs[0]!;
    const node = document.querySelector(`[data-sitemap-node="${d.screens[1]!.id}"]`) as HTMLElement;
    expect(node.tabIndex).toBe(0);
    fireEvent.keyDown(node, { key: "Enter" });
    expect(st().ui.designScreenId).toBe(d.screens[1]!.id);
    fireEvent.keyDown(document.querySelector(`[data-sitemap-node="${d.screens[2]!.id}"]`)!, { key: " " });
    expect(st().ui.designScreenId).toBe(d.screens[2]!.id);
  });

  it("画面が外れるとノードが減る", () => {
    render(<SitemapCanvas />);
    const before = document.querySelectorAll("[data-sitemap-node]").length;
    act(() => {
      useUntieStore.setState((s) => ({
        model: { ...s.model, designs: s.model.designs.map((d) => ({ ...d, screens: d.screens.slice(1), transitions: [] })) },
      }));
    });
    expect(document.querySelectorAll("[data-sitemap-node]").length).toBe(before - 1);
  });
});
