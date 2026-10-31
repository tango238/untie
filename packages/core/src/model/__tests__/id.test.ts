import { describe, expect, it } from "vitest";
import { ID_PREFIXES, newId, newUniqueId } from "../id";
import { ELEMENT_KINDS } from "../types";

describe("id 生成", () => {
  it("種類ごとの接頭辞が付く", () => {
    expect(ID_PREFIXES).toMatchObject({
      actor: "actor",
      externalActor: "ext",
      business: "biz",
      buc: "buc",
      activity: "act",
      usecase: "uc",
      information: "info",
      state: "st",
      variation: "var",
      condition: "cond",
      issue: "issue",
      relation: "rel",
      board: "board",
    });
    for (const k of ELEMENT_KINDS) expect(newId(k).startsWith(`${ID_PREFIXES[k]}_`)).toBe(true);
  });

  it("接頭辞は互いに衝突しない", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("スキーマの id パターンに合う", () => {
    for (let i = 0; i < 50; i++) expect(newId("activity")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("連続して作っても重複しない", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("activity")));
    expect(ids.size).toBe(1000);
  });

  it("newUniqueId は使用済みの id を避ける", () => {
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newUniqueId("board", used);
      expect(used.has(id)).toBe(false);
      used.add(id);
    }
  });
});
