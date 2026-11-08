import { describe, expect, it } from "vitest";
import { screenConditions } from "../placement";
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
