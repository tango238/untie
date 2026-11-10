import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeElement, removeRelation } from "@untie/core/model/commands";
import { buildDomainScope } from "@untie/core/model/domainScope";
import { createNetshopSample } from "@untie/core/sample";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { DomainBoard } from "../design/DomainBoard";
import { DomainLeftPane } from "../design/DomainLeftPane";
import { DomainProperties } from "../design/DomainProperties";
import { buildAggregateFlow, buildBusinessFlow } from "../design/domainFlow";

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
  resetStore(createNetshopSample());
  act(() => st().enterDesign("sys_oms"));
  act(() => st().setCurrentBoard("design:domain"));
});

describe("ドメインボードの図の計算", () => {
  it("集約とイベント: きっかけ → コマンド → 集約 → イベント → 受け手 の 5 列に並べ、ポリシーは破線", () => {
    const scope = buildDomainScope(st().model, "sys_oms");
    const { nodes, edges } = buildAggregateFlow(scope, undefined);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x("event:ev_payment_confirmed")).toBeLessThan(x("command:uc_issue_pick_list"));
    expect(x("command:uc_confirm_order")).toBeLessThan(x("aggregate:info_order"));
    expect(x("aggregate:info_order")).toBeLessThan(x("event:ev_order_confirmed"));
    expect(x("event:ev_shipped")).toBeLessThan(x("consumer:uc_register_receivable"));
    expect(nodes.find((n) => n.id === "consumer:uc_register_receivable")!.data).toMatchObject({ kind: "consumer", sub: "対象: 会計システム", badges: ["外"] });
    // コマンド → 集約 → イベント、外のイベント → コマンドはポリシー (破線)
    expect(edges.some((e) => e.source === "command:uc_confirm_order" && e.target === "aggregate:info_order")).toBe(true);
    expect(edges.some((e) => e.source === "aggregate:info_order" && e.target === "event:ev_order_confirmed")).toBe(true);
    const policy = edges.find((e) => e.source === "event:ev_payment_confirmed" && e.target === "command:uc_issue_pick_list")!;
    expect(policy.label).toBeUndefined();
    expect(policy.style).toMatchObject({ strokeDasharray: "5 4" });
    // 読むだけのコマンドは「取得だけ」、作業で分かれる操作は作業の数
    expect(nodes.find((n) => n.id === "command:uc_issue_pick_list")!.data.badges).toContain("取得だけ");
    expect(nodes.find((n) => n.id === "command:uc_update_stock")!.data.badges).toContain("作業 3");
    // 何も選んでいなければ薄くしない
    expect(nodes.every((n) => !n.data.dim)).toBe(true);
  });

  it("選ぶと、そこから線を辿れるものだけを残して薄くする (ポリシーの線は辿らない)", () => {
    const scope = buildDomainScope(st().model, "sys_oms");
    const { nodes, edges } = buildAggregateFlow(scope, { kind: "aggregate", id: "info_order" });
    const dim = (id: string) => nodes.find((n) => n.id === id)!.data.dim;
    expect(nodes.find((n) => n.id === "aggregate:info_order")!.data.selected).toBe(true);
    expect(dim("command:uc_confirm_order")).toBe(false);
    expect(dim("event:ev_order_confirmed")).toBe(false);
    expect(dim("aggregate:info_stock")).toBe(true);
    // 注文が確定した → 在庫を引き当てる はポリシーなので辿らない
    expect(dim("command:uc_allocate_stock")).toBe(true);
    expect(edges.find((e) => e.source === "command:uc_allocate_stock")!.className).toBe("is-dim");
    // コンテキストを選ぶと、そのコンテキストの集約・コマンド・イベントを選んだことになる
    const ctx = buildAggregateFlow(scope, { kind: "context", id: "ctx_shipping" });
    expect(ctx.nodes.filter((n) => n.data.selected).map((n) => n.id).sort()).toEqual(
      ["aggregate:info_shipment", "command:uc_issue_label", "command:uc_record_shipment", "event:ev_label_issued", "event:ev_shipped"].sort(),
    );
  });

  it("業務の流れ: 次に・発生・きっかけでつなぎ、始まりから幅優先で左から右へ並べる。つながりの無いものは右端", () => {
    const scope = buildDomainScope(st().model, "sys_oms");
    const { nodes, edges } = buildBusinessFlow(st().model, scope, undefined);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(edges.find((e) => e.source === "command:uc_search_order" && e.target === "command:uc_confirm_order")!.label).toBe("次に");
    expect(x("command:uc_search_order")).toBeLessThan(x("command:uc_confirm_order"));
    expect(x("command:uc_confirm_order")).toBeLessThan(x("event:ev_order_confirmed"));
    expect(x("event:ev_order_confirmed")).toBeLessThan(x("command:uc_allocate_stock"));
    expect(nodes.find((n) => n.id === "command:uc_search_order")!.data).toMatchObject({ kind: "query", badges: ["問い合わせ"] });
  });
});

describe("ドメインボード", () => {
  it("設計ボードの選択肢とショートカット (M) から開け、左・中央・右のペインが出る", () => {
    act(() => st().setCurrentBoard("design:sitemap"));
    render(<App />);
    const select = screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup[label="設計ボード"] option')].map((o) => o.textContent)).toContain("ドメイン");
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    fireEvent.keyDown(document, { key: "m" });
    expect(st().ui.currentBoardId).toBe("design:domain");
    expect(screen.getByRole("region", { name: "設計ボード: ドメイン" })).toBeDefined();
    expect(screen.getByRole("complementary", { name: "ドメインの一覧" })).toBeDefined();
    expect(screen.getByTestId("domain-overview").textContent).toContain("コマンドの候補 13");
  });

  it("左の一覧で選ぶと右のペインに中身と根拠が出て、図でも強調する。選び直すと切り替わる", () => {
    render(
      <>
        <DomainLeftPane />
        <DomainProperties />
      </>,
    );
    const left = screen.getByRole("complementary", { name: "ドメインの一覧" });
    // 注文 (コンテキスト) と 注文 (集約) が並ぶので、集約の行を押す
    fireEvent.click(within(left.querySelector('[data-domain-row="aggregate:info_order"]') as HTMLElement).getByRole("button"));
    expect(st().ui.designDomain).toEqual({ kind: "aggregate", id: "info_order" });
    expect(st().ui.rightPanel).toBe("properties");
    const agg = screen.getByTestId("domain-aggregate");
    expect(agg.textContent).toContain("ルート候補 (状態を持つ)");
    expect(agg.textContent).toContain("注文の状態: 受付済 → 確定 → 入金済 → 出荷済 → 取消");
    expect(within(agg).getByRole("button", { name: "注文を確定する" })).toBeDefined();
    // 右のペインの要素名 (コマンド) を押すと、ボードの中でそのコマンドを選ぶ
    fireEvent.click(within(agg).getByRole("button", { name: "注文を確定する" }));
    expect(st().ui.designDomain).toEqual({ kind: "command", id: "uc_confirm_order" });
    expect(screen.getByTestId("domain-command").textContent).toContain("受付済 → 確定");
  });

  it("外のイベントと、読むだけで状態を変えるコマンドの中身 (気づきつき)", () => {
    act(() => st().enterDesign("sys_payment"));
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_record_payment" }));
    render(<DomainProperties />);
    const cmd = screen.getByTestId("domain-command");
    expect(within(cmd).getByText("取得だけ")).toBeDefined();
    expect(cmd.textContent).toContain("別のシステムの操作が状態を変えている");
    // 決済サービスでは、注文は書かない集約
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "info_order" }));
    expect(screen.getByTestId("domain-aggregate").textContent).toContain("このシステムでは書かない");
  });

  it("ボードの外の要素 (作業など) を押すと、分析のその要素の固定ボードへ移る", () => {
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_confirm_order" }));
    render(<DomainProperties />);
    fireEvent.click(within(screen.getByTestId("domain-command")).getByRole("button", { name: "注文内容を確認する" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:activity");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_check_order" });
  });

  it("見せ方を切り替えられ、端末ごとに覚える。表と用語も出せる", () => {
    const { unmount } = render(<DomainBoard />);
    expect((screen.getByRole("button", { name: "集約とイベント" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "表" }));
    expect(screen.getByRole("region", { name: "イベントストーミングの表" })).toBeDefined();
    expect(screen.getByTestId("storming-usecase:uc_update_stock/activity:act_restock")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "用語" }));
    const terms = screen.getByRole("table", { name: "用語" });
    expect(within(terms).getByTestId("term-st_ord_paid").textContent).toContain("同じ語が別の文脈に");
    unmount();
    render(<DomainBoard />);
    expect((screen.getByRole("button", { name: "用語" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
  });

  it("このシステムを対象にした操作もイベントも無ければ、その旨を出す", () => {
    act(() => st().enterDesign("sys_mall"));
    // モールの管理画面は問い合わせ (モールの注文を確認する) だけあるので、それも消す
    act(() => st().dispatch((m) => removeElement(m, { id: "uc_check_mall_order" })));
    render(<DomainBoard />);
    expect(screen.getByText(/このシステムを対象にした操作も、このシステムが発生させるイベントもまだありません/)).toBeDefined();
  });

  it("選んだものがしぼった範囲から無くなると選択が消え、モード・システムを変えても消える", () => {
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_confirm_order" }));
    act(() => st().dispatch((m) => removeElement(m, { id: "uc_confirm_order" })));
    expect(st().ui.designDomain).toBeUndefined();
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "info_order" }));
    act(() => st().enterDesign("sys_accounting"));
    expect(st().ui.designDomain).toBeUndefined();
    act(() => st().selectDesignDomain({ kind: "context", id: "ctx_accounting" }));
    act(() => st().setMode("analysis"));
    expect(st().ui.designDomain).toBeUndefined();
  });
});

describe("レビューを受けた振る舞い", () => {
  it("強調は出どころの操作で辿り、集約が束ねるほかの操作のイベントまでは広げない", () => {
    const scope = buildDomainScope(st().model, "sys_oms");
    const dim = (sel: Parameters<typeof buildAggregateFlow>[1], id: string) => buildAggregateFlow(scope, sel).nodes.find((n) => n.id === id)!.data.dim;
    const reg = { kind: "command", id: "uc_register_order" } as const;
    expect(dim(reg, "event:ev_order_received")).toBe(false);
    expect(dim(reg, "event:ev_order_confirmed")).toBe(true);
    expect(dim(reg, "event:ev_order_cancelled")).toBe(true);
    // イベントを選ぶと、それを出す操作だけが光る (同じ集約を書くほかの操作は光らない)
    const alloc = { kind: "event", id: "ev_stock_allocated" } as const;
    expect(dim(alloc, "command:uc_allocate_stock")).toBe(false);
    expect(dim(alloc, "command:uc_register_receiving")).toBe(true);
    // 外のきっかけを選ぶと、ポリシーを 1 歩辿って、きっかけにするコマンドとその先が光る
    const paid = { kind: "event", id: "ev_payment_confirmed" } as const;
    expect(dim(paid, "command:uc_issue_pick_list")).toBe(false);
    expect(dim(paid, "event:ev_pick_listed")).toBe(false);
  });

  it("このシステムが書く情報はすべて集約のノードにし、行はコンテキストごとの帯に分ける", () => {
    const scope = buildDomainScope(st().model, "sys_oms");
    const { nodes, edges } = buildAggregateFlow(scope, undefined);
    // 購入者は 注文を登録する が注文と一緒に書く (代表の集約ではない) が、ノードになり線も引く
    expect(nodes.some((n) => n.id === "aggregate:info_customer")).toBe(true);
    expect(edges.some((e) => e.source === "command:uc_register_order" && e.target === "aggregate:info_customer")).toBe(true);
    const bands = nodes.filter((n) => n.type === "band").map((n) => n.data.label);
    expect(bands).toEqual(["注文", "商品・在庫", "顧客", "出荷"]);
    // 集約の帯の中に、そのコンテキストのコマンド・集約・イベントが入る
    const band = nodes.find((n) => n.id === "band:ctx_shipping")!;
    const y = (id: string) => nodes.find((n) => n.id === id)!.position.y;
    for (const id of ["command:uc_issue_label", "aggregate:info_shipment", "event:ev_shipped"]) {
      expect(y(id)).toBeGreaterThan(band.position.y);
      expect(y(id)).toBeLessThan(band.position.y + (band.height ?? 0));
    }
    // 読むだけのコンテキスト (会計システムにとっての注文) は、図に書く集約が無いので帯にならない (左の一覧の「読むだけのコンテキスト (上流)」に出る)
    const acc = buildAggregateFlow(buildDomainScope(st().model, "sys_accounting"), undefined);
    expect(acc.nodes.filter((n) => n.type === "band").map((n) => n.data.label)).toEqual(["会計"]);
  });

  it("問い合わせだけのシステムでは、集約とイベントの図の代わりに案内を出し、業務の流れでは問い合わせを選べる", () => {
    act(() => st().enterDesign("sys_mall"));
    render(<DomainBoard />);
    expect(screen.getByText(/情報を書く操作 \(コマンド\) もイベントもありません。問い合わせ 1 件は/)).toBeDefined();
    const flow = buildBusinessFlow(st().model, buildDomainScope(st().model, "sys_mall"), undefined);
    expect(flow.nodes.find((n) => n.id === "command:uc_check_mall_order")!.data).toMatchObject({ kind: "query", selection: { kind: "query", id: "uc_check_mall_order" } });
  });

  it("問い合わせを選ぶと右のペインに中身が出て、範囲の外の要素名には「↗」と行き先が付く", () => {
    act(() => st().selectDesignDomain({ kind: "query", id: "uc_search_order" }));
    render(<DomainProperties />);
    const q = screen.getByTestId("domain-query");
    expect(q.textContent).toContain("受注一覧");
    // 作業は範囲の外なので、押すと分析へ移る印と行き先が付く。読む情報 (注文) は範囲の中なので付かない
    expect(within(q).getByRole("button", { name: "注文内容を確認する" }).getAttribute("title")).toContain("分析の作業ボードで見る");
    expect(within(q).getByRole("button", { name: "注文" }).getAttribute("title")).not.toContain("分析の");
    expect(within(q).getByRole("button", { name: "分析の操作ボードで見る ↗" })).toBeDefined();
  });

  it("イベントの中身: 分析へのリンクは操作ボード、ほかにも発生させるところを添える", () => {
    act(() => st().selectDesignDomain({ kind: "event", id: "ev_order_received" }));
    render(<DomainProperties />);
    const ev = screen.getByTestId("domain-event");
    expect(ev.textContent).toContain("ほかにも 自社サイトのカート が発生させる");
    expect(within(ev).getByRole("button", { name: /^分析の.+ボードで見る ↗$/ })).toBeDefined();
  });

  it("範囲から外れても要素があれば選択は残り (ボードは選んでいないものとして見せる)、要素が消えると選択も消える", () => {
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_confirm_order" }));
    act(() => st().enterDesign("sys_oms"));
    expect(st().ui.designDomain).toEqual({ kind: "command", id: "uc_confirm_order" });
    // 操作の対象を別のシステムへ移す代わりに、対象を外す (範囲の外になる)
    const rel = st().model.relations.find((r) => r.kind === "usecaseScreen" && r.sourceId === "uc_confirm_order")!;
    act(() => st().dispatch((m) => removeRelation(m, { id: rel.id })));
    expect(st().ui.designDomain).toEqual({ kind: "command", id: "uc_confirm_order" });
    render(<DomainProperties />);
    expect(screen.getByTestId("domain-overview")).toBeDefined();
  });

  it("分析ボードの要素名は、これまでどおり選んでプロパティ欄に出す (差し替えは設計のドメインボードだけ)", async () => {
    const { El } = await import("../analysis/analysisParts");
    const el = st().model.elements.find((e) => e.id === "uc_confirm_order")!;
    render(<El element={el} />);
    const button = screen.getByRole("button", { name: "注文を確定する" });
    expect(button.textContent).not.toContain("↗");
    fireEvent.click(button);
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_confirm_order" });
  });
});

describe("左の一覧", () => {
  it("自分のコンテキストと読むだけのコンテキスト (上流) を分け、イベントの行にも問いの数を出し、問い合わせも選べる", () => {
    act(() => st().enterDesign("sys_accounting"));
    render(<DomainLeftPane />);
    const left = screen.getByRole("complementary", { name: "ドメインの一覧" });
    expect(within(left).getByRole("heading", { name: "読むだけのコンテキスト (上流)" })).toBeDefined();
    expect(left.querySelector('[data-domain-row="context:ctx_order"]')).not.toBeNull();
    fireEvent.click(within(left.querySelector('[data-domain-row="query:uc_view_pl"]') as HTMLElement).getByRole("button"));
    expect(st().ui.designDomain).toEqual({ kind: "query", id: "uc_view_pl" });
  });
});
