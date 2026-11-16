import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { buildActivityFlow, previousCandidates } from "@untie/core/model/activityFlow";
import { addRelation, removeRelation } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { FlowBoard } from "../workflow/FlowBoard";
import { PropertyPanel } from "../PropertyPanel";

const st = () => useUntieStore.getState();

describe("業務フロー: 組み立て", () => {
  beforeEach(() => resetStore());

  it("業務ごとに、順序のある作業を左から右へ、担当の登場人物の行に並べる。順序の無い作業は右に並び、担当なしは最後の行", () => {
    const flow = buildActivityFlow(st().model);
    const box = flow.businesses.find((b) => b.rows.some((r) => r.cells.some((c) => c.activity.id === "act_hand_key")))!;
    const cell = (id: string) => box.rows.flatMap((r) => r.cells).find((c) => c.activity.id === id)!;
    // 前の作業 (部屋を割り当てる) より、鍵を渡すが右
    expect(cell("act_hand_key").column).toBeGreaterThan(cell("act_assign_room").column);
    expect(box.links.some((l) => l.sourceId === "act_assign_room" && l.targetId === "act_hand_key")).toBe(true);
    // 担当なしの行は、あれば最後
    const nullAt = box.rows.findIndex((r) => r.actor === null);
    expect(nullAt === -1 || nullAt === box.rows.length - 1).toBe(true);
  });

  it("輪になる順序があっても、列が決まる (戻る線は無視する)", () => {
    act(() => {
      const r = st().dispatch((m) => addRelation(m, { sourceId: "act_hand_key", targetId: "act_assign_room" }));
      expect(r.ok).toBe(true);
    });
    const flow = buildActivityFlow(st().model);
    const cols = flow.businesses.flatMap((b) => b.rows.flatMap((r) => r.cells)).map((c) => c.column);
    expect(cols.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
  });

  it("前の作業の候補は同じ業務の作業だけで、自分と既に前の作業のものは出ない", () => {
    const names = previousCandidates(st().model, "act_hand_key").map((a) => a.id);
    expect(names).not.toContain("act_hand_key");
    expect(names).not.toContain("act_assign_room");
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
    fireEvent.change(section.getByLabelText("きっかけのイベントを追加"), { target: { value: "ev_stay_requested" } });
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.sourceId === "ev_stay_requested" && r.targetId === "act_hand_key")).toBe(true);
    expect(screen.getByRole("button", { name: /^作業 鍵を渡す.*きっかけ: 宿泊の申込が届いた/ })).toBeDefined();
    fireEvent.click(within(screen.getByTestId("flow-order-section")).getByRole("button", { name: "きっかけのイベント「宿泊の申込が届いた」を外す" }));
    expect(st().model.relations.some((r) => r.kind === "eventActivity" && r.targetId === "act_hand_key")).toBe(false);
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
