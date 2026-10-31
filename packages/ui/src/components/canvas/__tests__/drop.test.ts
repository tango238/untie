import { describe, expect, it } from "vitest";
import { okModel } from "@untie/core/testing";
import { createHotelSample } from "@untie/core/sample";
import { moveFrameWithDescendants, nodeRect } from "../drop";

const B = "board_overview";

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
