import { describe, expect, it } from "vitest";
import { moveNode } from "../../../model/commands";
import { okModel } from "../../../model/__tests__/helpers";
import { createHotelSample } from "../../../sample";
import type { UntieModel } from "../../../model/types";
import { decideDrop, frameAt, moveFrameWithDescendants, nodeRect, rectCenter } from "../drop";

const B = "board_overview";
const put = (m: UntieModel, id: string, x: number, y: number) =>
  okModel(moveNode(m, { boardId: B, elementId: id, position: { x, y } }));

describe("frameAt", () => {
  it("BUC の小枠を業務の枠より優先する", () => {
    const m = createHotelSample();
    const care = nodeRect(m, B, "buc_room_care")!;
    expect(frameAt(m, B, rectCenter(care))).toEqual({ id: "buc_room_care", kind: "buc" });
    expect(frameAt(m, B, rectCenter(care), { kinds: ["business"] })).toEqual({ id: "biz_stay", kind: "business" });
    expect(frameAt(m, B, { x: -500, y: -500 })).toBeNull();
  });
});

describe("decideDrop", () => {
  it("同じ枠の中で動かしただけなら何も変えない", () => {
    const m = createHotelSample();
    expect(decideDrop(m, B, "act_verify_identity")).toEqual({ type: "none" });
    expect(decideDrop(m, B, "act_room_request")).toEqual({ type: "none" });
    expect(decideDrop(m, B, "act_record_extra")).toEqual({ type: "none" });
  });

  it("別の業務の枠へ入れると、その業務の既定 BUC に移る", () => {
    const m0 = createHotelSample();
    const target = nodeRect(m0, B, "biz_reservation")!;
    const m = put(m0, "act_verify_identity", target.x + 30, target.y + 100);
    const d = decideDrop(m, B, "act_verify_identity");
    expect(d).toEqual({ type: "moveActivity", activityId: "act_verify_identity", bucId: "buc_default_reservation" });
  });

  it("BUC の小枠へ入れると、その BUC に移る", () => {
    const m0 = createHotelSample();
    const care = nodeRect(m0, B, "buc_dining")!;
    const m = put(m0, "act_verify_identity", care.x + 20, care.y + 60);
    expect(decideDrop(m, B, "act_verify_identity")).toEqual({
      type: "moveActivity",
      activityId: "act_verify_identity",
      bucId: "buc_dining",
    });
  });

  it("枠の外へ出すと未所属になる", () => {
    const m = put(createHotelSample(), "act_verify_identity", -600, 900);
    expect(decideDrop(m, B, "act_verify_identity")).toEqual({
      type: "moveActivity",
      activityId: "act_verify_identity",
      bucId: null,
    });
  });

  it("BUC の小枠を別の業務の枠へ入れると業務が変わる", () => {
    const m0 = createHotelSample();
    const target = nodeRect(m0, B, "biz_checkout")!;
    const m = put(m0, "buc_dining", target.x + 20, target.y + 60);
    expect(decideDrop(m, B, "buc_dining")).toEqual({ type: "moveBuc", bucId: "buc_dining", businessId: "biz_checkout" });
  });

  it("BUC の小枠が業務の枠の外に出たら、元の枠の中へ戻す", () => {
    const m = put(createHotelSample(), "buc_dining", 5000, 5000);
    const d = decideDrop(m, B, "buc_dining");
    expect(d.type).toBe("clamp");
    if (d.type === "clamp") {
      const own = nodeRect(m, B, "biz_stay")!;
      const r = nodeRect(m, B, "buc_dining")!;
      expect(d.position.x).toBeLessThanOrEqual(own.x + own.width - r.width);
      expect(d.position.y).toBeGreaterThanOrEqual(own.y);
    }
  });

  it("枠でない要素は何も変えない", () => {
    expect(decideDrop(createHotelSample(), B, "actor_front")).toEqual({ type: "none" });
  });
});

describe("moveFrameWithDescendants", () => {
  it("枠を動かすと子も同じ量だけ動く", () => {
    const m0 = createHotelSample();
    const before = nodeRect(m0, B, "act_room_request")!;
    const frame = nodeRect(m0, B, "biz_stay")!;
    const m = okModel(moveFrameWithDescendants(m0, B, "biz_stay", { x: frame.x + 10, y: frame.y - 20 }));
    const after = nodeRect(m, B, "act_room_request")!;
    expect(after.x).toBe(before.x + 10);
    expect(after.y).toBe(before.y - 20);
    expect(nodeRect(m, B, "biz_checkin")).toEqual(nodeRect(m0, B, "biz_checkin"));
    // サイズは保たれる
    expect(nodeRect(m, B, "biz_stay")!.width).toBe(frame.width);
  });
});
