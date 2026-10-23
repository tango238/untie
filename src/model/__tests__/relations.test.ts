import { describe, expect, it } from "vitest";
import { isUndirected, relationKindFor, relationLabel, RELATION_RULES, sameRelation } from "../relations";
import { ELEMENT_KINDS, RELATION_KINDS } from "../types";

describe("関係ルール", () => {
  const table: [string, string, string][] = [
    ["actor", "business", "actorBusiness"],
    ["actor", "activity", "actorActivity"],
    ["externalActor", "activity", "actorActivity"],
    ["activity", "usecase", "activityUsecase"],
    ["usecase", "information", "usecaseInformation"],
    ["usecase", "condition", "usecaseCondition"],
    ["information", "information", "informationRelated"],
    ["information", "variation", "informationVariation"],
    ["system", "information", "systemInformation"],
    ["information", "system", "informationSystem"],
    ["condition", "variation", "conditionVariation"],
    ["condition", "state", "conditionState"],
    ["state", "usecase", "stateUsecase"],
    ["usecase", "state", "usecaseState"],
  ];

  it.each(table)("%s → %s は %s", (s, t, kind) => {
    expect(relationKindFor(s as never, t as never)).toBe(kind);
  });

  it("表にない組み合わせは null", () => {
    const allowed = new Set(table.map(([s, t]) => `${s}>${t}`));
    for (const s of ELEMENT_KINDS) {
      for (const t of ELEMENT_KINDS) {
        if (!allowed.has(`${s}>${t}`)) expect(relationKindFor(s, t), `${s} → ${t}`).toBeNull();
      }
    }
  });

  it("外部アクターは業務に引けず、逆向きも引けない", () => {
    expect(relationKindFor("externalActor", "business")).toBeNull();
    expect(relationKindFor("business", "actor")).toBeNull();
    expect(relationKindFor("usecase", "activity")).toBeNull();
  });

  it("課題と BUC は関係を持たない", () => {
    for (const k of ELEMENT_KINDS) {
      expect(relationKindFor("issue", k)).toBeNull();
      expect(relationKindFor(k, "issue")).toBeNull();
      expect(relationKindFor("buc", k)).toBeNull();
      expect(relationKindFor(k, "buc")).toBeNull();
    }
  });

  it("全 kind にルールとラベルがある", () => {
    expect(RELATION_RULES.map((r) => r.kind).sort()).toEqual([...RELATION_KINDS].sort());
    for (const k of RELATION_KINDS) expect(relationLabel(k).length).toBeGreaterThan(0);
    expect(relationLabel("usecaseState")).toBe("次の状態");
    expect(relationLabel("systemInformation")).toBe("取得元");
    expect(relationLabel("informationSystem")).toBe("保存先");
  });

  it("無向なのは informationRelated だけ", () => {
    for (const k of RELATION_KINDS) expect(isUndirected(k)).toBe(k === "informationRelated");
  });

  it("sameRelation: 有向は向きを区別し、無向は無視する", () => {
    expect(sameRelation({ kind: "activityUsecase", sourceId: "a", targetId: "b" }, { kind: "activityUsecase", sourceId: "a", targetId: "b" })).toBe(true);
    expect(sameRelation({ kind: "stateUsecase", sourceId: "a", targetId: "b" }, { kind: "stateUsecase", sourceId: "b", targetId: "a" })).toBe(false);
    expect(sameRelation({ kind: "informationRelated", sourceId: "a", targetId: "b" }, { kind: "informationRelated", sourceId: "b", targetId: "a" })).toBe(true);
    expect(sameRelation({ kind: "stateUsecase", sourceId: "a", targetId: "b" }, { kind: "usecaseState", sourceId: "a", targetId: "b" })).toBe(false);
  });
});
