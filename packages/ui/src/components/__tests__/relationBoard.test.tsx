import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDatabase, setDesignDatabases } from "@untie/core/model/commands";
import { buildRelationGraph } from "@untie/core/model/designRelation";
import { includeInformation } from "@untie/core/model/domainCommands";
import { createNetshopSample, createRetailSample } from "@untie/core/sample";
import { okModel } from "@untie/core/testing";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { RelationCanvas } from "../design/RelationCanvas";
import { RelationLeftPane } from "../design/RelationLeftPane";
import { RelationProperties } from "../design/RelationProperties";
import { buildRelationFlow, relationHighlight, relationTableHeight } from "../design/relationFlow";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();

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
  act(() => st().setCurrentBoard("design:relation"));
});

const node = (key: string) => document.querySelector(`[data-relation-node="${key}"]`) as HTMLElement;

describe("関連ボードの図の計算", () => {
  it("3 列に並べ、項目は使われているものを上に出して残りを畳む", () => {
    const g = buildRelationGraph(st().model, "sys_pos");
    const { nodes, edges } = buildRelationFlow(g, undefined);
    const info = nodes.find((n) => n.id === "information:info_item")!;
    const table = nodes.find((n) => n.id === "table:db_default:Item")!;
    const scr = nodes.find((n) => n.id === "screen:ds_pos_search")!;
    expect(info.position.x).toBeLessThan(table.position.x);
    expect(table.position.x).toBeLessThan(scr.position.x);
    expect(nodes.some((n) => n.type === "frame")).toBe(false);
    if (table.type !== "table") throw new Error();
    const columns = g.databases[0]!.tables.find((t) => t.name === "Item")!.columns;
    expect(table.data.rows.length + table.data.folded).toBe(columns.length);
    expect(table.data.rows.every((r) => r.usedBy > 0)).toBe(true);
    expect(table.height).toBe(relationTableHeight(table.data.rows.length, table.data.folded));
    // 画面への線は、列 (Handle の id) から出る
    expect(edges.find((e) => e.source === "table:db_default:Item" && e.target === "screen:ds_pos_search")!.sourceHandle).toBe("name");
    // 何も選んでいなければ薄くしない
    expect(nodes.every((n) => !("dim" in n.data) || n.data.dim === false)).toBe(true);
    expect(edges.every((e) => e.className === "")).toBe(true);
  });

  it("集約 (ドメインモデル) が決まっている情報は、集約ごとの枠にまとめる (ルートが先頭)。決まっていない情報はそのまま", () => {
    let m = createNetshopSample();
    const include = includeInformation(m, { aggregateId: "ag_stock", informationId: "info_product" });
    if (!include.ok) throw new Error(include.reason);
    m = include.model;
    const graph = buildRelationGraph(m, "sys_oms");
    expect(graph.informations.find((i) => i.id === "info_order")!.aggregate).toEqual({ id: "ag_order", name: "注文 (Order)", role: "root" });
    expect(graph.informations.find((i) => i.id === "info_product")!.aggregate).toMatchObject({ id: "ag_stock", role: "member" });
    expect(graph.informations.find((i) => i.id === "info_customer")!.aggregate).toBeUndefined();
    const { nodes } = buildRelationFlow(graph, undefined);
    const frame = nodes.find((n) => n.id === "aggregate:ag_stock")!;
    expect(frame).toMatchObject({ type: "frame", data: { name: "集約: 在庫 (Stock)" } });
    const inside = nodes.filter((n) => n.parentId === "aggregate:ag_stock");
    // ルート (在庫) が先頭で、中の情報 (商品) が続く。枠は子より前にある
    expect(inside.map((n) => n.id)).toEqual(["information:info_stock", "information:info_product"]);
    expect(inside[0]!.position.y).toBeLessThan(inside[1]!.position.y);
    expect(nodes.indexOf(frame)).toBeLessThan(nodes.indexOf(inside[0]!));
    expect(frame.height).toBeGreaterThan(inside[1]!.position.y + (inside[1]!.height ?? 0));
    // 集約にしていない情報 (購入者) は、枠に入らない
    expect(nodes.find((n) => n.id === "information:info_customer")!.parentId).toBeUndefined();
    // 枠どうし・枠と情報は重ならない (上から順に積む)
    const tops = nodes.filter((n) => n.parentId === undefined && (n.type === "information" || n.id.startsWith("aggregate:"))).map((n) => [n.position.y, n.position.y + (n.height ?? 0)] as const);
    for (let i = 1; i < tops.length; i++) expect(tops[i]![0]).toBeGreaterThanOrEqual(tops[i - 1]![1]);
  });

  it("データベースが 2 つ以上なら枠にまとめる", () => {
    let m = st().model;
    m = okModel(addDatabase(m, { id: "db_b", name: "分析用" }));
    m = okModel(setDesignDatabases(m, { systemId: "sys_pos", databaseIds: ["db_default", "db_b"] }));
    const { nodes } = buildRelationFlow(buildRelationGraph(m, "sys_pos"), undefined);
    const frames = nodes.filter((n) => n.type === "frame");
    expect(frames.map((f) => f.data.name)).toEqual(["既定のデータベース", "分析用"]);
    expect(nodes.find((n) => n.id === "table:db_default:Item")!.parentId).toBe("db:db_default");
    expect(nodes.indexOf(frames[0]!)).toBeLessThan(nodes.indexOf(nodes.find((n) => n.id === "table:db_default:Item")!));
  });

  it("選んだものの 1 ホップだけを残す", () => {
    const g = buildRelationGraph(st().model, "sys_pos");
    const byInfo = relationHighlight(g, { kind: "information", id: "info_item" })!;
    expect(byInfo.nodes.has("table:db_default:Item")).toBe(true);
    expect(byInfo.nodes.has("screen:ds_pos_search")).toBe(true);
    expect(byInfo.nodes.has("information:info_payment")).toBe(false);
    expect(byInfo.nodes.has("screen:ds_pos_sale")).toBe(false);
    const byScreen = relationHighlight(g, { kind: "screen", id: "ds_pos_sale" })!;
    expect(byScreen.nodes.has("table:db_default:Payment")).toBe(true);
    expect(byScreen.nodes.has("information:info_payment")).toBe(true);
    expect(byScreen.nodes.has("screen:ds_pos_search")).toBe(false);
    const byTable = relationHighlight(g, { kind: "table", databaseId: "db_default", table: "StockLevel" })!;
    expect(byTable.nodes.has("information:info_stock")).toBe(true);
    expect(byTable.nodes.has("screen:ds_pos_search")).toBe(true);
    expect(relationHighlight(g, undefined)).toBeNull();
  });
});

describe("RelationCanvas", () => {
  it("情報・テーブル・画面のノードを出し、問題の印を付ける", () => {
    act(() => {
      st().dispatch((m) => ({
        ok: true,
        model: { ...m, databases: m.databases.map((d) => ({ ...d, tables: d.tables.filter((t) => t.table !== "Stocktake") })) },
      } as never));
    });
    render(<RelationCanvas />);
    expect(node("information:info_item")).not.toBeNull();
    expect(node("table:db_default:Item")).not.toBeNull();
    expect(node("screen:ds_pos_search")).not.toBeNull();
    expect(within(node("information:info_stocktake")).getByText("未対応")).toBeDefined();
    expect(within(node("table:db_default:Item")).getByText(/^ほか \d+ 項目$/)).toBeDefined();
    expect(within(node("screen:ds_pos_top")).getByText("UI あり")).toBeDefined();
  });

  it("押すと選び、つながらないノードに is-dim が付く。空きを押すと戻る (キーボードでも選べる)", () => {
    render(<RelationCanvas />);
    fireEvent.click(node("information:info_item"));
    expect(st().ui.designRelation).toEqual({ kind: "information", id: "info_item" });
    expect(node("information:info_item").className).toContain("is-selected");
    expect(node("table:db_default:Item").className).not.toContain("is-dim");
    expect(node("table:db_default:Payment").className).toContain("is-dim");
    expect(node("screen:ds_pos_sale").className).toContain("is-dim");
    expect(node("screen:ds_pos_search").className).not.toContain("is-dim");
    fireEvent.keyDown(node("screen:ds_pos_sale"), { key: "Enter" });
    expect(st().ui.designRelation).toEqual({ kind: "screen", id: "ds_pos_sale" });
    expect(node("table:db_default:Item").className).toContain("is-dim");
    fireEvent.keyDown(node("table:db_default:Payment"), { key: " " });
    expect(st().ui.designRelation).toEqual({ kind: "table", databaseId: "db_default", table: "Payment" });
  });

  it("何も無いシステムでは空の案内を出す", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: [...s.model.elements, { id: "sys_empty", kind: "system", name: "空" } as never] } }));
      st().enterDesign("sys_empty");
    });
    render(<RelationCanvas />);
    expect(screen.getByText(/まだありません/)).toBeDefined();
  });

  it("L3: データベースの枠を押すと選択を外す", () => {
    act(() => {
      let m = st().model;
      m = okModel(addDatabase(m, { id: "db_b", name: "分析用" }));
      m = okModel(setDesignDatabases(m, { systemId: "sys_pos", databaseIds: ["db_default", "db_b"] }));
      useUntieStore.setState({ model: m });
      st().selectDesignRelation({ kind: "information", id: "info_item" });
    });
    render(<RelationCanvas />);
    const frame = document.querySelector("[data-relation-frame]") as HTMLElement;
    expect(within(frame).getByText("既定のデータベース")).toBeDefined();
    fireEvent.click(frame);
    expect(st().ui.designRelation).toBeUndefined();
  });

  it("設計が無いシステムでも落ちず、案内を出す", () => {
    act(() => st().enterDesign("sys_accounting"));
    render(<RelationCanvas />);
    expect(document.querySelectorAll("[data-relation-node^='information:']").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-relation-node^='table:']")).toBeNull();
    render(<RelationProperties />);
    expect(screen.getByText("図の情報・テーブル・画面を選ぶと、ここに内容が出ます")).toBeDefined();
  });
});

describe("RelationLeftPane", () => {
  it("一覧から選べ、aria-current が付く。問題の印も出す", () => {
    render(<RelationLeftPane />);
    fireEvent.click(screen.getByRole("button", { name: "Item" }));
    expect(st().ui.designRelation).toEqual({ kind: "table", databaseId: "db_default", table: "Item" });
    expect(screen.getByRole("button", { name: "Item" }).getAttribute("aria-current")).toBe("true");
    const row = document.querySelector('[data-screen-id="ds_pos_sale"] button') as HTMLElement;
    fireEvent.click(row);
    expect(st().ui.designRelation).toEqual({ kind: "screen", id: "ds_pos_sale" });
    expect(row.getAttribute("aria-current")).toBe("true");
  });
});

describe("RelationProperties", () => {
  it("何も選んでいないときは全体の数を出す", () => {
    render(<RelationProperties />);
    const o = screen.getByTestId("relation-overview");
    expect(within(o).getByText(/^情報 \d+$/)).toBeDefined();
    expect(within(o).getByText("未対応の情報 0")).toBeDefined();
  });

  it("情報: テーブルと、データボードで開くボタン", () => {
    act(() => st().selectDesignRelation({ kind: "information", id: "info_sale" }));
    render(<RelationProperties />);
    const p = screen.getByTestId("relation-information");
    expect(within(p).getByRole("button", { name: "Sale" })).toBeDefined();
    expect(within(p).getByRole("button", { name: "SaleLine" })).toBeDefined();
    fireEvent.click(within(p).getByRole("button", { name: "データボードで開く" }));
    expect(st().ui.currentBoardId).toBe("design:data");
    expect(st().ui.designTableName).toBe("Sale");
  });

  it("情報: テーブルに対応していなければ赤で知らせる", () => {
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, databases: m.databases.map((d) => ({ ...d, tables: [] })) } } as never));
    });
    act(() => st().selectDesignRelation({ kind: "information", id: "info_sale" }));
    render(<RelationProperties />);
    expect(screen.getByText("テーブルに対応していません")).toBeDefined();
  });

  it("テーブル: 項目ごとに使う画面を出す", () => {
    act(() => st().selectDesignRelation({ kind: "table", databaseId: "db_default", table: "Payment" }));
    render(<RelationProperties />);
    const p = screen.getByTestId("relation-table");
    expect(within(within(p).getByText("amount").closest("li")!).getByText("レジ打ち")).toBeDefined();
    expect(within(within(p).getByText("id").closest("li")!).getByText("—")).toBeDefined();
    fireEvent.click(within(p).getByRole("button", { name: "データボードで開く" }));
    expect(st().ui.currentBoardId).toBe("design:data");
    expect(st().ui.designTableName).toBe("Payment");
  });

  it("画面: 項目と列の対応を出し、画面ボード・サイトマップへ移れる", () => {
    act(() => st().selectDesignRelation({ kind: "screen", id: "ds_pos_sale" }));
    render(<RelationProperties />);
    const p = screen.getByTestId("relation-screen");
    expect(within(within(p).getByText("支払額").closest("li")!).getByText("Payment.amount")).toBeDefined();
    fireEvent.click(within(p).getByRole("button", { name: "画面ボードで開く" }));
    expect(st().ui.currentBoardId).toBe("design:screen");
    expect(st().ui.designScreenId).toBe("ds_pos_sale");
    act(() => st().setCurrentBoard("design:relation"));
    fireEvent.click(within(p).getByRole("button", { name: "サイトマップで見る" }));
    expect(st().ui.currentBoardId).toBe("design:sitemap");
    expect(st().ui.designScreenId).toBe("ds_pos_sale");
  });
});

describe("右のペインの詳細", () => {
  it("M1: 計算した値 (summary) は赤の未対応にせず、薄く出す", () => {
    act(() => st().selectDesignRelation({ kind: "screen", id: "ds_pos_top" }));
    render(<RelationProperties />);
    const p = screen.getByTestId("relation-screen");
    expect(within(p).queryByText("未対応")).toBeNull();
    expect(within(p).getAllByText("— (計算した値)").length).toBe(2);
  });

  it("M1: 入力の項目で対応が無いものは赤の未対応。存在しない列は「(無い列)」(L2)", () => {
    act(() => {
      useUntieStore.setState((s) => ({
        model: {
          ...s.model,
          designs: s.model.designs.map((d) => ({
            ...d,
            screens: d.screens.map((x) =>
              x.id === "ds_pos_sale" ? { ...x, bindings: [{ item: "method", databaseId: "db_default", table: "Payment", column: "gone" }] } : x,
            ),
          })),
        },
      }));
      st().selectDesignRelation({ kind: "screen", id: "ds_pos_sale" });
    });
    render(<RelationProperties />);
    const p = screen.getByTestId("relation-screen");
    expect(within(p).getAllByText("未対応").length).toBe(4);
    expect(within(p).getByText("Payment.gone (無い列)")).toBeDefined();
  });

  it("M2: DSL に無いテーブルにだけ対応づけた情報は、赤にせず「(DSL にありません)」と出す", () => {
    act(() => {
      useUntieStore.setState((s) => ({
        model: {
          ...s.model,
          databases: s.model.databases.map((d) => ({
            ...d,
            tables: [...d.tables.filter((t) => t.table !== "Stocktake"), { table: "Ghost", informationIds: ["info_stocktake"] }],
          })),
        },
      }));
      st().selectDesignRelation({ kind: "information", id: "info_stocktake" });
    });
    render(<RelationProperties />);
    expect(screen.queryByText("テーブルに対応していません")).toBeNull();
    expect(screen.getByText("Ghost (DSL にありません)")).toBeDefined();
  });
});

describe("選択の状態", () => {
  it("M3: 図の範囲から外れた情報・消えたテーブルの選択は消える", () => {
    act(() => st().selectDesignRelation({ kind: "information", id: "info_stocktake" }));
    act(() => {
      st().dispatch((m) => ({
        ok: true,
        model: { ...m, databases: m.databases.map((d) => ({ ...d, tables: d.tables.filter((t) => t.table !== "Stocktake") })), relations: m.relations.filter((r) => r.sourceId !== "info_stocktake" && r.targetId !== "info_stocktake") },
      } as never));
    });
    expect(buildRelationGraph(st().model, "sys_pos").informations.some((i) => i.id === "info_stocktake")).toBe(false);
    expect(st().ui.designRelation).toBeUndefined();
    act(() => st().selectDesignRelation({ kind: "table", databaseId: "db_default", table: "Item" }));
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, databases: m.databases.map((d) => ({ ...d, dsl: "" })) } } as never));
    });
    expect(st().ui.designRelation).toBeUndefined();
  });

  it("図に無い選択では何も薄くしない", () => {
    const g = buildRelationGraph(st().model, "sys_pos");
    expect(relationHighlight(g, { kind: "information", id: "nothing" })).toBeNull();
    const { nodes } = buildRelationFlow(g, { kind: "screen", id: "nothing" });
    expect(nodes.every((n) => !("dim" in n.data) || n.data.dim === false)).toBe(true);
  });

  it("指す先が無くなる・システムを替える・分析に戻すと消える", () => {
    act(() => st().selectDesignRelation({ kind: "screen", id: "ds_pos_sale" }));
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, designs: s.model.designs.map((d) => ({ ...d, screens: d.screens.filter((x) => x.id !== "ds_pos_sale"), transitions: [] })) } }));
      st().dispatch((m) => ({ ok: true, model: { ...m } } as never));
    });
    expect(st().ui.designRelation).toBeUndefined();
    act(() => st().selectDesignRelation({ kind: "information", id: "info_item" }));
    act(() => st().enterDesign("sys_accounting"));
    expect(st().ui.designRelation).toBeUndefined();
    act(() => st().enterDesign("sys_pos"));
    act(() => st().selectDesignRelation({ kind: "information", id: "info_item" }));
    act(() => st().setMode("analysis"));
    expect(st().ui.designRelation).toBeUndefined();
  });
});
