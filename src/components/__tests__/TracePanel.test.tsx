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
    expect(screen.getByText(/がアクター／外部アクターに辿り着けます/)).toBeDefined();
  });

  it("途切れ箇所ごとに理由と、その先で辿り着けない要素を出す。クリックで固定ボードへ移って選ぶ", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "activity", name: "孤立した作業", id: "act_x" }));
      st().dispatch((m) => addElement(m, { kind: "usecase", name: "孤立した操作", id: "uc_x" }));
      st().dispatch((m) => addRelation(m, { sourceId: "act_x", targetId: "uc_x" }));
    });
    render(<TracePanel />);
    expect(screen.getByText(/2 件がアクター／外部アクターに辿り着けません。途切れている箇所は 1 件/)).toBeDefined();
    const row = screen.getByTestId("trace-act_x");
    expect(within(row).getByText(/担当のアクターがおらず/)).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "孤立した操作" }));
    expect(st().ui.currentBoardId).toBe("fixed:usecase");
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_x" });
    expect(st().ui.rightPanel).toBe("properties");
  });
});
