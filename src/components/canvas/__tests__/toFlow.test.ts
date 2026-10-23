import { describe, expect, it } from "vitest";
import { removeFromBoard, moveActivity, placeOnBoard } from "../../../model/commands";
import { createHotelSample } from "../../../sample";
import { okModel } from "../../../model/__tests__/helpers";
import { sampleWithActorCards } from "../../../test/utils";
import {
  buildFlowEdges,
  buildFlowNodes,
  descendantElementIds,
  parentFrameElementId,
  toModelPosition,
  toRelativePosition,
} from "../toFlow";

const sample = createHotelSample;

describe("buildFlowNodes", () => {
  it("枠の中のアクティビティは parentId を持ち、座標が相対になる", () => {
    const m = sample();
    const nodes = buildFlowNodes(m, "board_overview");
    const biz = nodes.find((n) => n.id === "biz_checkin")!;
    const act = nodes.find((n) => n.id === "act_verify_identity")!;
    const abs = m.boards[0].nodes.find((n) => n.elementId === "act_verify_identity")!;
    const bizAbs = m.boards[0].nodes.find((n) => n.elementId === "biz_checkin")!;
    expect(act.parentId).toBe("biz_checkin");
    expect(act.position).toEqual({ x: abs.x - bizAbs.x, y: abs.y - bizAbs.y });
    expect(biz.parentId).toBeUndefined();
    expect(biz.position).toEqual({ x: bizAbs.x, y: bizAbs.y });
    expect(biz.type).toBe("frame");
    expect(act.type).toBe("card");
  });

  it("親が必ず子より前に来る (業務枠 → BUC 小枠 → カード)", () => {
    const nodes = buildFlowNodes(sample(), "board_overview");
    const index = (id: string) => nodes.findIndex((n) => n.id === id);
    for (const n of nodes) {
      if (n.parentId) expect(index(n.parentId)).toBeLessThan(index(n.id));
    }
    expect(index("biz_stay")).toBeLessThan(index("buc_room_care"));
    expect(index("buc_room_care")).toBeLessThan(index("act_room_request"));
    expect(nodes.find((n) => n.id === "act_room_request")!.parentId).toBe("buc_room_care");
    expect(nodes.find((n) => n.id === "buc_room_care")!.parentId).toBe("biz_stay");
    // 既定 BUC のアクティビティは業務の枠の直下
    expect(nodes.find((n) => n.id === "act_record_extra")!.parentId).toBe("biz_stay");
  });

  it("既定 BUC と課題はノードにならない", () => {
    const nodes = buildFlowNodes(sample(), "board_overview");
    expect(nodes.some((n) => n.id.startsWith("buc_default_"))).toBe(false);
    expect(nodes.some((n) => n.id.startsWith("issue_"))).toBe(false);
  });

  it("枠の無いボードでは業務名・「業務名 / BUC 名」をラベルに入れる", () => {
    const nodes = buildFlowNodes(sample(), "board_flow");
    const verify = nodes.find((n) => n.id === "act_verify_identity")!;
    expect(verify.parentId).toBeUndefined();
    expect(verify.data).toMatchObject({ label: "チェックイン" });
    expect(verify.position).toEqual({ x: 40, y: expect.any(Number) });
    // BUC の下のアクティビティを枠なしで置くと「業務名 / BUC 名」
    let m = sample();
    m = okModel(placeOnBoard(m, { boardId: "board_flow", elementId: "act_room_request", position: { x: 0, y: 0 } }));
    const n = buildFlowNodes(m, "board_flow").find((x) => x.id === "act_room_request")!;
    expect(n.data.label).toBe("滞在中の対応 / 客室対応");
  });

  it("未所属のアクティビティには「未所属」を出す", () => {
    const m = okModel(moveActivity(sample(), { activityId: "act_verify_identity", bucId: null }));
    const nodes = buildFlowNodes(m, "board_overview");
    const n = nodes.find((x) => x.id === "act_verify_identity")!;
    expect(n.parentId).toBeUndefined();
    expect(n.data.label).toBe("未所属");
    // 絶対座標のまま
    const abs = m.boards[0].nodes.find((x) => x.elementId === "act_verify_identity")!;
    expect(n.position).toEqual({ x: abs.x, y: abs.y });
  });

  it("業務の枠だけが無く BUC の小枠があるとき、BUC は業務名を添えた枠になる", () => {
    const m = okModel(removeFromBoard(sample(), { boardId: "board_overview", elementId: "biz_stay" }));
    const nodes = buildFlowNodes(m, "board_overview");
    const buc = nodes.find((n) => n.id === "buc_room_care")!;
    expect(buc.parentId).toBeUndefined();
    expect(buc.data.label).toBe("滞在中の対応");
    // BUC の枠があるので、アクティビティの親は BUC のまま
    expect(nodes.find((n) => n.id === "act_room_request")!.parentId).toBe("buc_room_care");
  });

  it("課題バッジの件数と最高重要度を data に入れる", () => {
    const m = sample();
    const nodes = buildFlowNodes(m, "board_overview");
    const withIssue = nodes.filter((n) => n.data.issueCount > 0);
    expect(withIssue.length).toBeGreaterThan(0);
    for (const n of withIssue) {
      expect(n.data.maxSeverity).toBeGreaterThanOrEqual(1);
    }
  });

  it("選択中の要素に selected を付ける", () => {
    const nodes = buildFlowNodes(sampleWithActorCards(), "board_overview", { selectedElementId: "actor_front" });
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["actor_front"]);
  });

  it("存在しないボードは空", () => {
    expect(buildFlowNodes(sample(), "nope")).toEqual([]);
    expect(buildFlowEdges(sample(), "nope")).toEqual([]);
  });

  it("枠のサイズはモデルの値、無ければ既定値", () => {
    const frame = buildFlowNodes(sample(), "board_overview").find((n) => n.id === "biz_stay")!;
    expect(frame).toMatchObject({ width: 520 });
  });
});

describe("座標の変換", () => {
  it("相対化と絶対化は逆変換", () => {
    const parent = { x: 340, y: 120 };
    const abs = { x: 400, y: 250 };
    const rel = toRelativePosition(abs, parent);
    expect(rel).toEqual({ x: 60, y: 130 });
    expect(toModelPosition(rel, parent)).toEqual(abs);
    expect(toModelPosition(abs, null)).toEqual(abs);
    expect(toRelativePosition(abs, null)).toEqual(abs);
  });

  it("buildFlowNodes の相対座標に親の座標を足すと、モデルの座標に戻る", () => {
    const m = sample();
    const nodes = buildFlowNodes(m, "board_overview");
    for (const n of nodes) {
      const parent = n.parentId ? m.boards[0].nodes.find((x) => x.elementId === n.parentId)! : null;
      const abs = toModelPosition(n.position, parent ? { x: parent.x, y: parent.y } : null);
      const bn = m.boards[0].nodes.find((x) => x.elementId === n.id)!;
      expect(abs).toEqual({ x: bn.x, y: bn.y });
    }
  });
});

describe("親枠の判定", () => {
  it("parentFrameElementId と descendantElementIds", () => {
    const m = sample();
    expect(parentFrameElementId(m, "board_overview", "act_room_request")).toBe("buc_room_care");
    expect(parentFrameElementId(m, "board_overview", "buc_dining")).toBe("biz_stay");
    expect(parentFrameElementId(m, "board_overview", "actor_front")).toBeNull();
    expect(parentFrameElementId(m, "board_flow", "act_verify_identity")).toBeNull();
    expect(descendantElementIds(m, "board_overview", "biz_stay").sort()).toEqual(
      ["act_record_extra", "act_room_request", "act_room_service", "buc_dining", "buc_room_care"].sort(),
    );
    expect(descendantElementIds(m, "board_overview", "buc_dining")).toEqual(["act_room_service"]);
  });
});

describe("buildFlowEdges", () => {
  it("両端がボードにある関係だけをエッジにする", () => {
    const m = sample();
    const flow = buildFlowEdges(m, "board_flow");
    const onBoard = new Set(m.boards[1].nodes.map((n) => n.elementId));
    expect(flow.length).toBeGreaterThan(0);
    for (const e of flow) {
      expect(onBoard.has(e.source) && onBoard.has(e.target)).toBe(true);
    }
    const expected = m.relations.filter((r) => onBoard.has(r.sourceId) && onBoard.has(r.targetId));
    expect(flow).toHaveLength(expected.length);
    expect(flow.some((e) => e.data!.kind === "activityUsecase")).toBe(true);
  });

  it("アクターの担当は線にせず、業務の枠・アクティビティのカードにラベルで出す", () => {
    const m = sampleWithActorCards();
    // アクターのカードがボードにあっても線は引かない
    expect(buildFlowEdges(m, "board_overview").some((e) => e.source.startsWith("actor_"))).toBe(false);
    const nodes = buildFlowNodes(createHotelSample(), "board_overview");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("biz_checkin")!.data.actors).toEqual([{ name: "フロント担当", kind: "actor" }]);
    expect(byId.get("act_verify_identity")!.data.actors).toEqual([
      { name: "フロント担当", kind: "actor" },
      { name: "宿泊客", kind: "externalActor" },
    ]);
    // ボードに無いアクティビティのラベルも、アクターがボードに無くても出る
    expect(buildFlowNodes(m, "board_flow").find((n) => n.id === "act_hand_key")!.data.actors).toEqual([
      { name: "フロント担当", kind: "actor" },
    ]);
  });

  it("informationRelated は矢印なし、それ以外は終点に矢印、ラベルは関係名", () => {
    const m = sample();
    const edges = buildFlowEdges(m, "board_state").concat(buildFlowEdges(m, "board_flow"));
    const related = edges.find((e) => e.data!.kind === "informationRelated");
    const directed = edges.find((e) => e.data!.kind === "usecaseInformation");
    expect(related).toBeDefined();
    expect(related!.markerEnd).toBeUndefined();
    expect(related!.label).toBe("関連");
    expect(directed!.markerEnd).toMatchObject({ type: "arrowclosed" });
    expect(directed!.label).toBe("扱う");
  });

  it("ボードから外すと、その要素の線は消える (関係自体は残る)", () => {
    const m0 = sample();
    const m = okModel(removeFromBoard(m0, { boardId: "board_flow", elementId: "uc_register_reservation" }));
    const before = buildFlowEdges(m0, "board_flow").length;
    const after = buildFlowEdges(m, "board_flow");
    expect(after.length).toBeLessThan(before);
    expect(m.relations).toBe(m0.relations);
    expect(after.some((e) => e.source === "uc_register_reservation" || e.target === "uc_register_reservation")).toBe(false);
  });

  it("選択中の関係に selected を付ける", () => {
    const m = sample();
    const first = buildFlowEdges(m, "board_flow")[0]!;
    const edges = buildFlowEdges(m, "board_flow", { selectedRelationId: first.id });
    expect(edges.filter((e) => e.selected).map((e) => e.id)).toEqual([first.id]);
  });
});
