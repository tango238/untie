import { describe, expect, it } from "vitest";
import { addElement, addRelation, moveToContext } from "../commands";
import { contextNotices, suggestContext } from "../contexts";
import { okModel, sample } from "./helpers";

describe("コンテキストの候補と見直し", () => {
  it("サンプルは見直しの候補が無い", () => {
    expect(contextNotices(sample())).toEqual([]);
  });

  it("候補はつながりから決める (直接の所属要素を重く、操作を介した情報を軽く)", () => {
    const m = sample();
    expect(suggestContext(m, "cond_cancel_fee")).toBe("ctx_reservation");
    expect(suggestContext(m, "cond_full")).toBe("ctx_room");
    expect(suggestContext(m, "var_payment_method")).toBe("ctx_charge");
    expect(suggestContext(m, "st_room_cleaning")).toBe("ctx_room");
  });

  it("未分類は候補付きで知らせ、状態グループは 1 件にまとめる", () => {
    let m = okModel(moveToContext(sample(), { elementId: "st_res_confirmed", contextId: null }));
    m = okModel(addElement(m, { kind: "variation", name: "新しい区分", id: "var_x" }));
    const ns = contextNotices(m);
    expect(ns.map((n) => [n.elementId, n.type, n.suggestedId])).toEqual([
      ["st_res_tentative", "unassigned", "ctx_reservation"],
      ["var_x", "unassigned", null],
    ]);
    expect(ns[0]!.message).toMatch(/状態グループ「予約の状態」はコンテキストに属していません。.*「予約」が候補/);
  });

  it("属するコンテキストの要素とつながらず、別のコンテキストとだけつながる条件は見直し候補", () => {
    let m = okModel(moveToContext(sample(), { elementId: "cond_full", contextId: "ctx_charge" }));
    const ns = contextNotices(m);
    expect(ns.map((n) => [n.elementId, n.type, n.suggestedId])).toEqual([["cond_full", "mismatch", "ctx_room"]]);
    // 料金の要素ともつながれば候補から外れる
    m = okModel(addElement(m, { kind: "variation", name: "料金区分", id: "var_fee", init: { contextId: "ctx_charge" } }));
    m = okModel(addRelation(m, { sourceId: "cond_full", targetId: "var_fee" }));
    expect(contextNotices(m)).toEqual([]);
  });

  it("情報は関連先が別のコンテキストでも見直し候補にしない (コンテキストの結合そのもの)", () => {
    const m = okModel(moveToContext(sample(), { elementId: "info_guest", contextId: "ctx_charge" }));
    expect(contextNotices(m)).toEqual([]);
  });
});
