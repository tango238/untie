import { describe, expect, it } from "vitest";
import { CLOSE_CODES, CLOSE_LINK_DISABLED, CLOSE_REMOVED, CLOSE_ROLE_CHANGED, CLOSE_UNAUTHENTICATED, guestName } from "../protocol";

describe("ルームの取り決め", () => {
  it("閉じるコードは設計書 7.5 のとおり (4000 番台)", () => {
    expect([CLOSE_UNAUTHENTICATED, CLOSE_ROLE_CHANGED, CLOSE_REMOVED, CLOSE_LINK_DISABLED]).toEqual([4000, 4001, 4003, 4004]);
    expect(Object.values(CLOSE_CODES)).toEqual([4000, 4001, 4003, 4004]);
  });

  it("ゲストの名前は「ゲスト N」", () => {
    expect(guestName(1)).toBe("ゲスト 1");
    expect(guestName(12)).toBe("ゲスト 12");
  });
});
