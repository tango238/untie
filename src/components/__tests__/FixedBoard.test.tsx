import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { FixedBoard } from "../FixedBoard";

const st = () => useUntieStore.getState();
const groupEl = (title: string) => screen.getByRole("region", { name: title });

beforeEach(() => {
  resetStore();
  act(() => st().setCurrentBoard("fixed:activity"));
});

describe("FixedBoard", () => {
  it("上位の要素ごとの枠に下位の要素を並べ、担当アクターのラベルを出す", () => {
    render(<FixedBoard layer="activity" />);
    const checkin = within(groupEl("チェックイン"));
    expect(checkin.getByRole("button", { name: /鍵を渡す/ })).toBeDefined();
    expect(checkin.getByLabelText("担当: フロント担当、宿泊客")).toBeDefined();
  });

  it("活動・作業・操作のボードには 3 段を並べた書き方のヒントを出し、今の段を強調する。最初は閉じ、開閉を覚える", () => {
    const { unmount } = render(<FixedBoard layer="activity" />);
    const guide = screen.getByText(/書き方のヒント/).closest("details")!;
    expect(guide.open).toBe(false);
    guide.open = true;
    fireEvent(guide, new Event("toggle"));
    expect(st().ui.guideOpen).toBe(true);
    const current = [...guide.querySelectorAll("thead th.is-current")].map((e) => e.textContent);
    expect(current).toEqual(["作業"]);
    expect(within(guide).getByText(/1 人が一続きでやり終える/)).toBeDefined();
    guide.open = false;
    fireEvent(guide, new Event("toggle"));
    expect(st().ui.guideOpen).toBe(false);
    unmount();
    render(<FixedBoard layer="usecase" />);
    expect(screen.getByText(/書き方のヒント/).closest("details")!.open).toBe(false);
  });

  it("他のボードには書き方のヒントを出さない", () => {
    render(<FixedBoard layer="actor" />);
    expect(screen.queryByText(/書き方のヒント/)).toBeNull();
  });

  it("絞り込みで一致する要素だけを出す", () => {
    render(<FixedBoard layer="activity" />);
    fireEvent.change(screen.getByLabelText("絞り込み"), { target: { value: "鍵" } });
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["チェックイン", "チェックアウト"]);
    expect(st().ui.fixedFilters?.activity).toBe("鍵");
    fireEvent.change(screen.getByLabelText("絞り込み"), { target: { value: "該当なし" } });
    expect(screen.getByText(/一致する要素はありません/)).toBeDefined();
  });

  it("枠の「＋」で要素を作って所属させ、選択して名前欄へのフォーカスを依頼する", () => {
    render(<FixedBoard layer="activity" />);
    fireEvent.click(screen.getByRole("button", { name: "「飲食提供」に作業を追加" }));
    const sel = st().ui.selection!;
    expect(st().model.elements.find((e) => e.id === sel.id)).toMatchObject({ kind: "activity", bucId: "buc_dining" });
    expect(st().ui.nameFocusNonce).toBe(1);
    // 1 件の履歴で戻せる
    st().undo();
    expect(st().model.elements.some((e) => e.id === sel.id)).toBe(false);
  });

  it("関係で結ぶ枠では、既存の要素を足したり外したりできる", () => {
    act(() => st().setCurrentBoard("fixed:usecase"));
    render(<FixedBoard layer="usecase" />);
    const has = () =>
      st().model.relations.some((r) => r.sourceId === "act_hand_key" && r.targetId === "uc_record_checkin");
    fireEvent.change(screen.getByLabelText("「鍵を渡す」に既存の操作を足す"), { target: { value: "uc_record_checkin" } });
    expect(has()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "チェックインを記録するを「鍵を渡す」から外す" }));
    expect(has()).toBe(false);
    expect(st().model.elements.some((e) => e.id === "uc_record_checkin")).toBe(true);
  });

  it("操作のボードは活動ごとの段落に分け、段落の見出しで活動を選べる", () => {
    render(<FixedBoard layer="usecase" />);
    const section = screen.getByRole("region", { name: "飲食提供" });
    expect(section.className).toContain("fixed-section");
    expect(within(section).getByRole("region", { name: "ルームサービスを提供する" })).toBeDefined();
    fireEvent.click(within(section).getByRole("button", { name: "飲食提供" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "buc_dining" });
  });

  it("カードや枠の見出しをクリックすると、その要素を選ぶ", () => {
    render(<FixedBoard layer="activity" />);
    fireEvent.click(within(groupEl("飲食提供")).getByRole("button", { name: "飲食提供" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "buc_dining" });
    fireEvent.click(screen.getByRole("button", { name: /ルームサービスを提供する/ }));
    expect(st().ui.selection).toEqual({ type: "element", id: "act_room_service" });
  });
});
