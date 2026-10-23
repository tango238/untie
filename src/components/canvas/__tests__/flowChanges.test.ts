import type { NodeChange } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { createHotelSample } from "../../../sample";
import { nodeRect } from "../drop";
import { applyFlowChanges } from "../flowChanges";

const B = "board_overview";

function apply(changes: NodeChange[], model = createHotelSample()) {
  const r = applyFlowChanges(model, B, changes);
  if (!r.ok) throw new Error(r.reason);
  return r.model;
}
const rectOf = (m: ReturnType<typeof createHotelSample>, id: string) => {
  const r = nodeRect(m, B, id)!;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

describe("applyFlowChanges", () => {
  it("枠の中のカードの移動 (親からの相対座標) を絶対座標にして反映する", () => {
    const m0 = createHotelSample();
    const frame = rectOf(m0, "biz_checkin");
    const card = rectOf(m0, "act_verify_identity");
    const m = apply([{ id: "act_verify_identity", type: "position", position: { x: card.x - frame.x + 10, y: card.y - frame.y + 20 } }], m0);
    expect(rectOf(m, "act_verify_identity")).toMatchObject({ x: card.x + 10, y: card.y + 20 });
    expect(rectOf(m, "biz_checkin")).toEqual(frame);
  });

  it("枠の移動は子と孫 (BUC の小枠の中のアクティビティ) も同じ量だけ動かす", () => {
    const m0 = createHotelSample();
    const before = (id: string) => rectOf(m0, id);
    const m = apply([{ id: "biz_stay", type: "position", position: { x: before("biz_stay").x + 50, y: before("biz_stay").y - 10 } }], m0);
    for (const id of ["biz_stay", "buc_room_care", "act_room_request", "buc_dining", "act_room_service", "act_record_extra"]) {
      expect(rectOf(m, id)).toMatchObject({ x: before(id).x + 50, y: before(id).y - 10 });
    }
    expect(rectOf(m, "biz_checkin")).toEqual(before("biz_checkin"));
  });

  it("左上からのリサイズ: 枠だけが動いて大きさが変わり、子と孫は動かない", () => {
    const m0 = createHotelSample();
    const f = rectOf(m0, "biz_stay");
    const dx = -30;
    const dy = -20;
    const childIds = ["buc_room_care", "buc_dining", "act_record_extra"];
    // React Flow が 1 回の変更で送ってくる形: 枠の position, 枠の dimensions, 直下の子の相対補正
    const changes: NodeChange[] = [
      { id: "biz_stay", type: "position", position: { x: f.x + dx, y: f.y + dy } },
      {
        id: "biz_stay",
        type: "dimensions",
        resizing: true,
        setAttributes: true,
        dimensions: { width: f.width - dx, height: f.height - dy },
      },
      ...childIds.map((id): NodeChange => {
        const c = rectOf(m0, id);
        return { id, type: "position", position: { x: c.x - f.x - dx, y: c.y - f.y - dy } };
      }),
    ];
    const m = apply(changes, m0);
    expect(rectOf(m, "biz_stay")).toEqual({ x: f.x + dx, y: f.y + dy, width: f.width - dx, height: f.height - dy });
    for (const id of [...childIds, "act_room_request", "act_room_service"]) {
      expect(rectOf(m, id)).toEqual(rectOf(m0, id));
    }
  });

  it("子の補正が枠より先に来ても、リサイズとして扱い子は動かない", () => {
    const m0 = createHotelSample();
    const f = rectOf(m0, "biz_checkin");
    const c = rectOf(m0, "act_verify_identity");
    const m = apply(
      [
        { id: "act_verify_identity", type: "position", position: { x: c.x - f.x + 15, y: c.y - f.y + 5 } },
        { id: "biz_checkin", type: "position", position: { x: f.x - 15, y: f.y - 5 } },
        { id: "biz_checkin", type: "dimensions", resizing: true, setAttributes: true, dimensions: { width: f.width + 15, height: f.height + 5 } },
      ],
      m0,
    );
    expect(rectOf(m, "act_verify_identity")).toEqual(c);
    expect(rectOf(m, "biz_checkin")).toEqual({ x: f.x - 15, y: f.y - 5, width: f.width + 15, height: f.height + 5 });
  });

  it("右下からのリサイズ (位置の変更なし) は大きさだけを変える。入れ子の BUC の小枠も同様", () => {
    const m0 = createHotelSample();
    const care = rectOf(m0, "buc_room_care");
    const m = apply([{ id: "buc_room_care", type: "dimensions", resizing: true, setAttributes: true, dimensions: { width: care.width + 40, height: care.height + 30 } }], m0);
    expect(rectOf(m, "buc_room_care")).toEqual({ ...care, width: care.width + 40, height: care.height + 30 });
    expect(rectOf(m, "act_room_request")).toEqual(rectOf(m0, "act_room_request"));
  });

  it("入れ子の BUC の小枠を左上からリサイズしても、孫は動かない", () => {
    const m0 = createHotelSample();
    const care = rectOf(m0, "buc_room_care");
    const parent = rectOf(m0, "biz_stay");
    const act = rectOf(m0, "act_room_request");
    const m = apply(
      [
        { id: "buc_room_care", type: "position", position: { x: care.x - parent.x - 10, y: care.y - parent.y - 10 } },
        { id: "buc_room_care", type: "dimensions", resizing: true, setAttributes: true, dimensions: { width: care.width + 10, height: care.height + 10 } },
        { id: "act_room_request", type: "position", position: { x: act.x - care.x + 10, y: act.y - care.y + 10 } },
      ],
      m0,
    );
    expect(rectOf(m, "buc_room_care")).toEqual({ x: care.x - 10, y: care.y - 10, width: care.width + 10, height: care.height + 10 });
    expect(rectOf(m, "act_room_request")).toEqual(act);
  });

  it("選択・測定のみの変更や、ボードに無いノードの変更ではモデルが変わらない", () => {
    const m0 = createHotelSample();
    const m = apply(
      [
        { id: "act_clean", type: "select", selected: true },
        { id: "act_clean", type: "dimensions", dimensions: { width: 168, height: 64 } },
        { id: "nope", type: "position", position: { x: 1, y: 1 } },
      ],
      m0,
    );
    expect(m).toBe(m0);
  });
});
