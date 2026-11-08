import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, addRelation, moveToContext, setUsecaseTarget } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { TracePanel } from "../TracePanel";

/** 古いファイル・同時編集で画面が重なった状態を作る (コマンドは断るので関係を直接足す) */
const share = (m: ReturnType<typeof useUntieStore.getState>["model"], usecaseId: string, screenId: string) => ({
  ok: true as const,
  model: {
    ...m,
    relations: [
      ...m.relations.filter((r) => !(r.sourceId === usecaseId && (r.kind === "usecaseSystem" || r.kind === "usecaseScreen"))),
      { id: `rel_share_${usecaseId}`, kind: "usecaseScreen", sourceId: usecaseId, targetId: screenId } as (typeof m.relations)[number],
    ],
  },
});


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
    expect(within(row).getByText(/^担当 \(アクター・外部アクター\) がいません$/)).toBeDefined();
    expect(within(row).getByText(/担当のアクター・外部アクターを結んでください/)).toBeDefined();
    // 別のレイヤーの要素はリンクにしない (そこでは直せないため)
    expect(within(row).queryByRole("button", { name: "孤立した操作" })).toBeNull();
    expect(within(row).getByText(/ほかに 1 件 \(操作 1\) も辿り着けません/)).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "孤立した作業" }));
    expect(st().ui.currentBoardId).toBe("fixed:activity");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_x" });
    expect(st().ui.rightPanel).toBe("properties");
  });
});

describe("TracePanel の警告", () => {
  it("サンプル (宿泊施設) は警告を出さない (操作の連鎖がイベントで終わらなくても警告しない)", () => {
    render(<TracePanel />);
    expect(screen.queryByRole("region", { name: "警告" })).toBeNull();
  });

  it("1 つの業務に複数のアクターが付くと [警告] に出す。エラーではないので辿れるかの件数には数えず、クリックで固定ボードへ移る", () => {
    act(() => {
      st().dispatch((m) => addRelation(m, { sourceId: "actor_manager", targetId: "biz_reservation" }));
    });
    render(<TracePanel />);
    // 辿れるかは変わらない
    expect(screen.getByText(/が担い手 \(アクター／外部アクター／システム\) に辿り着けます/)).toBeDefined();
    const region = within(screen.getByRole("region", { name: "警告" })).getByTestId("warnings-businessActors");
    expect(within(region).getByText("警告: 1 つの業務に複数のアクターが付いています (1)")).toBeDefined();
    expect(within(region).getByText("業務をアクターごとに分解できるか検討してください。")).toBeDefined();
    const row = screen.getByTestId("warning-businessActors-biz_reservation");
    expect(within(row).getByText("主担当のアクターが 2 人います: 「予約担当」、「支配人」")).toBeDefined();
    expect(within(row).getByText(/業務に結ぶ主担当は 1 人にしてください/)).toBeDefined();
    // 業務と付いているアクターを、それぞれ直せる固定ボードへのリンクにする
    expect(within(row).getByRole("button", { name: "予約受付" })).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "支配人" }));
    expect(st().ui.currentBoardId).toBe("fixed:actor");
    expect(st().ui.selection).toEqual({ type: "element", id: "actor_manager" });
  });
});

describe("TracePanel の情報", () => {
  it("コンテキストの所属の見直し候補を [情報] に出し、候補へ移せる。辿れるかの件数には数えない", () => {
    act(() => {
      st().dispatch((m) => moveToContext(m, { elementId: "cond_full", contextId: "ctx_charge" }));
    });
    render(<TracePanel />);
    expect(screen.getByText(/が担い手 .*に辿り着けます/)).toBeDefined();
    const row = screen.getByTestId("notice-cond_full");
    expect(within(row).getByText(/「料金」の要素とつながっておらず、「客室」の要素とつながっています/)).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "「客室」に移す" }));
    expect(st().model.elements.find((e) => e.id === "cond_full")).toMatchObject({ contextId: "ctx_room" });
    expect(screen.queryByTestId("notice-cond_full")).toBeNull();
  });
});

describe("TracePanel のエラー: 1 つの画面を複数の操作が使う", () => {
  it("画面と操作をリンクにして出す。画面を押すとその画面を選ぶ", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "screen", name: "共用の画面", id: "scr_shared", init: { systemId: "sys_pms" } }));
      st().dispatch((m) => setUsecaseTarget(m, { usecaseId: "uc_record_checkin", targetId: "scr_shared" }));
      st().dispatch((m) => share(m, "uc_cancel_reservation", "scr_shared"));
    });
    render(<TracePanel />);
    const row = screen.getByTestId("error-screenSharedByUsecases-scr_shared");
    expect(within(row).getByText(/^画面「共用の画面」を複数の操作が使っています \(/)).toBeDefined();
    expect(within(row).getByText(/操作ごとに画面を分けてください/)).toBeDefined();
    expect(within(row).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(row).getByRole("button", { name: "共用の画面" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "scr_shared" });
  });

  it("全部辿れてエラーだけがあるときは、辿れる旨と見出し付きのエラーを出す。操作のリンクを押すとその操作を選ぶ", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "screen", name: "共用の画面", id: "scr_shared", init: { systemId: "sys_pms" } }));
      st().dispatch((m) => setUsecaseTarget(m, { usecaseId: "uc_record_checkin", targetId: "scr_shared" }));
      st().dispatch((m) => share(m, "uc_cancel_reservation", "scr_shared"));
    });
    render(<TracePanel />);
    expect(screen.getByText(/が担い手 \(アクター／外部アクター／システム\) に辿り着けます/)).toBeDefined();
    const region = screen.getByRole("region", { name: "エラー" });
    expect(within(region).getByText("エラー: 1 つの画面を複数の操作が使っている (1)")).toBeDefined();
    const row = screen.getByTestId("error-screenSharedByUsecases-scr_shared");
    const uc = st().model.elements.find((e) => e.id === "uc_cancel_reservation")!;
    fireEvent.click(within(row).getByRole("button", { name: uc.name }));
    expect(st().ui.selection).toEqual({ type: "element", id: "uc_cancel_reservation" });
  });
});
