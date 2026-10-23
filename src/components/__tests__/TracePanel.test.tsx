import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, addRelation } from "../../model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { TracePanel } from "../TracePanel";

const st = () => useUntieStore.getState();

beforeEach(() => resetStore());

describe("TracePanel", () => {
  it("サンプルはすべて辿り着けると出す", () => {
    render(<TracePanel />);
    expect(screen.getByText(/が担い手 \(アクター／外部アクター／システム\) に辿り着けます/)).toBeDefined();
  });

  it("途切れ箇所だけを理由・直し方付きで出し、その先の要素は件数だけを出す。クリックで固定ボードへ移って選ぶ", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "activity", name: "孤立した作業", id: "act_x" }));
      st().dispatch((m) => addElement(m, { kind: "usecase", name: "孤立した操作", id: "uc_x" }));
      st().dispatch((m) => addRelation(m, { sourceId: "act_x", targetId: "uc_x" }));
    });
    render(<TracePanel />);
    expect(screen.getByText(/2 件が担い手 .*に辿り着けません。途切れている箇所は 1 件/)).toBeDefined();
    const row = screen.getByTestId("trace-act_x");
    expect(within(row).getByText(/^担当 \(アクター・外部アクター・システム\) がいません$/)).toBeDefined();
    expect(within(row).getByText(/担当のアクター・外部アクター・システムを結んでください/)).toBeDefined();
    // 別のレイヤーの要素はリンクにしない (そこでは直せないため)
    expect(within(row).queryByRole("button", { name: "孤立した操作" })).toBeNull();
    expect(within(row).getByText(/ほかに 1 件 \(操作 1\) も辿り着けません/)).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "孤立した作業" }));
    expect(st().ui.currentBoardId).toBe("fixed:activity");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_x" });
    expect(st().ui.rightPanel).toBe("properties");
  });
});
