import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { ELEMENT_DRAG_TYPE, canvasApi } from "../canvas/canvasApi";
import { ElementList } from "../ElementList";
import { placeElement } from "../actions";
import { removeFromBoard } from "../../model/commands";

beforeEach(() => resetStore());

describe("ElementList", () => {
  it("種類ごとのグループと件数を出し、既定 BUC は出さない", () => {
    render(<ElementList />);
    const bucGroup = screen.getByRole("button", { name: /^.*BUC/ });
    expect(bucGroup.textContent).toContain("2"); // 客室対応・飲食提供だけ
    expect(screen.queryByText("予約受付", { selector: ".row-name" })).not.toBeNull(); // 業務
    // 業務名と同名の既定 BUC 行は出ない (業務の 1 行だけ)
    expect(screen.getAllByText("予約受付", { selector: ".row-name" })).toHaveLength(1);
  });

  it("グループ見出しで折りたためる", () => {
    render(<ElementList />);
    expect(screen.queryByText("予約担当")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^.*アクター\s*4$/ }));
    expect(screen.queryByText("予約担当")).toBeNull();
  });

  it("課題バッジと、現在のボードにある印を出す", () => {
    render(<ElementList />);
    const row = screen.getByTestId("row-act_accept_reservation");
    expect(within(row).getByLabelText(/課題 1 件、最高の重要度 5/)).toBeDefined();
    expect(within(row).getByLabelText("ボードにあります")).toBeDefined();
    // 全体ボードに無い要素 (ユースケース) には印がなく「置く」ボタンがある
    const uc = screen.getByTestId("row-uc_register_reservation");
    expect(within(uc).queryByLabelText("ボードにあります")).toBeNull();
    expect(within(uc).getByRole("button", { name: /ボードに置く/ })).toBeDefined();
  });

  it("行クリックで選択し、ボードにあればキャンバスへスクロールを依頼する", () => {
    const focused: string[] = [];
    canvasApi.focus = (id) => focused.push(id);
    render(<ElementList />);
    fireEvent.click(within(screen.getByTestId("row-actor_front")).getByText("フロント担当"));
    expect(useUntieStore.getState().ui.selection).toEqual({ type: "element", id: "actor_front" });
    expect(focused).toEqual(["actor_front"]);
    // ボードに無い要素は選択だけ
    fireEvent.click(within(screen.getByTestId("row-uc_register_reservation")).getByText("予約を登録する"));
    expect(useUntieStore.getState().ui.selection).toEqual({ type: "element", id: "uc_register_reservation" });
    expect(focused).toEqual(["actor_front"]);
    canvasApi.focus = undefined;
  });

  it("「置く」ボタンで現在のボードに置く。置いたあとはボタンが消える", () => {
    render(<ElementList />);
    const row = screen.getByTestId("row-uc_register_reservation");
    fireEvent.click(within(row).getByRole("button", { name: /ボードに置く/ }));
    const board = useUntieStore.getState().model.boards[0]!;
    expect(board.nodes.some((n) => n.elementId === "uc_register_reservation")).toBe(true);
    expect(within(screen.getByTestId("row-uc_register_reservation")).queryByRole("button", { name: /ボードに置く/ })).toBeNull();
  });

  it("行はドラッグで elementId を渡せる。課題はドラッグできない", () => {
    render(<ElementList />);
    const row = screen.getByTestId("row-actor_front");
    expect(row.getAttribute("draggable")).toBe("true");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: "" } });
    expect(data[ELEMENT_DRAG_TYPE]).toBe("actor_front");
    expect(screen.getByTestId("row-issue_manual_entry").getAttribute("draggable")).toBe("false");
  });

  it("枠の上に置くと、配置と所属変更が 1 件の履歴になる。枠の外では所属を変えない", () => {
    const st = () => useUntieStore.getState();
    st().dispatch((m) => removeFromBoard(m, { boardId: "board_overview", elementId: "act_verify_identity" }));
    const dining = st().model.boards[0]!.nodes.find((n) => n.elementId === "buc_dining")!;
    const before = st().history.past.length;
    const r = placeElement("act_verify_identity", { x: dining.x + 20, y: dining.y + 60 });
    expect(r.ok).toBe(true);
    expect(st().history.past.length).toBe(before + 1);
    expect(st().model.elements.find((e) => e.id === "act_verify_identity")).toMatchObject({ bucId: "buc_dining" });
    st().undo();
    expect(st().model.elements.find((e) => e.id === "act_verify_identity")).toMatchObject({ bucId: "buc_default_checkin" });

    placeElement("act_verify_identity", { x: -900, y: 1500 });
    expect(st().model.elements.find((e) => e.id === "act_verify_identity")).toMatchObject({ bucId: "buc_default_checkin" });
  });
});
