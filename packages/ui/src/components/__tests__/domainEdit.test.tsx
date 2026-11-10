import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addContextRelation, removeContextRelation } from "@untie/core/model/domainCommands";
import { deriveContextMap } from "@untie/core/model/domainMap";
import { emptyDomain } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { createNetshopSample } from "@untie/core/sample";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { ContextMapBoard } from "../design/ContextMapBoard";
import { buildContextMapFlow } from "../design/contextMapFlow";
import { DesignCheckPanel } from "../design/DesignCheckPanel";
import { DomainBoard } from "../design/DomainBoard";
import { DomainLeftPane } from "../design/DomainLeftPane";
import { DomainProperties } from "../design/DomainProperties";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();
const domain = () => st().model.domain;
const last = <T,>(xs: readonly T[]): T => xs[xs.length - 1]!;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixStub {
  m22 = 1;
  constructor(_init?: string) {}
}

/** 入力して確定する (フォーカスを外すと保存する) */
function type(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function start(withDomain: boolean) {
  const sample = createNetshopSample();
  resetStore(withDomain ? sample : { ...sample, domain: emptyDomain() });
  act(() => st().enterDesign("sys_oms"));
  act(() => st().setCurrentBoard("design:domain"));
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixStub;
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
});

describe("ドメインボード: 保存したものと候補", () => {
  it("保存したコンテキスト・集約・コマンドと、まだ候補のものが並び、あるべき姿のものに印が付く", () => {
    start(true);
    render(
      <>
        <DomainLeftPane />
        <DomainProperties />
      </>,
    );
    const left = screen.getByRole("complementary", { name: "ドメインの一覧" });
    const row = (key: string) => left.querySelector(`[data-domain-row="${key}"]`) as HTMLElement;
    expect(within(row("context:bc_ordering")).queryByText("候補")).toBeNull();
    expect(within(row("context:ctx_customer")).getByText("候補")).toBeDefined();
    expect(within(row("aggregate:ag_order")).queryByText("候補")).toBeNull();
    expect(within(row("command:cm_ship")).getByRole("button", { name: "出荷する" })).toBeDefined();
    expect(within(row("command:cm_mark_paid")).getByText("あるべき姿")).toBeDefined();
    expect(within(row("command:uc_record_count")).getByText("候補")).toBeDefined();
    // 決済は、あるべき姿のポリシーのイベントの発生元として、上流に出る
    expect(within(left).getByRole("heading", { name: "上流のコンテキスト" })).toBeDefined();
    expect(row("context:bc_payment")).not.toBeNull();
    const overview = screen.getByTestId("domain-overview");
    expect(overview.textContent).toContain("コンテキスト 5 (保存 4・読むだけ 1)");
    expect(overview.textContent).toContain("集約 7 (保存 4)");
    expect(within(overview).getByRole("button", { name: "候補から作る (コンテキスト 1・集約 2)" })).toBeDefined();
  });

  it("保存した集約: 名前・英語名・不変条件を編集でき、分析の条件から不変条件を足せる", () => {
    start(true);
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "ag_stock" }));
    render(<DomainProperties />);
    const agg = screen.getByTestId("domain-aggregate");
    expect((within(agg).getByLabelText("英語名 (コードでの名前)") as HTMLInputElement).value).toBe("Stock");
    type(within(agg).getByLabelText("英語名 (コードでの名前)"), "StockItem");
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.english).toBe("StockItem");
    // 英語名に使えない文字は断り、理由をトーストに出す
    type(within(agg).getByLabelText("英語名 (コードでの名前)"), "在庫");
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.english).toBe("StockItem");
    expect(last(st().toasts)).toMatchObject({ tone: "error" });
    // 不変条件を足す・消す
    const add = within(agg).getByLabelText("不変条件を足す");
    fireEvent.change(add, { target: { value: "在庫の数は 0 より小さくならない" } });
    fireEvent.click(within(add.parentElement as HTMLElement).getByRole("button", { name: "足す" }));
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.invariants.map((i) => i.text)).toEqual(["引き当てる数は、引き当てていない在庫の数を超えない。", "在庫の数は 0 より小さくならない"]);
    fireEvent.click(within(agg).getByRole("button", { name: "不変条件 1 を消す" }));
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.invariants).toHaveLength(1);
    // 消した不変条件のもとの条件 (在庫が足りない) は、また候補に出る
    fireEvent.change(within(agg).getByLabelText("分析の条件から不変条件を足す"), { target: { value: "cond_out_of_stock" } });
    expect(last(domain().aggregates.find((a) => a.id === "ag_stock")!.invariants)).toMatchObject({ conditionId: "cond_out_of_stock" });
    expect(validateModel(st().model)).toMatchObject({ ok: true });
  });

  it("集約を消すときは確認し、消すと情報は候補に戻る", () => {
    start(true);
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "ag_shipment" }));
    render(<DomainProperties />);
    fireEvent.click(screen.getByRole("button", { name: "集約を消す" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("保存したコマンド 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    expect(domain().aggregates.some((a) => a.id === "ag_shipment")).toBe(false);
    expect(domain().commands.some((c) => c.id === "cm_ship")).toBe(false);
    // 選択は、もとの情報の候補へ移る
    expect(screen.getByTestId("domain-aggregate").textContent).toContain("集約 (候補)");
  });

  it("あるべき姿のコマンドとイベントを足し、ポリシーでつなぐ", () => {
    start(true);
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "ag_stock" }));
    render(<DomainProperties />);
    const add = screen.getByLabelText("あるべき姿のコマンドの名前");
    fireEvent.change(add, { target: { value: "引き当てを戻す" } });
    fireEvent.keyDown(add, { key: "Enter" });
    const command = domain().commands.find((c) => c.name === "引き当てを戻す")!;
    expect(command).toMatchObject({ aggregateId: "ag_stock", emits: [] });
    expect(st().ui.designDomain).toEqual({ kind: "command", id: command.id });
    expect(screen.getByTestId("domain-command").textContent).toContain("あるべき姿");
    // 注文が取り消された → 引き当てを戻す のポリシーを足す
    act(() => st().selectDesignDomain({ kind: "event", id: "de_order_cancelled" }));
    fireEvent.change(screen.getByLabelText("ポリシーを足す (実行するコマンド)"), { target: { value: command.id } });
    expect(domain().policies.find((p) => p.commandId === command.id)).toMatchObject({ eventId: "de_order_cancelled", auto: true });
    // 自動を外し、ポリシーを消す
    const ev = screen.getByTestId("domain-event");
    const policy = domain().policies.find((p) => p.commandId === command.id)!;
    const item = ev.querySelector(`[data-policy="${policy.id}"]`) as HTMLElement;
    fireEvent.click(within(item).getByRole("checkbox", { name: "自動" }));
    expect(domain().policies.find((p) => p.id === policy.id)!.auto).toBe(false);
    fireEvent.click(within(item).getByRole("button", { name: "引き当てを戻す へのポリシーを消す" }));
    expect(domain().policies.some((p) => p.id === policy.id)).toBe(false);
    expect(validateModel(st().model)).toMatchObject({ ok: true });
  });
});

describe("ドメインボード: 候補を採用する・外す", () => {
  it("候補のコマンドに英語名を付けると、集約とコンテキストも一緒に保存し、選択は保存したコマンドへ移る", () => {
    start(false);
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_confirm_order" }));
    render(<DomainProperties />);
    expect(screen.getByTestId("domain-command").textContent).toContain("コマンド (候補)");
    type(screen.getByLabelText("英語名 (コードでの名前)"), "ConfirmOrder");
    expect(domain().commands).toHaveLength(1);
    expect(domain().commands[0]).toMatchObject({ name: "注文を確定する", english: "ConfirmOrder", source: { usecaseId: "uc_confirm_order" } });
    expect(domain().aggregates.map((a) => a.name)).toEqual(["注文"]);
    expect(domain().contexts.map((c) => [c.name, c.systemIds])).toEqual([["注文", ["sys_oms"]]]);
    expect(st().ui.designDomain).toEqual({ kind: "command", id: domain().commands[0]!.id });
    expect(screen.getByTestId("domain-command").textContent).not.toContain("(候補)");
    // 保存をやめると、候補に戻って選んだまま
    fireEvent.click(screen.getByRole("button", { name: "保存をやめて候補に戻す" }));
    expect(domain().commands).toEqual([]);
    expect(st().ui.designDomain).toEqual({ kind: "command", id: "uc_confirm_order" });
    expect(screen.getByTestId("domain-command").textContent).toContain("コマンド (候補)");
  });

  it("候補を外すと一覧から消えて「外した候補」に出て、戻せる", () => {
    start(false);
    act(() => st().selectDesignDomain({ kind: "command", id: "uc_record_count" }));
    render(
      <>
        <DomainLeftPane />
        <DomainProperties />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "この候補を外す" }));
    expect(domain().excluded).toEqual(["usecase:uc_record_count"]);
    const left = screen.getByRole("complementary", { name: "ドメインの一覧" });
    expect(left.querySelector('[data-domain-row="command:uc_record_count"]')).toBeNull();
    const excluded = left.querySelector('[data-domain-excluded="usecase:uc_record_count"]') as HTMLElement;
    expect(excluded.textContent).toContain("コマンド: 棚卸の結果を記録する");
    fireEvent.click(within(excluded).getByRole("button", { name: "戻す" }));
    expect(domain().excluded).toEqual([]);
    expect(left.querySelector('[data-domain-row="command:uc_record_count"]')).not.toBeNull();
  });

  it("候補から作る (ツールバー): コンテキストと 1 情報 1 集約をまとめて保存し、結果を知らせる", () => {
    start(false);
    render(<DomainBoard />);
    expect(screen.getByText(/分析から導いた候補です \(破線。まだ保存していません\)/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "候補から作る" }));
    expect(domain().contexts.map((c) => c.name)).toEqual(["注文", "商品・在庫", "顧客", "出荷"]);
    expect(domain().aggregates.map((a) => a.name)).toEqual(["注文", "返品", "在庫", "購入者", "問い合わせ履歴", "出荷"]);
    expect(last(st().toasts).message).toBe("候補から、コンテキスト 4・集約 6 を作りました");
    // 作り終えると、ボタンは消える
    expect(screen.queryByRole("button", { name: "候補から作る" })).toBeNull();
    expect(validateModel(st().model)).toMatchObject({ ok: true });
  });

  it("候補の集約を、ほかの集約の中の情報にできる", () => {
    start(true);
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "info_product" }));
    render(<DomainProperties />);
    fireEvent.change(screen.getByLabelText("ほかの集約の中に入れる"), { target: { value: "ag_stock" } });
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.memberInformationIds).toEqual(["info_product"]);
    expect(st().ui.designDomain).toEqual({ kind: "aggregate", id: "ag_stock" });
    fireEvent.click(screen.getByRole("button", { name: "商品 を中の情報から外す" }));
    expect(domain().aggregates.find((a) => a.id === "ag_stock")!.memberInformationIds).toEqual([]);
  });

  it("用語の表で、英語名と定義を決めて保存する (空にすると消える)", () => {
    start(true);
    localStorage.setItem("untie.design.domainView", "terms");
    render(<DomainBoard />);
    const terms = screen.getByRole("table", { name: "用語" });
    expect((within(terms).getByLabelText("注文 の英語名") as HTMLInputElement).value).toBe("Order");
    type(within(terms).getByLabelText("返品 の英語名"), "ReturnRequest");
    expect(domain().terms.find((t) => t.elementId === "info_return")).toMatchObject({ term: "返品", english: "ReturnRequest", definition: "", boundedContextId: null });
    type(within(terms).getByLabelText("返品 の英語名"), "");
    expect(domain().terms.some((t) => t.elementId === "info_return")).toBe(false);
  });

  it("閲覧専用では、編集の部品を出さない", () => {
    start(true);
    act(() => st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never }));
    act(() => st().enterDesign("sys_oms"));
    act(() => st().setCurrentBoard("design:domain"));
    act(() => st().selectDesignDomain({ kind: "aggregate", id: "ag_order" }));
    render(
      <>
        <DomainLeftPane />
        <DomainBoard />
        <DomainProperties />
      </>,
    );
    expect(screen.queryByRole("button", { name: "＋コンテキスト" })).toBeNull();
    expect(screen.queryByRole("button", { name: "集約を消す" })).toBeNull();
    expect(screen.queryByLabelText("不変条件を足す")).toBeNull();
    expect((screen.getByLabelText("英語名 (コードでの名前)") as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("コンテキストマップ", () => {
  it("ショートカット (K) から開け、コンテキストと関係の表が出る。右のペインは関係の種類の説明", () => {
    start(true);
    render(<App />);
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    fireEvent.keyDown(document, { key: "k" });
    expect(st().ui.currentBoardId).toBe("design:contextmap");
    const board = screen.getByRole("region", { name: "設計ボード: コンテキストマップ" });
    const contexts = within(board).getByRole("table", { name: "境界づけられたコンテキスト" });
    expect(within(contexts).getByTestId("contextmap-context-bc_ordering").textContent).toContain("Ordering");
    expect(within(contexts).getByTestId("contextmap-context-bc_ordering").textContent).toContain("コア (Core)");
    expect(within(contexts).getByTestId("contextmap-context-bc_payment").textContent).toContain("なし (外部)");
    expect(screen.getByRole("heading", { name: "関係の種類" })).toBeDefined();
  });

  it("導いたつながりに関係の種類・統合の方式を決める。消すと未決に戻り、種類を選ぶと保存する", () => {
    start(true);
    render(<ContextMapBoard />);
    const row = () => screen.getByTestId("contextmap-flow-bc_ordering-bc_inventory");
    expect(row().textContent).toContain("イベント: 注文が確定した");
    expect((within(row()).getByLabelText("受注 → 在庫 の関係の種類") as HTMLSelectElement).value).toBe("customerSupplier");
    fireEvent.change(within(row()).getByLabelText("受注 → 在庫 の統合の方式"), { target: { value: "rest" } });
    expect(domain().relations.find((r) => r.id === "cr_ordering_inventory")!.integration).toBe("rest");
    fireEvent.click(within(row()).getByRole("button", { name: "受注 → 在庫 の関係を消す" }));
    expect(domain().relations.some((r) => r.id === "cr_ordering_inventory")).toBe(false);
    expect(row().className).toContain("is-undecided");
    fireEvent.change(within(row()).getByLabelText("受注 → 在庫 の関係の種類"), { target: { value: "partnership" } });
    expect(last(domain().relations)).toMatchObject({ upstreamId: "bc_ordering", downstreamId: "bc_inventory", kind: "partnership" });
    // 逆向きにだけ関係がある組は、そのことを添える
    expect(screen.getByTestId("contextmap-flow-bc_ordering-bc_payment").textContent).toContain("逆向きに「腐敗防止層 (Anticorruption Layer)」があります");
  });

  it("つながりの無い組にも関係を足せ、コンテキストの名前から、実装するシステムのドメインボードへ移れる", () => {
    start(true);
    render(<ContextMapBoard />);
    const add = screen.getByRole("group", { name: "関係を足す" });
    fireEvent.change(within(add).getByLabelText("上流のコンテキスト"), { target: { value: "bc_inventory" } });
    fireEvent.change(within(add).getByLabelText("下流のコンテキスト"), { target: { value: "bc_shipping" } });
    fireEvent.change(within(add).getByLabelText("足す関係の種類"), { target: { value: "separateWays" } });
    fireEvent.click(within(add).getByRole("button", { name: "足す" }));
    const added = last(domain().relations);
    expect(added).toMatchObject({ upstreamId: "bc_inventory", downstreamId: "bc_shipping", kind: "separateWays" });
    expect(screen.getByTestId(`contextmap-relation-${added.id}`).textContent).toContain("導いたつながりはありません");
    // 会計は別のシステムのコンテキストなので、そのシステムの設計へ切り替える
    fireEvent.click(screen.getByRole("button", { name: "会計" }));
    expect(st().ui).toMatchObject({ designSystemId: "sys_accounting", currentBoardId: "design:domain", designDomain: { kind: "context", id: "bc_accounting" } });
  });
});

describe("コンテキストマップの図", () => {
  it("上流を左・下流を右に並べ、決めた関係は実線 (略号 · 統合の方式)、未決のつながりは破線にする", () => {
    const m = createNetshopSample();
    const name = (id: string) => m.elements.find((e) => e.id === id)?.name ?? "";
    const count = (id: string) => m.domain.aggregates.filter((a) => a.boundedContextId === id).length;
    const { nodes, edges } = buildContextMapFlow(deriveContextMap(m), name, count);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    // 決済 → 受注 → 在庫・出荷 → 会計
    expect(x("bc_payment")).toBeLessThan(x("bc_ordering"));
    expect(x("bc_ordering")).toBeLessThan(x("bc_inventory"));
    expect(x("bc_shipping")).toBeLessThan(x("bc_accounting"));
    expect(nodes.find((n) => n.id === "bc_payment")!.data).toMatchObject({ subdomain: "汎用 (Generic)", systems: "決済サービス", aggregates: 0 });
    expect(edges.find((e) => e.id === "cr_payment_ordering")).toMatchObject({ source: "bc_payment", target: "bc_ordering", label: "ACL · Messaging" });
    expect(edges.every((e) => e.style === undefined)).toBe(true);
    // 関係を消すと、そのつながりは破線の「未決」になる。対等な関係は両向きの矢印
    let next = removeContextRelation(m, { id: "cr_ordering_inventory" });
    if (!next.ok) throw new Error(next.reason);
    const undecided = buildContextMapFlow(deriveContextMap(next.model), name, count).edges.find((e) => e.source === "bc_ordering" && e.target === "bc_inventory")!;
    expect(undecided).toMatchObject({ label: "未決", style: { strokeDasharray: "5 4" } });
    next = addContextRelation(next.model, { upstreamId: "bc_ordering", downstreamId: "bc_inventory", kind: "partnership" });
    if (!next.ok) throw new Error(next.reason);
    const peer = buildContextMapFlow(deriveContextMap(next.model), name, count).edges.find((e) => e.source === "bc_ordering" && e.target === "bc_inventory")!;
    expect(peer.label).toBe("P");
    expect(peer.markerStart).toBeDefined();
  });

  it("ボードに図と「書き出す」が出る", () => {
    start(true);
    render(<ContextMapBoard />);
    expect(screen.getByTestId("contextmap-diagram")).toBeDefined();
    expect(screen.getByRole("button", { name: "書き出す (distill-ddd)…" })).toBeDefined();
  });
});

describe("検証パネル: ドメインモデル", () => {
  it("保存した判断の抜けを警告し、行を押すと該当へ移る。保存した判断が無ければ節を出さない", () => {
    start(true);
    const { unmount } = render(<DesignCheckPanel />);
    // サンプルは決め切ってあるので、節は出ない
    expect(screen.queryByRole("heading", { name: "検証: ドメインモデル" })).toBeNull();
    act(() => st().dispatch((m) => removeContextRelation(m, { id: "cr_shipping_accounting" })));
    expect(screen.getByRole("heading", { name: "検証: ドメインモデル" })).toBeDefined();
    const group = screen.getByTestId("domain-warnings-flowWithoutRelation");
    fireEvent.click(within(group).getByRole("button", { name: /「出荷」→「会計」/ }));
    expect(st().ui.currentBoardId).toBe("design:contextmap");
    unmount();
    start(false);
    render(<DesignCheckPanel />);
    expect(screen.queryByRole("heading", { name: "検証: ドメインモデル" })).toBeNull();
  });
});
