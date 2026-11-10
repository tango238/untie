import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeElement } from "@untie/core/model/commands";
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
    expect(policy.label).toBe("ポリシー");
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
