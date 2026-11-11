import { describe, expect, it } from "vitest";
import { createNetshopSample } from "../../sample";
import { screenConditions, usecaseIsReadOnly } from "../placement";
import { emptyModel, type Element, type Relation } from "../types";

describe("screenConditions", () => {
  it("画面を使う操作が判断する条件を、根拠の操作つきで関係の並び順に、重複なしで返す", () => {
    const m = emptyModel();
    m.elements = [
      { id: "sys", kind: "system", name: "S" },
      { id: "uc_1", kind: "usecase", name: "登録する" },
      { id: "uc_2", kind: "usecase", name: "確認する" },
      { id: "uc_3", kind: "usecase", name: "画面なし" },
      { id: "scr_1", kind: "screen", name: "画面", systemId: "sys" },
      { id: "scr_2", kind: "screen", name: "別の画面", systemId: "sys" },
      { id: "cond_1", kind: "condition", name: "会員か" },
      { id: "cond_2", kind: "condition", name: "在庫があるか" },
    ] as Element[];
    const pairs: [string, string, Relation["kind"]][] = [
      ["uc_1", "scr_1", "usecaseScreen"],
      ["uc_2", "scr_1", "usecaseScreen"],
      ["uc_1", "cond_2", "usecaseCondition"],
      ["uc_1", "cond_1", "usecaseCondition"],
      ["uc_2", "cond_1", "usecaseCondition"],
      ["uc_3", "cond_1", "usecaseCondition"],
    ];
    m.relations = pairs.map(([sourceId, targetId, kind], i) => ({ id: `rel_${i}`, kind, sourceId, targetId }));
    const result = screenConditions(m);
    expect(result.get("scr_1")).toEqual([
      { id: "cond_2", usecaseIds: ["uc_1"] },
      { id: "cond_1", usecaseIds: ["uc_1", "uc_2"] },
    ]);
    expect(result.has("scr_2")).toBe(false);
  });
});

describe("usecaseIsReadOnly", () => {
  it("扱う情報がすべて取得だけで、状態を変えず、出来事も起こさない操作だけが、読むだけ", () => {
    const shop = createNetshopSample();
    // 注文を検索する: 読むだけ
    expect(usecaseIsReadOnly(shop, "uc_search_order")).toBe(true);
    // 注文を確定する: 注文を書く
    expect(usecaseIsReadOnly(shop, "uc_confirm_order")).toBe(false);
    // ピッキングリストを出す: 情報は読むだけだが、出来事を起こす
    expect(usecaseIsReadOnly(shop, "uc_issue_pick_list")).toBe(false);
    // 状態を変える操作も、読むだけではない
    const m = emptyModel();
    m.elements = [
      { id: "uc", kind: "usecase", name: "締める" },
      { id: "info", kind: "information", name: "売上", contextId: "ctx" },
      { id: "st", kind: "state", name: "締め済", contextId: "ctx" },
    ] as Element[];
    m.relations = [{ id: "r1", kind: "usecaseInformation", sourceId: "uc", targetId: "info", access: "read" }];
    expect(usecaseIsReadOnly(m, "uc")).toBe(true);
    m.relations = [...m.relations, { id: "r2", kind: "usecaseState", sourceId: "uc", targetId: "st" }];
    expect(usecaseIsReadOnly(m, "uc")).toBe(false);
    // 扱う情報が無い操作は、読むだけとは言えない
    expect(usecaseIsReadOnly(m, "none")).toBe(false);
  });
});
