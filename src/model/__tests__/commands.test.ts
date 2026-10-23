import { describe, expect, it } from "vitest";
import {
  addBoard,
  addElement,
  addRelation,
  clearAll,
  DEFAULT_FRAME_SIZE,
  moveActivity,
  moveBuc,
  moveNode,
  placeOnBoard,
  removeBoard,
  removeElement,
  removeFromBoard,
  removeRelation,
  renameBoard,
  setIssueTargets,
  updateElement,
} from "../commands";
import { validateModel } from "../validate";
import { emptyModel, type Buc, type UntieModel } from "../types";
import { expectFail, okModel, sample } from "./helpers";

const el = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id);
const defaultBuc = (m: UntieModel, bizId: string) =>
  m.elements.find((e): e is Buc => e.kind === "buc" && e.isDefault && e.businessId === bizId)!;

/** どの操作のあとでもモデルは整合していること */
function expectValid(m: UntieModel) {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

describe("addElement", () => {
  it("業務を作ると既定 BUC が 1 つ作られ、名前は業務名と同じ", () => {
    const m = okModel(addElement(emptyModel(), { kind: "business", name: "新業務" }));
    const biz = m.elements.find((e) => e.kind === "business")!;
    const bucs = m.elements.filter((e): e is Buc => e.kind === "buc");
    expect(bucs).toHaveLength(1);
    expect(bucs[0]).toMatchObject({ isDefault: true, businessId: biz.id, name: "新業務" });
    expectValid(m);
  });

  it("各種類を作れて、既定値が入る", () => {
    let m = emptyModel();
    const biz = addElement(m, { kind: "business", name: "B" });
    m = okModel(biz);
    const kinds = ["actor", "externalActor", "usecase", "information", "state", "variation", "condition", "issue", "activity"] as const;
    for (const kind of kinds) m = okModel(addElement(m, { kind, name: ` ${kind} ` }));
    expect(m.elements.find((e) => e.kind === "issue")).toMatchObject({ severity: 3, targetIds: [], name: "issue" });
    expect(m.elements.find((e) => e.kind === "variation")).toMatchObject({ values: [] });
    expect(m.elements.find((e) => e.kind === "activity")).toMatchObject({ bucId: null });
    expectValid(m);
  });

  it("boardId を渡すとそのボードに置かれ、枠には既定サイズが付く", () => {
    const base = emptyModel("t", "b1");
    const r1 = addElement(base, { kind: "business", name: "B", boardId: "b1", position: { x: 10, y: 20 } });
    const m1 = okModel(r1);
    expect(m1.boards[0].nodes[0]).toEqual({ elementId: (r1 as { id: string }).id, x: 10, y: 20, ...DEFAULT_FRAME_SIZE.business });
    const m2 = okModel(addElement(m1, { kind: "actor", name: "A", boardId: "b1" }));
    expect(m2.boards[0].nodes[1]).toMatchObject({ x: 0, y: 0 });
    expect(m2.boards[0].nodes[1].width).toBeUndefined();
    expectValid(m2);
  });

  it("課題はボードに置けない", () => {
    const m = emptyModel("t", "b1");
    expectFail(addElement(m, { kind: "issue", name: "x", boardId: "b1" }), /課題/);
  });

  it("存在しないボード・BUC・業務・対象は失敗する", () => {
    const m = sample();
    expectFail(addElement(m, { kind: "actor", name: "x", boardId: "nope" }), /ボード/);
    expectFail(addElement(m, { kind: "buc", name: "x" }), /業務/);
    expectFail(addElement(m, { kind: "buc", name: "x", init: { businessId: "actor_front" } }), /業務/);
    expectFail(addElement(m, { kind: "activity", name: "x", init: { bucId: "nope" } }), /BUC/);
    expectFail(addElement(m, { kind: "issue", name: "x", init: { targetIds: ["actor_front"] } }), /対象/);
    expectFail(addElement(m, { kind: "issue", name: "x", init: { severity: 9 } }), /重要度/);
  });

  it("id の重複は失敗する", () => {
    expectFail(addElement(sample(), { kind: "actor", name: "x", id: "actor_front" }), /重複/);
  });

  it("BUC を追加できる", () => {
    const m = okModel(addElement(sample(), { kind: "buc", name: "新 BUC", init: { businessId: "biz_checkin" } }));
    expect(m.elements.filter((e) => e.kind === "buc" && e.businessId === "biz_checkin")).toHaveLength(2);
    expectValid(m);
  });

  it("元のモデルは変更されない", () => {
    const m = sample();
    const before = JSON.stringify(m);
    addElement(m, { kind: "actor", name: "x" });
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe("updateElement", () => {
  it("名前と説明を変えられる。空の説明は項目ごと消える", () => {
    let m = okModel(updateElement(sample(), { id: "actor_front", patch: { name: " 受付 ", description: "説明" } }));
    expect(el(m, "actor_front")).toMatchObject({ name: "受付", description: "説明" });
    m = okModel(updateElement(m, { id: "actor_front", patch: { description: "" } }));
    expect(el(m, "actor_front")).not.toHaveProperty("description");
  });

  it("業務名を変えると既定 BUC の名前も追従する", () => {
    const m = okModel(updateElement(sample(), { id: "biz_checkin", patch: { name: "到着対応" } }));
    expect(defaultBuc(m, "biz_checkin").name).toBe("到着対応");
  });

  it("種類固有の項目を変えられる", () => {
    let m = okModel(updateElement(sample(), { id: "var_room_type", patch: { values: ["a", "b"] } }));
    expect(el(m, "var_room_type")).toMatchObject({ values: ["a", "b"] });
    m = okModel(updateElement(m, { id: "issue_manual_entry", patch: { severity: 1 } }));
    expect(el(m, "issue_manual_entry")).toMatchObject({ severity: 1 });
    m = okModel(updateElement(m, { id: "info_room", patch: { context: "" } }));
    expect(el(m, "info_room")).not.toHaveProperty("context");
    m = okModel(updateElement(m, { id: "st_res_confirmed", patch: { group: "G" } }));
    expect(el(m, "st_res_confirmed")).toMatchObject({ group: "G" });
    expectValid(m);
  });

  it("その種類にない項目や不正な値は失敗する", () => {
    const m = sample();
    expectFail(updateElement(m, { id: "actor_front", patch: { severity: 3 } }), /変更できません/);
    expectFail(updateElement(m, { id: "issue_manual_entry", patch: { severity: 0 } }), /重要度/);
    expectFail(updateElement(m, { id: "issue_manual_entry", patch: { severity: 2.5 } }), /重要度/);
    expectFail(updateElement(m, { id: "issue_manual_entry", patch: { targetIds: ["actor_front"] } }), /対象/);
    expectFail(updateElement(m, { id: "nope", patch: { name: "x" } }), /存在しません/);
    expectFail(updateElement(m, { id: "act_clean", patch: { bucId: "x" } as never }), /変更できません/);
  });
});

describe("removeElement", () => {
  it("要素を消すと、関係・ボードのノード・課題の対象が掃除される", () => {
    const before = sample();
    expect(before.relations.some((r) => r.sourceId === "act_clean" || r.targetId === "act_clean")).toBe(true);
    const m = okModel(removeElement(before, { id: "act_clean" }));
    expect(el(m, "act_clean")).toBeUndefined();
    expect(m.relations.some((r) => r.sourceId === "act_clean" || r.targetId === "act_clean")).toBe(false);
    expect(m.boards.some((b) => b.nodes.some((n) => n.elementId === "act_clean"))).toBe(false);
    expect((el(m, "issue_cleaning_phone") as { targetIds: string[] }).targetIds).toEqual(["act_instruct_cleaning"]);
    expectValid(m);
  });

  it("課題自体は対象を消しても残る", () => {
    const m = okModel(removeElement(sample(), { id: "uc_register_extra" }));
    expect(el(m, "issue_extra_missing")).toBeDefined();
    expectValid(m);
  });

  it("課題を消せる", () => {
    const m = okModel(removeElement(sample(), { id: "issue_manual_entry" }));
    expect(el(m, "issue_manual_entry")).toBeUndefined();
    expectValid(m);
  });

  it("既定 BUC は削除できない", () => {
    const m = sample();
    expectFail(removeElement(m, { id: defaultBuc(m, "biz_checkin").id }), /既定 BUC/);
  });

  it("存在しない id は失敗する", () => {
    expectFail(removeElement(sample(), { id: "nope" }), /存在しません/);
  });

  it("既定でない BUC を消すと、所属アクティビティは業務の既定 BUC に戻る", () => {
    const m = okModel(removeElement(sample(), { id: "buc_room_care" }));
    expect(el(m, "buc_room_care")).toBeUndefined();
    expect(el(m, "act_room_request")).toMatchObject({ bucId: defaultBuc(m, "biz_stay").id });
    expect(m.boards[0].nodes.some((n) => n.elementId === "buc_room_care")).toBe(false);
    expectValid(m);
  });

  it("業務を消すと BUC が全て消え、所属アクティビティは未所属になる", () => {
    const before = sample();
    const m = okModel(removeElement(before, { id: "biz_stay" }));
    expect(el(m, "biz_stay")).toBeUndefined();
    expect(m.elements.some((e) => e.kind === "buc" && e.businessId === "biz_stay")).toBe(false);
    expect(el(m, "buc_dining")).toBeUndefined();
    for (const id of ["act_room_request", "act_room_service", "act_record_extra"]) {
      expect(el(m, id)).toMatchObject({ bucId: null });
    }
    // 業務への関係 (主担当) と業務を対象にした課題の対象も掃除される
    expect(m.relations.some((r) => r.targetId === "biz_stay")).toBe(false);
    expect(m.boards[0].nodes.some((n) => ["biz_stay", "buc_dining", "buc_room_care"].includes(n.elementId))).toBe(false);
    expectValid(m);
  });
});

describe("所属の変更", () => {
  it("moveActivity で BUC を変え、null で未所属にできる", () => {
    let m = okModel(moveActivity(sample(), { activityId: "act_hand_key", bucId: "buc_dining" }));
    expect(el(m, "act_hand_key")).toMatchObject({ bucId: "buc_dining" });
    m = okModel(moveActivity(m, { activityId: "act_hand_key", bucId: null }));
    expect(el(m, "act_hand_key")).toMatchObject({ bucId: null });
    expectValid(m);
  });

  it("moveActivity は不正な対象を拒否する", () => {
    const m = sample();
    expectFail(moveActivity(m, { activityId: "actor_front", bucId: null }), /アクティビティ/);
    expectFail(moveActivity(m, { activityId: "act_clean", bucId: "biz_stay" }), /BUC/);
    expectFail(moveActivity(m, { activityId: "act_clean", bucId: "nope" }), /BUC/);
  });

  it("moveBuc で業務を変えられ、既定 BUC は変えられない", () => {
    const m0 = sample();
    const m = okModel(moveBuc(m0, { bucId: "buc_dining", businessId: "biz_checkout" }));
    expect(el(m, "buc_dining")).toMatchObject({ businessId: "biz_checkout" });
    expect(el(m, "act_room_service")).toMatchObject({ bucId: "buc_dining" });
    expectValid(m);
    expectFail(moveBuc(m0, { bucId: defaultBuc(m0, "biz_checkin").id, businessId: "biz_stay" }), /既定 BUC/);
    expectFail(moveBuc(m0, { bucId: "buc_dining", businessId: "actor_front" }), /業務/);
    expectFail(moveBuc(m0, { bucId: "nope", businessId: "biz_stay" }), /BUC/);
  });
});

describe("関係", () => {
  it("addRelation は両端から kind を決めて作る", () => {
    let m = emptyModel();
    m = okModel(addElement(m, { kind: "actor", name: "a", id: "actor_a" }));
    m = okModel(addElement(m, { kind: "activity", name: "b", id: "act_b" }));
    const r = addRelation(m, { sourceId: "actor_a", targetId: "act_b" });
    m = okModel(r);
    expect(m.relations[0]).toMatchObject({ kind: "actorActivity", sourceId: "actor_a", targetId: "act_b" });
    expectValid(m);
  });

  it("引けない組み合わせ・自己参照・存在しない id・重複は失敗する", () => {
    const m = sample();
    expectFail(addRelation(m, { sourceId: "act_clean", targetId: "actor_front" }), /結べません/);
    expectFail(addRelation(m, { sourceId: "act_clean", targetId: "act_clean" }), /自分自身/);
    expectFail(addRelation(m, { sourceId: "nope", targetId: "act_clean" }), /始点/);
    expectFail(addRelation(m, { sourceId: "actor_front", targetId: "nope" }), /終点/);
    expectFail(addRelation(m, { sourceId: "actor_housekeeping", targetId: "act_clean" }), /すでに/);
    expectFail(addRelation(m, { sourceId: "info_bill", targetId: "issue_manual_entry" }), /結べません/);
  });

  it("informationRelated は向きを逆にしても重複とみなす", () => {
    const m = sample();
    expectFail(addRelation(m, { sourceId: "info_guest", targetId: "info_reservation" }), /すでに/);
    const ok = okModel(addRelation(m, { sourceId: "info_guest", targetId: "info_room" }));
    expect(ok.relations.slice(-1)[0]).toMatchObject({ kind: "informationRelated" });
  });

  it("状態遷移は stateUsecase と usecaseState を別の関係として持てる", () => {
    let m = emptyModel();
    m = okModel(addElement(m, { kind: "state", name: "s", id: "st_s" }));
    m = okModel(addElement(m, { kind: "usecase", name: "u", id: "uc_u" }));
    m = okModel(addRelation(m, { sourceId: "st_s", targetId: "uc_u" }));
    m = okModel(addRelation(m, { sourceId: "uc_u", targetId: "st_s" }));
    expect(m.relations.map((r) => r.kind)).toEqual(["stateUsecase", "usecaseState"]);
  });

  it("removeRelation", () => {
    const m0 = sample();
    const id = m0.relations[0].id;
    const m = okModel(removeRelation(m0, { id }));
    expect(m.relations).toHaveLength(m0.relations.length - 1);
    expectFail(removeRelation(m, { id }), /存在しません/);
  });
});

describe("ボードとノード", () => {
  it("addBoard / renameBoard", () => {
    let m = okModel(addBoard(sample(), { name: " 新ボード " }));
    const added = m.boards.slice(-1)[0]!;
    expect(added).toMatchObject({ name: "新ボード", nodes: [] });
    m = okModel(renameBoard(m, { id: added.id, name: "改名" }));
    expect(m.boards.slice(-1)[0]!.name).toBe("改名");
    expectFail(renameBoard(m, { id: "nope", name: "x" }), /ボード/);
    expectFail(addBoard(m, { name: "x", id: "board_flow" }), /重複/);
  });

  it("removeBoard はボードだけを消し、要素と関係は残す。最後の 1 枚は消せない", () => {
    const m0 = sample();
    const m = okModel(removeBoard(m0, { id: "board_flow" }));
    expect(m.boards.map((b) => b.id)).not.toContain("board_flow");
    expect(m.elements).toBe(m0.elements);
    expect(m.relations).toBe(m0.relations);
    expectValid(m);
    expectFail(removeBoard(m0, { id: "nope" }), /ボード/);
    const only = emptyModel();
    expectFail(removeBoard(only, { id: only.boards[0].id }), /最後/);
  });

  it("placeOnBoard は課題・既定 BUC・二重配置・不正な指定を拒否する", () => {
    const m = sample();
    expectFail(placeOnBoard(m, { boardId: "board_flow", elementId: "issue_manual_entry", position: { x: 0, y: 0 } }), /課題/);
    expectFail(
      placeOnBoard(m, { boardId: "board_flow", elementId: defaultBuc(m, "biz_stay").id, position: { x: 0, y: 0 } }),
      /既定 BUC/,
    );
    expectFail(placeOnBoard(m, { boardId: "board_flow", elementId: "uc_register_reservation", position: { x: 0, y: 0 } }), /すでに/);
    expectFail(placeOnBoard(m, { boardId: "nope", elementId: "actor_front", position: { x: 0, y: 0 } }), /ボード/);
    expectFail(placeOnBoard(m, { boardId: "board_flow", elementId: "nope", position: { x: 0, y: 0 } }), /要素/);
    expectFail(placeOnBoard(m, { boardId: "board_flow", elementId: "actor_front", position: { x: NaN, y: 0 } }), /座標/);
  });

  it("placeOnBoard で置け、枠は既定サイズ、別ボードには同じ要素を置ける", () => {
    let m = okModel(placeOnBoard(sample(), { boardId: "board_flow", elementId: "biz_stay", position: { x: 5, y: 6 } }));
    expect(m.boards[1].nodes.slice(-1)[0]).toEqual({ elementId: "biz_stay", x: 5, y: 6, ...DEFAULT_FRAME_SIZE.business });
    m = okModel(placeOnBoard(m, { boardId: "board_flow", elementId: "buc_dining", position: { x: 5, y: 6 } }));
    expect(m.boards[1].nodes.slice(-1)[0]).toMatchObject(DEFAULT_FRAME_SIZE.buc);
    // 「全体」にあるアクターを別ボードにも置ける
    m = okModel(placeOnBoard(m, { boardId: "board_flow", elementId: "actor_front", position: { x: 1, y: 2 } }));
    expectValid(m);
  });

  it("removeFromBoard は要素を残してノードだけ外す", () => {
    const m = okModel(removeFromBoard(sample(), { boardId: "board_flow", elementId: "uc_register_reservation" }));
    expect(m.boards[1].nodes.some((n) => n.elementId === "uc_register_reservation")).toBe(false);
    expect(el(m, "uc_register_reservation")).toBeDefined();
    expect(m.boards[0].nodes.length).toBe(sample().boards[0].nodes.length);
    expectFail(removeFromBoard(m, { boardId: "board_flow", elementId: "uc_register_reservation" }), /ありません/);
  });

  it("moveNode は座標とサイズを変える。サイズ省略時は維持される", () => {
    let m = okModel(moveNode(sample(), { boardId: "board_overview", elementId: "biz_stay", position: { x: 1, y: 2 } }));
    let n = m.boards[0].nodes.find((x) => x.elementId === "biz_stay")!;
    expect(n).toMatchObject({ x: 1, y: 2, width: 520, height: 420 });
    m = okModel(moveNode(m, { boardId: "board_overview", elementId: "biz_stay", position: { x: 1, y: 2 }, size: { width: 600, height: 300 } }));
    n = m.boards[0].nodes.find((x) => x.elementId === "biz_stay")!;
    expect(n).toMatchObject({ width: 600, height: 300 });
    expectFail(moveNode(m, { boardId: "board_overview", elementId: "biz_stay", position: { x: 0, y: 0 }, size: { width: 0, height: 5 } }), /サイズ/);
    expectFail(moveNode(m, { boardId: "board_flow", elementId: "biz_stay", position: { x: 0, y: 0 } }), /ありません/);
  });
});

describe("課題・全体", () => {
  it("setIssueTargets は対象の種類を検査し、重複を除く", () => {
    const m0 = sample();
    const m = okModel(setIssueTargets(m0, { issueId: "issue_manual_entry", targetIds: ["biz_checkin", "biz_checkin", "uc_cancel_reservation"] }));
    expect(el(m, "issue_manual_entry")).toMatchObject({ targetIds: ["biz_checkin", "uc_cancel_reservation"] });
    expect(okModel(setIssueTargets(m0, { issueId: "issue_manual_entry", targetIds: [] })).elements.length).toBe(m0.elements.length);
    expectFail(setIssueTargets(m0, { issueId: "issue_manual_entry", targetIds: ["actor_front"] }), /対象/);
    expectFail(setIssueTargets(m0, { issueId: "issue_manual_entry", targetIds: ["nope"] }), /存在しません/);
    expectFail(setIssueTargets(m0, { issueId: "actor_front", targetIds: [] }), /課題/);
  });

  it("clearAll は空のボード「ボード 1」だけにする", () => {
    const m = okModel(clearAll(sample()));
    expect(m.elements).toEqual([]);
    expect(m.relations).toEqual([]);
    expect(m.boards).toHaveLength(1);
    expect(m.boards[0]).toMatchObject({ name: "ボード 1", nodes: [] });
    expectValid(m);
  });
});

describe("既定 BUC まわりの追加検査", () => {
  it("既定 BUC の名前は直接変えられない (業務名の変更には追従する)", () => {
    const m = sample();
    expectFail(updateElement(m, { id: defaultBuc(m, "biz_checkin").id, patch: { name: "別名" } }), /既定 BUC/);
    const renamed = okModel(updateElement(m, { id: "biz_checkin", patch: { name: "到着手続き" } }));
    expect(defaultBuc(renamed, "biz_checkin").name).toBe("到着手続き");
    expectValid(renamed);
  });

  it("業務を作ってボードに置いても、既定 BUC はボードに置かれない", () => {
    const m = okModel(addElement(sample(), { kind: "business", name: "新業務", boardId: "board_overview", position: { x: 0, y: 0 } }));
    const biz = m.elements.find((e) => e.kind === "business" && e.name === "新業務")!;
    const board = m.boards.find((b) => b.id === "board_overview")!;
    expect(board.nodes.some((n) => n.elementId === biz.id)).toBe(true);
    expect(board.nodes.some((n) => n.elementId === defaultBuc(m, biz.id).id)).toBe(false);
    expectValid(m);
  });
});
