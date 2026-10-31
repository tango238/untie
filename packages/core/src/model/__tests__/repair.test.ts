import { describe, expect, it } from "vitest";
import { addElement, addRelation, DEFAULT_FRAME_SIZE } from "../commands";
import { repairModel } from "../repair";
import { sameRelation } from "../relations";
import { validateModel } from "../validate";
import { emptyModel, type UntieModel } from "../types";
import { okModel, sample } from "./helpers";

/** 参照を壊すために、JSON の複製を直接書き換える */
function clone(m: UntieModel): UntieModel {
  return JSON.parse(JSON.stringify(m));
}

function expectValid(m: UntieModel) {
  const r = validateModel(JSON.parse(JSON.stringify(m)));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

describe("repairModel", () => {
  it("壊れていなければ同じ参照を返し、changes は空", () => {
    for (const m of [sample(), emptyModel()]) {
      const r = repairModel(m);
      expect(r.model).toBe(m);
      expect(r.changes).toEqual([]);
    }
  });

  it("消えた要素を指す関係を消す (始点・終点どちらでも)", () => {
    const m = clone(sample());
    const [r0, r1] = m.relations;
    const gone = new Set([r0.sourceId, r1.targetId]);
    m.elements = m.elements.filter((e) => !gone.has(e.id));
    const r = repairModel(m);
    expect(r.model.relations.some((x) => gone.has(x.sourceId) || gone.has(x.targetId))).toBe(false);
    expect(r.model.relations.some((x) => x.id === r0.id || x.id === r1.id)).toBe(false);
    expect(r.changes.some((c) => c.includes(`関係 ${r0.id} を消した`) && c.includes("端の要素") && c.includes("が無い"))).toBe(true);
    expect(r.changes.length).toBeGreaterThan(0);
  });

  it("消えた要素を指すノードと、消えた関係の線の設定を消す", () => {
    let m = okModel(addElement(emptyModel(), { kind: "actor", name: "A", id: "actor_a", boardId: "board_main" }));
    m = okModel(addElement(m, { kind: "activity", name: "B", id: "act_b", boardId: "board_main" }));
    m = okModel(addRelation(m, { sourceId: "actor_a", targetId: "act_b", id: "rel_ab" }));
    m = clone(m);
    m.boards[0].edges = [{ relationId: "rel_ab", sourceSide: "top" }];
    m.elements = m.elements.filter((e) => e.id !== "act_b");
    const r = repairModel(m);
    expect(r.model.boards[0].nodes.map((n) => n.elementId)).toEqual(["actor_a"]);
    expect(r.model.relations).toEqual([]);
    expect(r.model.boards[0].edges).toBeUndefined();
    expectValid(r.model);
  });

  it("消えた要素を指す課題の targetIds を外す", () => {
    let m = okModel(addElement(emptyModel(), { kind: "actor", name: "A", id: "actor_a" }));
    m = okModel(addElement(m, { kind: "actor", name: "B", id: "actor_b" }));
    m = okModel(addElement(m, { kind: "issue", name: "課題", id: "issue_x", init: { targetIds: ["actor_a", "actor_b"] } }));
    m = clone(m);
    m.elements = m.elements.filter((e) => e.id !== "actor_a");
    const r = repairModel(m);
    const issue = r.model.elements.find((e) => e.id === "issue_x");
    expect(issue && issue.kind === "issue" && issue.targetIds).toEqual(["actor_b"]);
    expect(r.changes).toEqual(["課題 issue_x の対象 actor_a を外した (要素が無い)"]);
    expectValid(r.model);
  });

  it("消えた活動を指す作業の bucId と、消えたコンテキストを指す contextId を null にする", () => {
    let m = okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a" }));
    m = okModel(addElement(m, { kind: "buc", name: "活動", id: "buc_a", init: { businessId: "biz_a" } }));
    m = okModel(addElement(m, { kind: "activity", name: "作業", id: "act_a", init: { bucId: "buc_a" } }));
    m = okModel(addElement(m, { kind: "context", name: "文脈", id: "ctx_a" }));
    m = okModel(addElement(m, { kind: "information", name: "情報", id: "info_a", init: { contextId: "ctx_a" } }));
    m = okModel(addElement(m, { kind: "state", name: "状態", id: "st_a", init: { contextId: "ctx_a" } }));
    m = clone(m);
    m.elements = m.elements.filter((e) => e.id !== "buc_a" && e.id !== "ctx_a");
    const r = repairModel(m);
    const get = (id: string) => r.model.elements.find((e) => e.id === id) as unknown as Record<string, unknown>;
    expect(get("act_a").bucId).toBeNull();
    expect(get("info_a").contextId).toBeNull();
    expect(get("st_a").contextId).toBeNull();
    expectValid(r.model);
  });

  it("業務が消えた活動を消し、その活動を指す作業の bucId も null にする", () => {
    let m = okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a" }));
    m = okModel(addElement(m, { kind: "buc", name: "活動", id: "buc_a", init: { businessId: "biz_a" } }));
    m = okModel(addElement(m, { kind: "activity", name: "作業", id: "act_a", boardId: "board_main", init: { bucId: "buc_a" } }));
    m = clone(m);
    m.elements = m.elements.filter((e) => e.id !== "biz_a");
    // 既定の活動も業務を失っている
    const r = repairModel(m);
    expect(r.model.elements.some((e) => e.kind === "buc")).toBe(false);
    const act = r.model.elements.find((e) => e.id === "act_a");
    expect(act && act.kind === "activity" && act.bucId).toBeNull();
    expect(r.changes.some((c) => c.includes("buc_a") && c.includes("業務"))).toBe(true);
    expectValid(r.model);
  });

  it("同じ関係の重複は先頭を残して畳む (無向の関係は向きを無視)", () => {
    let m = okModel(addElement(emptyModel(), { kind: "information", name: "I1", id: "info_1" }));
    m = okModel(addElement(m, { kind: "information", name: "I2", id: "info_2" }));
    m = okModel(addElement(m, { kind: "actor", name: "A", id: "actor_a" }));
    m = okModel(addElement(m, { kind: "activity", name: "B", id: "act_b" }));
    m = okModel(addRelation(m, { sourceId: "info_1", targetId: "info_2", id: "rel_1" }));
    m = okModel(addRelation(m, { sourceId: "actor_a", targetId: "act_b", id: "rel_2" }));
    m = clone(m);
    m.relations.push(
      { id: "rel_3", kind: "informationRelated", sourceId: "info_2", targetId: "info_1" },
      { id: "rel_4", kind: "actorActivity", sourceId: "actor_a", targetId: "act_b" },
    );
    m.boards[0].edges = [{ relationId: "rel_4", sourceSide: "top" }];
    const r = repairModel(m);
    expect(r.model.relations.map((x) => x.id)).toEqual(["rel_1", "rel_2"]);
    expect(r.model.boards[0].edges).toBeUndefined();
    expect(r.changes).toHaveLength(3);
    expect(r.changes.some((c) => c.includes("重複した関係の線") && c.includes("rel_4"))).toBe(true);
    // 畳んだあとに sameRelation で重複が残らない
    for (const a of r.model.relations) for (const b of r.model.relations) if (a !== b) expect(sameRelation(a, b)).toBe(false);
    expectValid(r.model);
  });

  it("ボードが 0 枚なら「ボード 1」を作る", () => {
    const m = clone(emptyModel());
    (m.boards as unknown[]).length = 0;
    const r = repairModel(m);
    expect(r.model.boards).toEqual([{ id: "board_main", name: "ボード 1", nodes: [] }]);
    expect(r.changes).toHaveLength(1);
    expectValid(r.model);
  });

  it("入力のモデルは変えない", () => {
    const m = clone(sample());
    m.elements = m.elements.filter((e) => e.kind !== "actor");
    const before = JSON.stringify(m);
    const r = repairModel(m);
    expect(JSON.stringify(m)).toBe(before);
    expect(r.model).not.toBe(m);
    expectValid(r.model);
  });

  it("changes の文言は日本語の種類名を使い、「無い」と「種類が違う」を分ける", () => {
    let m = okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a" }));
    m = okModel(addElement(m, { kind: "activity", name: "作業1", id: "act_gone" }));
    m = okModel(addElement(m, { kind: "activity", name: "作業2", id: "act_wrong" }));
    m = clone(m);
    for (const e of m.elements) {
      if (e.id === "act_gone") (e as { bucId: string | null }).bucId = "buc_nowhere";
      if (e.id === "act_wrong") (e as { bucId: string | null }).bucId = "biz_a";
    }
    const r = repairModel(m);
    expect(r.changes).toContain("作業 act_gone の bucId を null にした (活動 buc_nowhere が無い)");
    expect(r.changes).toContain("作業 act_wrong の bucId を null にした (活動 biz_a ではなく業務を指している)");
  });
});

describe("repairModel: 業務の既定の活動", () => {
  const withBusiness = () => okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a" }));
  const defaultsOf = (m: UntieModel, biz: string) =>
    m.elements.filter((e) => e.kind === "buc" && e.isDefault && e.businessId === biz);

  it("既定の活動が無ければ、業務名で作る (id は業務の id から決まる)", () => {
    const m = clone(withBusiness());
    m.elements = m.elements.filter((e) => e.kind !== "buc");
    const r = repairModel(m);
    expect(defaultsOf(r.model, "biz_a")).toEqual([{ id: "buc_biz_a", kind: "buc", name: "業務", businessId: "biz_a", isDefault: true }]);
    expect(repairModel(m).model).toEqual(r.model);
    expectValid(r.model);
  });

  it("複数あれば最初を残し、他の既定の活動の作業は残した方へ付け替えて消す", () => {
    let m = withBusiness();
    const keep = defaultsOf(m, "biz_a")[0].id;
    m = okModel(addElement(m, { kind: "activity", name: "作業", id: "act_a", init: { bucId: keep } }));
    m = clone(m);
    m.elements.push({ id: "buc_second", kind: "buc", name: "業務", businessId: "biz_a", isDefault: true });
    m.elements.push({ id: "act_b", kind: "activity", name: "作業B", bucId: "buc_second" });
    const r = repairModel(m);
    expect(defaultsOf(r.model, "biz_a").map((e) => e.id)).toEqual([keep]);
    const actB = r.model.elements.find((e) => e.id === "act_b");
    expect(actB && actB.kind === "activity" && actB.bucId).toBe(keep);
    expectValid(r.model);
  });

  it("既定の活動の名前を業務名に揃える", () => {
    const m = clone(withBusiness());
    const biz = m.elements.find((e) => e.kind === "business")!;
    biz.name = "改名後";
    const r = repairModel(m);
    expect(defaultsOf(r.model, "biz_a").map((e) => e.name)).toEqual(["改名後"]);
    expectValid(r.model);
  });
});

describe("repairModel: 関係とボードの規則", () => {
  it("自己参照と、両端の種類と合わない kind の関係を消す", () => {
    let m = okModel(addElement(emptyModel(), { kind: "actor", name: "A", id: "actor_a" }));
    m = okModel(addElement(m, { kind: "activity", name: "B", id: "act_b" }));
    m = okModel(addElement(m, { kind: "information", name: "I", id: "info_i" }));
    m = clone(m);
    m.relations.push(
      { id: "rel_self", kind: "actorActivity", sourceId: "actor_a", targetId: "actor_a" },
      { id: "rel_wrong", kind: "usecaseInformation", sourceId: "actor_a", targetId: "act_b" },
      { id: "rel_none", kind: "actorActivity", sourceId: "info_i", targetId: "actor_a" },
      { id: "rel_ok", kind: "actorActivity", sourceId: "actor_a", targetId: "act_b" },
    );
    const r = repairModel(m);
    expect(r.model.relations.map((x) => x.id)).toEqual(["rel_ok"]);
    expect(r.changes.some((c) => c.includes("rel_self") && c.includes("自己参照"))).toBe(true);
    expect(r.changes.some((c) => c.includes("rel_wrong") && c.includes("kind"))).toBe(true);
    expect(r.changes.some((c) => c.includes("rel_none") && c.includes("線で結べない"))).toBe(true);
    expectValid(r.model);
  });

  it("置けない要素 (課題・既定の活動) のノードを消す", () => {
    let m = okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a", boardId: "board_main" }));
    m = okModel(addElement(m, { kind: "issue", name: "課題", id: "issue_a" }));
    m = okModel(addElement(m, { kind: "actor", name: "A", id: "actor_a", boardId: "board_main" }));
    m = clone(m);
    const defaultBuc = m.elements.find((e) => e.kind === "buc")!;
    m.boards[0].nodes.push({ elementId: "issue_a", x: 0, y: 0 }, { elementId: defaultBuc.id, x: 0, y: 0, width: 10, height: 10 });
    const r = repairModel(m);
    expect(r.model.boards[0].nodes.map((n) => n.elementId)).toEqual(["biz_a", "actor_a"]);
    expectValid(r.model);
  });

  it("枠 (業務・活動) のノードに width / height が無ければ既定の大きさを補う", () => {
    let m = okModel(addElement(emptyModel(), { kind: "business", name: "業務", id: "biz_a", boardId: "board_main" }));
    m = okModel(addElement(m, { kind: "buc", name: "活動", id: "buc_a", boardId: "board_main", init: { businessId: "biz_a" } }));
    m = clone(m);
    for (const n of m.boards[0].nodes) {
      if (n.elementId === "biz_a") delete n.width;
      if (n.elementId === "buc_a") delete n.height;
    }
    const r = repairModel(m);
    const node = (id: string) => r.model.boards[0].nodes.find((n) => n.elementId === id)!;
    expect(node("biz_a")).toMatchObject({ width: DEFAULT_FRAME_SIZE.business.width, height: DEFAULT_FRAME_SIZE.business.height });
    expect(node("buc_a")).toMatchObject({ width: DEFAULT_FRAME_SIZE.buc.width, height: DEFAULT_FRAME_SIZE.buc.height });
    expectValid(r.model);
  });
});
