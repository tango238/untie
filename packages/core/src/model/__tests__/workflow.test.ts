import { describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement, removeRelation } from "../commands";
import {
  addWorkflowElement,
  buildWorkflow,
  canAddActivityToBusiness,
  isWorkflowElement,
  workflowKindLabel,
  impactLines,
  parseSimpleBoardId,
  relationRemovalImpact,
  removalImpact,
  SIMPLE_BOARD_KINDS,
  simpleBoardId,
} from "../workflow";
import type { Activity, Business, UntieModel } from "../types";
import { validateModel } from "../validate";
import { expectFail, okModel, sample } from "./helpers";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const countOf = (items: ReturnType<typeof removalImpact>, label: string) => items.find((i) => i.label === label)?.count ?? 0;

describe("簡易モードのボードの id", () => {
  it("種類と相互に変換でき、ほかのボードの id は読まない", () => {
    for (const k of SIMPLE_BOARD_KINDS) expect(parseSimpleBoardId(simpleBoardId(k))).toBe(k);
    expect(simpleBoardId("workflow")).toBe("simple:workflow");
    expect(parseSimpleBoardId("fixed:activity")).toBeNull();
    expect(parseSimpleBoardId("analysis:people")).toBeNull();
    expect(parseSimpleBoardId("simple:nope")).toBeNull();
  });
});

describe("buildWorkflow", () => {
  it("登場人物ごとの行に、主担当の業務を並べ、業務の中に作業 (直接) と活動 (その作業) を入れる", () => {
    const w = buildWorkflow(sample());
    // 行は登場人物 (アクター・外部アクター) のモデルの順
    expect(ids(w.lanes.map((l) => l.actor))).toEqual(sample().elements.filter((e) => e.kind === "actor" || e.kind === "externalActor").map((e) => e.id));
    const front = w.lanes.find((l) => l.actor.id === "actor_front")!;
    expect(ids(front.businesses.map((b) => b.business))).toEqual(["biz_checkin", "biz_stay", "biz_checkout"]);
    const checkin = front.businesses[0]!;
    expect(ids(checkin.direct).slice(0, 2)).toEqual(["act_confirm_arrival", "act_verify_identity"]);
    expect(ids(checkin.direct)).toContain("act_hand_key");
    expect(checkin.bucs).toEqual([]);
    const stay = front.businesses[1]!;
    expect(stay.direct).toEqual([]);
    expect(ids(stay.bucs.map((b) => b.buc))).toEqual(["buc_room_care", "buc_dining", "buc_extra_charge"]);
    expect(stay.bucs.every((b) => b.activities.length > 0)).toBe(true);
  });

  it("業務を持たない登場人物も行に出る。主担当のいない業務と、業務に属さない作業は別の区画に出て、失われない", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "actor", name: "新入り", id: "actor_new" }));
    m = okModel(addElement(m, { kind: "business", name: "担当なしの業務", id: "biz_free" }));
    m = okModel(addElement(m, { kind: "activity", name: "宙に浮いた作業", id: "act_float" }));
    const w = buildWorkflow(m);
    expect(w.lanes.find((l) => l.actor.id === "actor_new")?.businesses).toEqual([]);
    expect(ids(w.unassigned.map((b) => b.business))).toContain("biz_free");
    expect(ids(w.orphanActivities)).toEqual(["act_float"]);
    // すべての業務・作業が、行・担当なしの区画・孤立の区画のどこかに出る
    const shownBusinesses = new Set([...w.lanes.flatMap((l) => l.businesses), ...w.unassigned].map((b) => b.business.id));
    for (const b of m.elements.filter((e): e is Business => e.kind === "business")) expect(shownBusinesses.has(b.id)).toBe(true);
    const shownActivities = new Set([
      ...[...w.lanes.flatMap((l) => l.businesses), ...w.unassigned].flatMap((b) => [...b.direct, ...b.bucs.flatMap((x) => x.activities)]),
      ...w.orphanActivities,
    ].map((a) => a.id));
    for (const a of m.elements.filter((e): e is Activity => e.kind === "activity")) expect(shownActivities.has(a.id)).toBe(true);
  });

  it("主担当が複数の業務は、それぞれの行に出す (消えない)", () => {
    const m = okModel(addRelation(sample(), { sourceId: "actor_manager", targetId: "biz_checkin" }));
    const w = buildWorkflow(m);
    for (const actorId of ["actor_front", "actor_manager"]) {
      expect(ids(w.lanes.find((l) => l.actor.id === actorId)!.businesses.map((b) => b.business))).toContain("biz_checkin");
    }
    expect(w.lanes.find((l) => l.actor.id === "actor_front")!.businesses.find((b) => b.business.id === "biz_checkin")!.ownerIds).toEqual(["actor_front", "actor_manager"]);
    expect(w.unassigned.map((b) => b.business.id)).not.toContain("biz_checkin");
  });

  it("作業の並びはモデルの順 (固定ボードと同じ)", () => {
    const m = sample();
    const order = m.elements.filter((e) => e.kind === "activity" && e.bucId === "buc_default_reservation").map((e) => e.id);
    const box = buildWorkflow(m).lanes.flatMap((l) => l.businesses).find((b) => b.business.id === "biz_reservation")!;
    expect(ids(box.direct)).toEqual(order);
  });
});

describe("buildWorkflow は検証に通らないモデルでも要素を落とさない", () => {
  it("存在しない活動を指す作業・既定の活動が 2 つある業務の 2 つ目の作業は「業務に属さない作業」に入る", () => {
    const base = sample();
    const twin = { id: "buc_default_twin", kind: "buc", name: "二つ目の既定", businessId: "biz_checkin", isDefault: true } as const;
    const m: UntieModel = {
      ...base,
      elements: [
        ...base.elements,
        twin,
        { id: "act_ghost", kind: "activity", name: "幽霊の作業", bucId: "buc_nothing" },
        { id: "act_twin", kind: "activity", name: "二つ目の既定の作業", bucId: "buc_default_twin" },
      ],
    };
    const w = buildWorkflow(m);
    expect(ids(w.orphanActivities)).toEqual(["act_ghost", "act_twin"]);
    const shown = new Set([...w.lanes.flatMap((l) => l.businesses), ...w.unassigned].flatMap((b) => [...b.direct, ...b.bucs.flatMap((x) => x.activities)]).map((a) => a.id));
    for (const a of m.elements.filter((e) => e.kind === "activity")) expect(shown.has(a.id) || ids(w.orphanActivities).includes(a.id)).toBe(true);
  });
});

describe("isWorkflowElement / workflowKindLabel", () => {
  it("ワークフローの種類は登場人物・業務・既定でない活動・作業だけ", () => {
    const kinds = (id: string) => isWorkflowElement(sample().elements.find((e) => e.id === id)!);
    expect(["actor_front", "ext_guest", "biz_stay", "buc_dining", "act_hand_key"].every(kinds)).toBe(true);
    expect(["buc_default_stay", "sys_pms", "info_reservation"].some(kinds)).toBe(false);
    expect(workflowKindLabel("actor")).toBe("登場人物");
    expect(workflowKindLabel("externalActor")).toBe("外部の登場人物");
    expect(workflowKindLabel("business")).toBe("業務");
  });
});

describe("addWorkflowElement", () => {
  it("登場人物を足す。業務は登場人物の主担当として、活動は業務の中に、作業は業務か活動の中に足す", () => {
    let m = okModel(addWorkflowElement(sample(), "actor"));
    const actor = m.elements.at(-1)!;
    expect(actor.kind).toBe("actor");
    const biz = addWorkflowElement(m, "business", actor.id);
    expect(biz.ok).toBe(true);
    m = okModel(biz);
    const bizId = (biz as { id: string }).id;
    expect(m.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === actor.id && r.targetId === bizId)).toBe(true);
    // 活動の無い業務には作業を直接足せる
    const act = addWorkflowElement(m, "activity", bizId);
    m = okModel(act);
    expect((m.elements.find((e) => e.id === (act as { id: string }).id) as Activity).bucId).toBe(m.elements.find((e) => e.kind === "buc" && e.isDefault && e.businessId === bizId)!.id);
    // 初めて活動を足すと、業務に直接あった作業はその活動に移り、以後は業務に直接足せない
    const buc = addWorkflowElement(m, "buc", bizId);
    m = okModel(buc);
    const bucId = (buc as { id: string }).id;
    expect((m.elements.find((e) => e.id === (act as { id: string }).id) as Activity).bucId).toBe(bucId);
    expect(canAddActivityToBusiness(m, bizId)).toBe(false);
    expectFail(addWorkflowElement(m, "activity", bizId), /活動の中に/);
    const inBuc = addWorkflowElement(m, "activity", bucId);
    expect(inBuc.ok).toBe(true);
    expect(validateModel(okModel(inBuc)).ok).toBe(true);
  });

  it("外部アクターには業務を足せない。足し先が違う・無いときは断る", () => {
    expectFail(addWorkflowElement(sample(), "business", "ext_guest"), /登場人物/);
    expectFail(addWorkflowElement(sample(), "buc", "actor_front"), /業務/);
    expectFail(addWorkflowElement(sample(), "activity", "actor_front"), /業務か活動/);
    expectFail(addWorkflowElement(sample(), "business", "nothing"), /足し先/);
  });
});

describe("削除の影響 (removalImpact) は、removeElement の実際の振る舞いと合っている", () => {
  const m0 = sample();

  it("業務: 活動は一緒に消え、属していた作業は残って業務に属さなくなる", () => {
    const impact = removalImpact(m0, "biz_stay");
    const bucs = m0.elements.filter((e) => e.kind === "buc" && e.businessId === "biz_stay" && !e.isDefault);
    const acts = m0.elements.filter((e) => e.kind === "activity" && bucs.some((b) => b.id === e.bucId));
    expect(countOf(impact, "活動")).toBe(bucs.length);
    expect(impact.find((i) => i.label === "活動")!.effect).toBe("removed");
    expect(countOf(impact, "作業")).toBe(acts.length);
    expect(impact.find((i) => i.label === "作業")!.effect).toBe("kept");
    const after = okModel(removeElement(m0, { id: "biz_stay" }));
    expect(after.elements.some((e) => bucs.some((b) => b.id === e.id))).toBe(false);
    for (const a of acts) expect((after.elements.find((e) => e.id === a.id) as Activity).bucId).toBeNull();
  });

  it("活動: 作業は残って業務に直接属する作業に戻る", () => {
    const impact = removalImpact(m0, "buc_dining");
    const acts = m0.elements.filter((e) => e.kind === "activity" && e.bucId === "buc_dining");
    expect(countOf(impact, "作業")).toBe(acts.length);
    const after = okModel(removeElement(m0, { id: "buc_dining" }));
    for (const a of acts) expect((after.elements.find((e) => e.id === a.id) as Activity).bucId).toBe("buc_default_stay");
  });

  it("登場人物: 業務と作業は残り、結び付きだけが外れる。ほかに主担当がいない業務の数も数える", () => {
    const withShared = okModel(addRelation(m0, { sourceId: "actor_manager", targetId: "biz_checkin" }));
    const impact = removalImpact(withShared, "actor_front");
    expect(countOf(impact, "業務")).toBe(3);
    // チェックインは支配人も主担当なので、ほかに主担当がいないのは 2 件
    expect(impact.find((i) => i.label === "業務")!.note).toContain("2 件");
    expect(countOf(impact, "作業")).toBe(withShared.relations.filter((r) => r.kind === "actorActivity" && r.sourceId === "actor_front").length);
    const after = okModel(removeElement(withShared, { id: "actor_front" }));
    expect(after.elements.filter((e) => e.kind === "business")).toHaveLength(withShared.elements.filter((e) => e.kind === "business").length);
    expect(after.elements.filter((e) => e.kind === "activity")).toHaveLength(withShared.elements.filter((e) => e.kind === "activity").length);
  });

  it("作業: 結んだ操作は残り、結び付きだけが外れる", () => {
    const ucs = m0.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === "act_hand_key");
    const impact = removalImpact(m0, "act_hand_key");
    expect(countOf(impact, "操作")).toBe(ucs.length);
    const after = okModel(removeElement(m0, { id: "act_hand_key" }));
    for (const r of ucs) expect(after.elements.some((e) => e.id === r.targetId)).toBe(true);
  });

  it("活動: ほかの活動が残る業務では、混在になるので移すよう注記する。残らなければ注記なし", () => {
    expect(removalImpact(m0, "buc_dining")[0]!.note).toContain("ほかの活動があるので");
    let m = okModel(removeElement(m0, { id: "buc_room_care" }));
    m = okModel(removeElement(m, { id: "buc_extra_charge" }));
    expect(removalImpact(m, "buc_dining")[0]!.note).toBe("業務に直接属する作業に戻ります");
  });

  it("子が無ければ空。既定の活動・ほかの種類・存在しない id も空", () => {
    let m = okModel(addElement(m0, { kind: "actor", name: "子なし", id: "actor_leaf" }));
    expect(removalImpact(m, "actor_leaf")).toEqual([]);
    m = okModel(addElement(m, { kind: "business", name: "からの業務", id: "biz_leaf" }));
    expect(removalImpact(m, "biz_leaf")).toEqual([]);
    m = okModel(addElement(m, { kind: "activity", name: "子なしの作業", id: "act_leaf" }));
    expect(removalImpact(m, "act_leaf")).toEqual([]);
    expect(removalImpact(m0, "buc_default_stay")).toEqual([]);
    expect(removalImpact(m0, "info_reservation")).toEqual([]);
    expect(removalImpact(m0, "nothing")).toEqual([]);
  });
});

describe("relationRemovalImpact", () => {
  const rel = (m: UntieModel, s: string, t: string) => m.relations.find((r) => r.sourceId === s && r.targetId === t)!;

  it("主担当を外すと、業務の活動・作業は残り、ほかに主担当がいなければ担当なしの区画へ移る", () => {
    const m = sample();
    const impact = relationRemovalImpact(m, rel(m, "actor_front", "biz_stay").id);
    expect(countOf(impact, "活動")).toBe(3);
    expect(impact[0]!.note).toContain("担当が決まっていない業務");
    const after = okModel(removeRelation(m, { id: rel(m, "actor_front", "biz_stay").id }));
    expect(buildWorkflow(after).unassigned.map((b) => b.business.id)).toContain("biz_stay");
    // 活動も作業も失われない
    expect(after.elements).toEqual(m.elements);
  });

  it("ほかの主担当がいれば、その行に残ると書く。子の無い業務・主担当以外の関係は空", () => {
    let m = okModel(addRelation(sample(), { sourceId: "actor_manager", targetId: "biz_stay" }));
    expect(relationRemovalImpact(m, rel(m, "actor_front", "biz_stay").id)[0]!.note).toContain("ほかの主担当");
    m = okModel(addElement(m, { kind: "business", name: "からの業務", id: "biz_leaf" }));
    m = okModel(addRelation(m, { sourceId: "actor_front", targetId: "biz_leaf" }));
    expect(relationRemovalImpact(m, rel(m, "actor_front", "biz_leaf").id)).toEqual([]);
    expect(relationRemovalImpact(m, rel(m, "actor_front", "act_confirm_arrival").id)).toEqual([]);
    expect(relationRemovalImpact(m, "nothing")).toEqual([]);
  });
});

describe("impactLines", () => {
  it("一緒に消えるものと、残るもの (行き先つき) を 1 行ずつの文にする", () => {
    expect(
      impactLines([
        { label: "活動", count: 2, effect: "removed" },
        { label: "作業", count: 5, effect: "kept", note: "業務に属さない作業になります" },
        { label: "操作", count: 1, effect: "kept" },
      ]),
    ).toEqual(["活動 2 件: 一緒に削除されます", "作業 5 件: 削除されず残ります (業務に属さない作業になります)", "操作 1 件: 削除されず残ります"]);
  });
});

describe("簡易モードで足したものも、検証を通る", () => {
  it("登場人物 → 業務 → 作業と足したモデルは、スキーマの検証を通る", () => {
    let m = okModel(addElement(sample(), { kind: "actor", name: "A", id: "a1" }));
    const biz = addWorkflowElement(m, "business", "a1");
    m = okModel(biz);
    m = okModel(addWorkflowElement(m, "activity", (biz as { id: string }).id));
    expect(validateModel(m).ok).toBe(true);
  });
});
