import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { buildActivityFlow, previousCandidates } from "@untie/core/model/activityFlow";
import { addElement, addRelation, removeRelation } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { FlowBoard } from "../workflow/FlowBoard";
import { PropertyPanel } from "../PropertyPanel";

const st = () => useUntieStore.getState();

describe("業務フロー: 組み立て", () => {
  beforeEach(() => resetStore());

  it("業務ごとの帯に、順序のある作業を左から右へ並べる。帯は業務の順に左から続き、列は図全体で通し番号", () => {
    const flow = buildActivityFlow(st().model);
    const cells = flow.rows.flatMap((r) => r.cells);
    const cell = (id: string) => cells.find((c) => c.activity.id === id)!;
    expect(cell("act_hand_key").column).toBeGreaterThan(cell("act_assign_room").column);
    expect(flow.links.some((l) => l.kind === "order" && l.sourceId === "act_assign_room" && l.targetId === "act_hand_key")).toBe(true);
    // 帯は重ならず、図の列を使い切る
    let next = 0;
    for (const b of flow.bands) {
      expect(b.start).toBe(next);
      next += b.columns;
    }
    expect(flow.columns).toBe(next);
    // 担当なしの行は、あれば登場人物の行の最後
    const nullAt = flow.rows.findIndex((r) => r.actor === null);
    const lastInternal = flow.rows.map((r) => r.external).lastIndexOf(false);
    expect(nullAt === -1 || nullAt === lastInternal).toBe(true);
  });

  it("外部アクターの行は一番上で、起点にする作業と同じ列にイベントを出し、作業へ線を引く。起点の作業が無いイベントは数だけ数える", () => {
    act(() => {
      expect(st().dispatch((m) => addElement(m, { kind: "event", name: "宛先の無いイベント", id: "ev_lonely", init: { contextId: "ctx_reservation" } })).ok).toBe(true);
      expect(st().dispatch((m) => addRelation(m, { sourceId: "ext_guest", targetId: "ev_lonely" })).ok).toBe(true);
    });
    const flow = buildActivityFlow(st().model);
    expect(flow.rows[0]!.external).toBe(true);
    const guest = flow.rows.find((r) => r.actor?.id === "ext_guest")!;
    const accept = flow.rows.flatMap((r) => r.cells).find((c) => c.activity.id === "act_accept_reservation")!;
    expect(guest.events.map((e) => [e.event.id, e.column])).toEqual([["ev_stay_requested", accept.column]]);
    expect(flow.links.some((l) => l.kind === "event" && l.sourceId === "ext_guest:ev_stay_requested" && l.targetId === "act_accept_reservation")).toBe(true);
    expect(flow.hiddenEvents).toBe(1);
    // 行にカードとして出したイベントは、作業のカードの「きっかけ」には重ねない
    expect(accept.triggerEvents).toEqual([]);
  });

  it("作業が使う操作の対象 (システム・帳票・画面のシステム) を、システムの行に出し、作業から線を引く。同じ列の同じものは 1 枚", () => {
    const flow = buildActivityFlow(st().model);
    expect(flow.systems.length).toBeGreaterThan(0);
    const keys = new Set(flow.systems.map((s) => s.key));
    expect(keys.size).toBe(flow.systems.length);
    const reg = flow.systems.filter((s) => s.activityIds.includes("act_accept_reservation"));
    expect(reg.map((s) => s.element.name)).toContain("予約サイト");
    for (const l of flow.links.filter((x) => x.kind === "system")) expect(keys.has(l.targetId)).toBe(true);
  });

  it("輪になる順序があっても、列が決まる (戻る線は無視する)", () => {
    act(() => {
      const r = st().dispatch((m) => addRelation(m, { sourceId: "act_hand_key", targetId: "act_assign_room" }));
      expect(r.ok).toBe(true);
    });
    const cols = buildActivityFlow(st().model).rows.flatMap((r) => r.cells).map((c) => c.column);
    expect(cols.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
  });

  it("前の作業の候補は同じ業務の作業だけで、自分と既に前の作業のものは出ない", () => {
    const ids = previousCandidates(st().model, "act_hand_key").map((a) => a.id);
    expect(ids).not.toContain("act_hand_key");
    expect(ids).not.toContain("act_assign_room");
    expect(ids).not.toContain("act_accept_reservation"); // 別の業務
  });
});

describe("業務フローボード", () => {
  beforeEach(() => resetStore());

  it("業務の枠に作業のカードと担当の行を出す。作業を選ぶとプロパティに担当と前の作業が出て、線の操作 (ドラッグ) は無い", () => {
    act(() => st().setCurrentBoard("simple:flow"));
    render(<FlowBoard />);
    expect(screen.getByRole("heading", { name: "業務フロー" })).toBeDefined();
    const card = screen.getByRole("button", { name: /^作業 鍵を渡す/ });
    fireEvent.click(card);
    expect(st().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
    expect(document.querySelector("[data-flow-handle]")).toBeNull();
  });

  it("プロパティで担当を足すと、その人の行へ移る。担当を外すと「担当なし」の行になる", () => {
    act(() => st().setCurrentBoard("analysis:flow"));
    act(() => st().select({ type: "element", id: "act_hand_key" }));
    render(
      <>
        <FlowBoard />
        <PropertyPanel />
      </>,
    );
    const panel = screen.getByTestId("flow-order-section");
    for (const b of within(panel).queryAllByRole("button", { name: /^担当「.*」を外す$/ })) fireEvent.click(b);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す \(担当なし/ })).toBeDefined();
    const select = within(screen.getByTestId("flow-order-section")).getByLabelText("担当を追加") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: select.querySelector("option:not([value=''])")!.getAttribute("value")! } });
    expect(screen.queryByRole("button", { name: /^作業 鍵を渡す \(担当なし/ })).toBeNull();
  });

  it("プロパティで、きっかけのイベントを足す・外すと、カードに「きっかけ: ○○」が出る (人の作業のきっかけをイベントから直接結ぶ)", () => {
    act(() => st().setCurrentBoard("simple:flow"));
    act(() => st().select({ type: "element", id: "act_hand_key" }));
    render(
      <>
        <FlowBoard />
        <PropertyPanel />
      </>,
    );
    const section = within(screen.getByTestId("flow-order-section"));
    fireEvent.change(section.getByLabelText("きっかけのイベントを追加"), { target: { value: "ev_charge_calculated" } });
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.sourceId === "ev_charge_calculated" && r.targetId === "act_hand_key")).toBe(true);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す.*きっかけ: 請求金額が計算された/ })).toBeDefined();
    fireEvent.click(within(screen.getByTestId("flow-order-section")).getByRole("button", { name: "きっかけのイベント「請求金額が計算された」を外す" }));
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.targetId === "act_hand_key")).toBe(false);
  });

  it("業務フローから外部の登場人物・イベントを選んでも、業務一覧と同じ項目 (発生させるイベント・発生元の関係) を編集できる。作業は担当と順序だけ", () => {
    for (const board of ["simple:flow", "analysis:flow"]) {
      resetStore();
      act(() => st().setCurrentBoard(board));
      act(() => st().select({ type: "element", id: "ext_guest" }));
      const a = render(<PropertyPanel />);
      expect(screen.getByTestId("external-events-section")).toBeDefined();
      a.unmount();
      act(() => st().select({ type: "element", id: "ev_stay_requested" }));
      const b = render(<PropertyPanel />);
      expect(screen.getByLabelText("関係を追加")).toBeDefined();
      b.unmount();
      act(() => st().select({ type: "element", id: "act_hand_key" }));
      const c = render(<PropertyPanel />);
      expect(screen.getByTestId("flow-order-section")).toBeDefined();
      expect(screen.queryByLabelText("関係を追加")).toBeNull();
      c.unmount();
    }
  });

  it("順序を外した作業は「順序は未設定」で右に出る", () => {
    act(() => {
      const rel = st().model.relations.find((r) => r.kind === "activityTrigger" && r.targetId === "act_hand_key")!;
      st().dispatch((m) => removeRelation(m, { id: rel.id }));
      st().setCurrentBoard("simple:flow");
    });
    render(<FlowBoard />);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す.*順序は未設定/ })).toBeDefined();
  });
});
