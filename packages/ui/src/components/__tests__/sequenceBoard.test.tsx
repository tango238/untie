import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRelationAlternate } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import App from "../../App";
import { DesignCheckPanel } from "../design/DesignCheckPanel";
import { SequenceBoard } from "../design/SequenceBoard";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();
const relation = (usecaseId: string, conditionId: string) => st().model.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === usecaseId && r.targetId === conditionId)!;

function type(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
  resetStore(createHotelSample());
  act(() => st().enterDesign("sys_pms"));
});

describe("設計モードのシーケンス図", () => {
  it("開発モードでなくても、設計ボードの選択肢とショートカット (Q) から開ける。右のペインは図の読み方", () => {
    render(<App />);
    const select = screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup[label="設計ボード"] option')].map((o) => o.textContent)).toEqual(["サイトマップ", "ナビゲーション", "画面", "データ", "関連", "シーケンス図"]);
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    fireEvent.keyDown(document, { key: "q" });
    expect(st().ui.currentBoardId).toBe("design:sequence");
    expect(screen.getByRole("region", { name: "設計ボード: シーケンス図" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "図の読み方" })).toBeDefined();
  });

  it("設計の対象のシステムを使う業務を選べ、図に担当・システム・操作・分岐が出る。選んだ業務は覚える", () => {
    const { unmount } = render(<SequenceBoard />);
    const pick = screen.getByLabelText("業務") as HTMLSelectElement;
    // 宿泊管理システムが登場しない業務 (清掃・準備) は出さない
    expect([...pick.options].map((o) => o.textContent)).toEqual(["予約受付", "チェックイン", "滞在中の対応", "チェックアウト", "自動の処理 (業務に属さないもの)"]);
    const diagram = screen.getByRole("img", { name: "予約受付 のシーケンス図" });
    expect(diagram.querySelector('[data-participant="sys_pms"]')!.getAttribute("class")).toContain("is-target");
    expect(diagram.textContent).toContain("予約を確定する [予約の確定画面]");
    expect(diagram.textContent).toContain("［満室である］のとき");
    fireEvent.change(pick, { target: { value: pick.options[3]!.value } });
    expect(screen.getByRole("img", { name: "チェックアウト のシーケンス図" })).toBeDefined();
    unmount();
    render(<SequenceBoard />);
    expect((screen.getByLabelText("業務") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("チェックアウト");
  });

  it("分岐の表で、条件のときにどうなるかを決める。未定の分岐は赤い枠になり、業務の名前に数が出る", () => {
    const r = relation("uc_cancel_reservation", "cond_cancel_fee");
    act(() => {
      st().dispatch((m) => setRelationAlternate(m, { id: r.id, alternate: null }));
    });
    render(<SequenceBoard />);
    expect((screen.getByLabelText("業務") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("予約受付 (未定 1)");
    const frame = screen.getByRole("img", { name: "予約受付 のシーケンス図" }).querySelector(`[data-alternate="${r.id}"]`)!;
    expect(frame.getAttribute("class")).toContain("is-undecided");
    expect(frame.textContent).toContain("未定");
    // 図の分岐を押すと、表のその行に印が付く
    fireEvent.click(frame);
    const row = screen.getByTestId(`alternate-${r.id}`);
    expect(row.className).toContain("is-focus");
    expect(row.className).toContain("is-undecided");
    // 「いつ」を選んでから「どうなるか」を書くと、一緒に保存する
    fireEvent.change(within(row).getByLabelText("予約を取り消す・取消料が発生する の、ふだんと違う流れになるとき"), { target: { value: "unmet" } });
    expect(relation("uc_cancel_reservation", "cond_cancel_fee").alternate).toBeUndefined();
    type(within(row).getByLabelText("予約を取り消す・取消料が発生する のとき、どうなるか"), "取消料なしで取り消す");
    expect(relation("uc_cancel_reservation", "cond_cancel_fee").alternate).toEqual({ when: "unmet", then: "取消料なしで取り消す" });
    expect(screen.getByTestId(`alternate-${r.id}`).className).not.toContain("is-undecided");
    expect((screen.getByLabelText("業務") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("予約受付");
    // 起きる出来事を選ぶ
    const event = st().model.elements.find((e) => e.kind === "event")!;
    fireEvent.change(within(screen.getByTestId(`alternate-${r.id}`)).getByLabelText("予約を取り消す・取消料が発生する のとき、起きる出来事"), { target: { value: event.id } });
    expect(relation("uc_cancel_reservation", "cond_cancel_fee").alternate).toMatchObject({ eventId: event.id });
    expect(screen.getByRole("img", { name: "予約受付 のシーケンス図" }).textContent).toContain(`(出来事: ${event.name})`);
    // 1 回の変更ごとに、元に戻せる
    act(() => st().undo());
    expect(relation("uc_cancel_reservation", "cond_cancel_fee").alternate).toEqual({ when: "unmet", then: "取消料なしで取り消す" });
  });

  it("検証パネルに、業務の流れで決まっていないことを出し、押すとシーケンス図でその業務を開く", () => {
    const { unmount } = render(<DesignCheckPanel />);
    expect(screen.queryByTestId("sequence-gaps")).toBeNull();
    unmount();
    const r = relation("uc_record_checkin", "cond_early_checkin");
    act(() => {
      st().dispatch((m) => setRelationAlternate(m, { id: r.id, alternate: null }));
    });
    render(
      <>
        <DesignCheckPanel />
        <SequenceBoard />
      </>,
    );
    const gaps = screen.getByTestId("sequence-gaps");
    fireEvent.click(within(gaps).getByRole("button", { name: /チェックイン: 操作「チェックインを記録する」で、条件「早めのチェックインができる」のときにどうなるかが決まっていません/ }));
    expect(st().ui.currentBoardId).toBe("design:sequence");
    expect(localStorage.getItem("untie.design.sequenceBusiness")).toBe(st().model.elements.find((e) => e.kind === "business" && e.name === "チェックイン")!.id);
  });

  it("閲覧専用では、分岐を変えられない。このシステムを使う業務が無ければ、その旨を出す", () => {
    act(() => st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never }));
    act(() => st().enterDesign("sys_pms"));
    const { unmount } = render(<SequenceBoard />);
    const table = screen.getByRole("table", { name: "分岐" });
    for (const select of within(table).getAllByRole("combobox")) expect((select as HTMLSelectElement).disabled).toBe(true);
    unmount();
    useUntieStore.setState({ cloud: null });
    resetStore(createHotelSample());
    // 清掃・準備の業務しか使わないシステムは無いので、どの業務にも出てこない会計システムの例として、決済サービスの対象を外す代わりに、存在しないシステムを見る
    act(() => useUntieStore.setState((s) => ({ ui: { ...s.ui, mode: "design", designSystemId: "sys_nope", currentBoardId: "design:sequence" } })));
    render(<SequenceBoard />);
    expect(screen.getByText(/を使う業務がまだありません/)).toBeDefined();
  });
});
