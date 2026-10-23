import { describe, expect, it } from "vitest";
import { createHotelSample, hotelSample } from "..";
import { checkIntegrity, validateModel } from "../../model";

describe("宿泊施設サンプル", () => {
  it("スキーマ検証と参照整合性検査を通る", () => {
    const r = validateModel(JSON.parse(JSON.stringify(hotelSample)));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(checkIntegrity(hotelSample)).toEqual([]);
  });

  it("設計書 7 章の件数どおり", () => {
    const count = (kind: string) => hotelSample.elements.filter((e) => e.kind === kind).length;
    expect(count("business")).toBe(5);
    expect(count("actor")).toBe(4);
    expect(count("externalActor")).toBe(3);
    expect(count("buc")).toBe(5 + 2);
    expect(count("activity")).toBeGreaterThanOrEqual(15);
    expect(count("usecase")).toBeGreaterThanOrEqual(10);
    expect(count("information")).toBe(6);
    expect(count("state")).toBe(9);
    expect(count("variation")).toBe(3);
    expect(count("condition")).toBe(3);
    expect(count("issue")).toBe(5);
    expect(hotelSample.boards.map((b) => b.name)).toEqual(["全体", "予約からチェックアウトまで", "情報と状態"]);
  });

  it("全ての関係の種類が使われている", () => {
    const kinds = new Set(hotelSample.relations.map((r) => r.kind));
    expect(kinds.size).toBe(11);
  });

  it("「滞在中の対応」にだけ既定でない BUC がある", () => {
    const nonDefault = hotelSample.elements.filter((e) => e.kind === "buc" && !e.isDefault);
    expect(nonDefault.every((b) => b.kind === "buc" && b.businessId === "biz_stay")).toBe(true);
    expect(nonDefault).toHaveLength(2);
  });

  it("createHotelSample は独立したコピーを返す", () => {
    const a = createHotelSample();
    a.elements.pop();
    expect(createHotelSample().elements.length).toBe(hotelSample.elements.length);
  });
});
