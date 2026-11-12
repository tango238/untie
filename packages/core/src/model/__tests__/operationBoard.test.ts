import { describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement, removeRelation } from "../commands";
import { addOperationElement, buildOperationBoard, systemsForScreens, whyCannotAddScreen } from "../operationBoard";
import { relationRemovalImpact, removalImpact, SIMPLE_BOARD_KINDS, SIMPLE_BOARD_LABELS, parseSimpleBoardId, simpleBoardId, isSimpleModeLayer, isWorkflowElement } from "../workflow";
import { validateModel } from "../validate";
import type { Activity, UntieModel } from "../types";
import { expectFail, okModel, sample } from "./helpers";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const frame = (m: UntieModel, key: string) => buildOperationBoard(m).frames.find((f) => f.key === key)!;
const opIds = (m: UntieModel, frameKey: string, actId: string) => ids(frame(m, frameKey).rows.find((r) => r.activity.id === actId)!.operations.map((o) => o.usecase));

describe("簡易モードのボード (2 枚)", () => {
  it("ワークフローとシステム。id と相互に変換できる", () => {
    expect(SIMPLE_BOARD_KINDS).toEqual(["workflow", "operation"]);
    expect(SIMPLE_BOARD_LABELS.operation).toBe("システム");
    for (const k of SIMPLE_BOARD_KINDS) expect(parseSimpleBoardId(simpleBoardId(k))).toBe(k);
    expect(simpleBoardId("operation")).toBe("simple:operation");
  });
  it("簡易モードに統合されたレイヤーと、直せる種類 (操作・画面・イベントを含む)", () => {
    for (const l of ["actor", "business", "buc", "activity", "usecase", "screen", "information"] as const) expect(isSimpleModeLayer(l)).toBe(true);
    expect(isSimpleModeLayer("condition")).toBe(false);
    const kinds = (id: string) => isWorkflowElement(sample().elements.find((e) => e.id === id)!);
    expect(["uc_register_reservation", "scr_checkin", "ev_checkout_day", "info_reservation"].every(kinds)).toBe(true);
    expect(["sys_pms", "ldg_guest_register", "ctx_reservation"].some(kinds)).toBe(false);
  });
});

describe("buildOperationBoard", () => {
  it("枠は業務の順に、業務直下の作業の枠 → 活動の枠。活動に作業が無くても枠を出す", () => {
    const keys = buildOperationBoard(sample()).frames.map((f) => f.key);
    expect(keys.slice(0, 2)).toEqual(["biz_reservation", "biz_checkin"]);
    // 滞在中の対応は活動のある業務なので、業務の枠は出さず活動の枠だけ
    expect(keys).toContain("buc_room_care");
    expect(keys).not.toContain("biz_stay");
    const room = frame(sample(), "buc_room_care");
    expect(room.kind).toBe("buc");
    expect(room.business?.id).toBe("biz_stay");
    // 作業の無い活動も出る
    const m = okModel(addElement(sample(), { kind: "buc", name: "からの活動", id: "buc_empty", init: { businessId: "biz_checkout" } }));
    expect(frame(m, "buc_empty").rows).toEqual([]);
  });

  it("作業の行に、使う操作・操作が使う画面・対象のシステム/帳票・きっかけのイベントが入る。1 つの操作が複数の作業に結ばれていれば、それぞれの行に出る", () => {
    const m = sample();
    expect(opIds(m, "biz_reservation", "act_confirm_reservation")).toEqual(["uc_confirm_reservation", "uc_search_reservation"]);
    const box = frame(m, "biz_reservation").rows.find((r) => r.activity.id === "act_confirm_reservation")!.operations[0]!;
    expect(ids(box.screens)).toEqual(["scr_reservation_confirm"]);
    const reg = frame(m, "biz_reservation").rows[0]!.operations[0]!;
    expect(ids(reg.targets)).toEqual(["sys_booking_site"]);
    expect(reg.screens).toEqual([]);
    const ledger = frame(m, "biz_checkin").rows.find((r) => r.activity.id === "act_verify_identity")!.operations[1]!;
    expect(ids(ledger.targets)).toEqual(["ldg_guest_register"]);
    const bill = frame(m, "biz_checkout").rows[0]!.operations[0]!;
    expect(ids(bill.triggers)).toEqual(["ev_charge_calculated"]);
    // uc_search_reservation は 2 つの作業の行に出る
    expect(opIds(m, "biz_checkin", "act_confirm_arrival")).toEqual(["uc_search_reservation"]);
  });

  it("どの作業にも結ばれていない操作・どの操作にも結ばれていない画面・業務に属さない作業は、別に出る。要素は失われない", () => {
    let m = sample();
    expect(ids(buildOperationBoard(m).unlinkedOperations.map((o) => o.usecase))).toEqual(["uc_calc_charge"]);
    m = okModel(addElement(m, { kind: "screen", name: "宙の画面", id: "scr_float", init: { systemId: "sys_pms" } }));
    m = okModel(addElement(m, { kind: "activity", name: "宙の作業", id: "act_float" }));
    // 存在しない活動を指す作業・既定の活動が 2 つある業務の作業も (検証に通らないモデルでも)
    m = { ...m, elements: [...m.elements, { id: "act_ghost", kind: "activity", name: "幽霊", bucId: "buc_nothing" }, { id: "buc_default_twin", kind: "buc", name: "二つ目", businessId: "biz_checkin", isDefault: true }, { id: "act_twin", kind: "activity", name: "二つ目の作業", bucId: "buc_default_twin" }] };
    const b = buildOperationBoard(m);
    expect(ids(b.unlinkedScreens)).toEqual(["scr_float"]);
    const none = b.frames.find((f) => f.kind === "none")!;
    expect(ids(none.rows.map((r) => r.activity))).toEqual(["act_float", "act_ghost", "act_twin"]);
    // すべての作業・操作・画面が、どこかに出る
    const rows = b.frames.flatMap((f) => f.rows);
    for (const a of m.elements.filter((e): e is Activity => e.kind === "activity")) expect(rows.some((r) => r.activity.id === a.id)).toBe(true);
    const shownOps = new Set([...rows.flatMap((r) => r.operations), ...b.unlinkedOperations].map((o) => o.usecase.id));
    for (const u of m.elements.filter((e) => e.kind === "usecase")) expect(shownOps.has(u.id)).toBe(true);
    const shownScreens = new Set([...rows.flatMap((r) => r.operations.flatMap((o) => o.screens)), ...b.unlinkedScreens].map((s) => s.id));
    for (const s of m.elements.filter((e) => e.kind === "screen")) expect(shownScreens.has(s.id)).toBe(true);
  });
});

describe("addOperationElement", () => {
  it("作業に操作を足す (作業が使う操作として結ぶ)。作業以外には足せない", () => {
    const r = addOperationElement(sample(), "usecase", "act_hand_key");
    const m = okModel(r);
    expect(m.relations.some((x) => x.kind === "activityUsecase" && x.sourceId === "act_hand_key" && x.targetId === (r as { id: string }).id)).toBe(true);
    expect(validateModel(m).ok).toBe(true);
    expectFail(addOperationElement(sample(), "usecase", "biz_stay"), /作業の中/);
  });

  it("操作に画面を足す。システムが複数なら選ぶ。1 つだけなら省略できる。対象のある操作・システムの無いモデルには足せない", () => {
    const m0 = okModel(addOperationElement(sample(), "usecase", "act_hand_key"));
    const ucId = m0.elements.filter((e) => e.kind === "usecase").at(-1)!.id;
    expect(systemsForScreens(m0).length).toBeGreaterThan(1);
    expectFail(addOperationElement(m0, "screen", ucId), /システムを選んで/);
    const r = addOperationElement(m0, "screen", ucId, { systemId: "sys_pms" });
    const m = okModel(r);
    const scr = m.elements.find((e) => e.id === (r as { id: string }).id)!;
    expect(scr.kind === "screen" && scr.systemId).toBe("sys_pms");
    expect(m.relations.some((x) => x.kind === "usecaseScreen" && x.sourceId === ucId && x.targetId === scr.id)).toBe(true);
    // すでに画面 (対象) のある操作・システム/帳票が対象の操作には足せない
    expect(whyCannotAddScreen(m, ucId)).toMatch(/対象は 1 つ/);
    expectFail(addOperationElement(m, "screen", ucId, { systemId: "sys_pms" }), /対象は 1 つ/);
    expect(whyCannotAddScreen(sample(), "uc_register_reservation")).toMatch(/対象は 1 つ/);
    // システムが 1 つだけなら省略できる
    let one = m0;
    for (const s of systemsForScreens(m0).slice(1)) one = okModel(removeElement(one, { id: s.id }));
    expect(okModel(addOperationElement(one, "screen", ucId)).elements.some((e) => e.kind === "screen" && e.name === "新しい画面")).toBe(true);
    // システムが 1 つも無ければ足せない
    const none = okModel(removeElement(one, { id: systemsForScreens(one)[0]!.id }));
    expect(whyCannotAddScreen(none, ucId)).toMatch(/システム/);
    expect(validateModel(m).ok).toBe(true);
  });
});

describe("削除の影響 (操作・画面) は removeElement の実際の振る舞いと合っている", () => {
  it("操作: 画面・イベントは消えず、結び付きだけが外れる", () => {
    const m0 = sample();
    const impact = removalImpact(m0, "uc_issue_invoice");
    expect(impact.filter((i) => ["画面", "イベント"].includes(i.label)).map((i) => [i.label, i.count, i.effect])).toEqual([["画面", 1, "kept"], ["イベント", 1, "kept"]]);
    const after = okModel(removeElement(m0, { id: "uc_issue_invoice" }));
    expect(after.elements.some((e) => e.id === "scr_invoice")).toBe(true);
    expect(after.elements.some((e) => e.id === "ev_charge_calculated")).toBe(true);
    expect(after.relations.some((r) => r.sourceId === "uc_issue_invoice" || r.targetId === "uc_issue_invoice")).toBe(false);
    // 画面もイベントも無い操作は子なし
    expect(removalImpact(addNoChild(), "uc_leaf")).toEqual([]);
  });

  it("画面: 使っていた操作は消えず、対象の画面が外れる。結ばれていない画面は子なし", () => {
    const m0 = sample();
    expect(removalImpact(m0, "scr_invoice").map((i) => [i.label, i.count])).toEqual([["操作", 1]]);
    const after = okModel(removeElement(m0, { id: "scr_invoice" }));
    expect(after.elements.some((e) => e.id === "uc_issue_invoice")).toBe(true);
    const lone = okModel(addElement(m0, { kind: "screen", name: "宙", id: "scr_float", init: { systemId: "sys_pms" } }));
    expect(removalImpact(lone, "scr_float")).toEqual([]);
  });

  it("作業と操作の結び付きを外すとき、操作に子 (画面・イベント) があれば数える。ほかの作業にも使われていれば、その行に残ると書く", () => {
    const m0 = sample();
    const rel = (s: string, t: string) => m0.relations.find((r) => r.kind === "activityUsecase" && r.sourceId === s && r.targetId === t)!;
    const only = relationRemovalImpact(m0, rel("act_create_bill", "uc_issue_invoice").id);
    expect(only.map((i) => i.label)).toEqual(["画面", "イベント"]);
    expect(only[0]!.note).toContain("作業に結ばれていない操作");
    const shared = relationRemovalImpact(m0, rel("act_confirm_arrival", "uc_search_reservation").id);
    expect(shared[0]!.note).toContain("ほかの作業の行");
    // 子の無い操作は空
    expect(relationRemovalImpact(m0, rel("act_instruct_cleaning", "uc_update_cleaning").id)).toEqual([]);
    // 実際に外すと、操作は残って「作業に結ばれていない操作」へ移る
    const after = okModel(removeRelation(m0, { id: rel("act_create_bill", "uc_issue_invoice").id }));
    expect(ids(buildOperationBoard(after).unlinkedOperations.map((o) => o.usecase))).toContain("uc_issue_invoice");
  });

  it("作業を消すと、操作は残り作業との結び付きが外れる (今の文言どおり)", () => {
    const impact = removalImpact(sample(), "act_create_bill");
    expect(impact.find((i) => i.label === "操作")!.note).toBe("作業との結び付きが外れます");
  });
});

function addNoChild(): UntieModel {
  const m = okModel(addElement(sample(), { kind: "usecase", name: "葉", id: "uc_leaf" }));
  return okModel(addRelation(m, { sourceId: "act_hand_key", targetId: "uc_leaf" }));
}

describe("ボードに見えない結び付きの数え上げ (removeElement の実際の振る舞いと突き合わせる)", () => {
  const removedRelations = (m: UntieModel, id: string) => {
    const after = okModel(removeElement(m, { id }));
    const gone = m.relations.filter((r) => !after.relations.some((x) => x.id === r.id));
    return { after, gone };
  };
  const count = (items: ReturnType<typeof removalImpact>, label: string) => items.find((i) => i.label === label)?.count ?? 0;

  it("イベント: 結ばれた操作・作業の起点・システム・代替パターンの参照を数える。相手の要素は消えない", () => {
    let m = sample();
    // 作業の起点 (eventActivity) と、代替パターンのイベント参照を足す
    const added = addRelation(m, { sourceId: "ev_checkout_day", targetId: "act_create_bill" });
    if (added.ok) m = added.model;
    const cond = m.relations.find((r) => r.kind === "usecaseCondition")!;
    m = { ...m, relations: m.relations.map((r) => (r.id === cond.id ? { ...r, alternate: { when: "unmet" as const, then: "別の流れ", eventId: "ev_checkout_day" } } : r)) };
    const impact = removalImpact(m, "ev_checkout_day");
    const { after, gone } = removedRelations(m, "ev_checkout_day");
    expect(count(impact, "操作")).toBe(gone.filter((r) => r.kind === "eventUsecase" || r.kind === "usecaseEvent").length);
    expect(count(impact, "作業")).toBe(gone.filter((r) => r.kind === "eventActivity").length);
    expect(count(impact, "システム")).toBe(gone.filter((r) => r.kind === "systemEvent").length);
    expect(count(impact, "代替パターン")).toBe(1);
    expect(count(impact, "操作") + count(impact, "作業") + count(impact, "システム")).toBe(gone.length);
    expect(count(impact, "操作")).toBeGreaterThan(0);
    expect(count(impact, "システム")).toBeGreaterThan(0);
    // 相手の要素は残り、代替パターンの文は残る
    for (const id of ["uc_calc_charge", "act_create_bill", "sys_pms"]) expect(after.elements.some((e) => e.id === id)).toBe(true);
    expect(after.relations.find((r) => r.id === cond.id)?.alternate?.then).toBe("別の流れ");
    // 何も結ばれていないイベントは空
    const lone = okModel(addElement(sample(), { kind: "event", name: "孤立", id: "ev_lone" }));
    expect(removalImpact(lone, "ev_lone")).toEqual([]);
  });

  it("操作: 扱う情報・判断する条件 (代替パターンの件数つき)・状態・「次に」を数える", () => {
    const m = sample();
    const impact = removalImpact(m, "uc_register_reservation");
    const { gone } = removedRelations(m, "uc_register_reservation");
    const n = (...kinds: string[]) => gone.filter((r) => kinds.includes(r.kind)).length;
    expect(count(impact, "扱う情報")).toBe(n("usecaseInformation"));
    expect(count(impact, "判断する条件")).toBe(n("usecaseCondition"));
    expect(count(impact, "状態")).toBe(n("usecaseState", "stateUsecase"));
    expect(count(impact, "前後の操作")).toBe(n("usecaseNext"));
    expect(count(impact, "扱う情報")).toBeGreaterThan(0);
    expect(count(impact, "判断する条件")).toBeGreaterThan(0);
    expect(count(impact, "状態")).toBeGreaterThan(0);
    // 代替パターンのある条件の件数が note に出る
    const withAlt = gone.filter((r) => r.kind === "usecaseCondition" && r.alternate !== undefined).length;
    const note = impact.find((i) => i.label === "判断する条件")!.note!;
    expect(note.includes("代替パターン")).toBe(withAlt > 0);
    if (withAlt > 0) expect(note).toContain(`${withAlt} 件`);
  });

  it("作業: この作業を起点にしている作業だけを数える (向きに注意)。自分の起点は数えない。removeElement の結果と一致", () => {
    let m = sample();
    // act_accept_reservation を起点にする作業を 2 つ (act_confirm_reservation, act_change_cancel)。自分の起点も足す
    for (const [source, target] of [["act_accept_reservation", "act_confirm_reservation"], ["act_accept_reservation", "act_change_cancel"], ["act_hand_key", "act_accept_reservation"]] as const) {
      const r = addRelation(m, { sourceId: source, targetId: target });
      if (r.ok) m = r.model;
    }
    const started = new Set(m.relations.filter((r) => r.kind === "activityTrigger" && r.sourceId === "act_accept_reservation").map((r) => r.targetId));
    const impact = removalImpact(m, "act_accept_reservation");
    expect(count(impact, "この作業を起点にしている作業")).toBe(started.size);
    expect(started.size).toBeGreaterThanOrEqual(2);
    // 実際に消すと、起点にされていた作業の起点の関係が減る (自分の起点の関係も消えるが、影響を受ける作業ではない)
    const after = okModel(removeElement(m, { id: "act_accept_reservation" }));
    for (const id of started) {
      const before = m.relations.filter((r) => r.kind === "activityTrigger" && r.targetId === id).length;
      expect(after.relations.filter((r) => r.kind === "activityTrigger" && r.targetId === id).length).toBe(before - 1);
    }
    // 自分の起点だけがある作業は、起点にしている作業が無いので空
    const base = sample();
    const sources = new Set(base.relations.filter((r) => r.kind === "activityTrigger").map((r) => r.sourceId));
    const leaf = base.elements.find((e) => e.kind === "activity" && !sources.has(e.id) && e.id !== "act_hand_key")!;
    const lone = okModel(addRelation(base, { sourceId: "act_hand_key", targetId: leaf.id }));
    expect(count(removalImpact(lone, leaf.id), "この作業を起点にしている作業")).toBe(0);
  });

  it("イベント: 同じ操作が同じイベントをきっかけにも発生にもしていても、操作は 1 件と数える", () => {
    let m = sample();
    for (const r of [{ sourceId: "ev_charge_calculated", targetId: "uc_calc_charge" }, { sourceId: "uc_calc_charge", targetId: "ev_charge_calculated" }]) {
      const added = addRelation(m, r);
      if (added.ok) m = added.model;
    }
    const both = m.relations.filter((r) => (r.kind === "eventUsecase" || r.kind === "usecaseEvent") && (r.sourceId === "uc_calc_charge" || r.targetId === "uc_calc_charge") && (r.sourceId === "ev_charge_calculated" || r.targetId === "ev_charge_calculated"));
    expect(both).toHaveLength(2);
    const ops = new Set(m.relations.filter((r) => r.kind === "eventUsecase" || r.kind === "usecaseEvent").filter((r) => r.sourceId === "ev_charge_calculated" || r.targetId === "ev_charge_calculated").map((r) => (r.sourceId === "ev_charge_calculated" ? r.targetId : r.sourceId)));
    expect(count(removalImpact(m, "ev_charge_calculated"), "操作")).toBe(ops.size);
    expect(ops.size).toBeLessThan(m.relations.filter((r) => (r.kind === "eventUsecase" || r.kind === "usecaseEvent") && (r.sourceId === "ev_charge_calculated" || r.targetId === "ev_charge_calculated")).length);
  });

  it("登場人物の求める非機能要件を数える。removeElement で消える関係と一致", () => {
    let m = sample();
    const nfr = okModel(addElement(m, { kind: "nfr", name: "速く応答する", id: "nfr_fast", init: { systemId: "sys_pms" } }));
    m = okModel(addRelation(nfr, { sourceId: "actor_front", targetId: "nfr_fast" }));
    const gone = m.relations.filter((r) => r.kind === "actorNfr" && r.sourceId === "actor_front");
    expect(count(removalImpact(m, "actor_front"), "非機能要件")).toBe(gone.length);
    const after = okModel(removeElement(m, { id: "actor_front" }));
    expect(after.relations.filter((r) => r.kind === "actorNfr")).toHaveLength(m.relations.filter((r) => r.kind === "actorNfr").length - gone.length);
    expect(after.elements.some((e) => e.id === "nfr_fast")).toBe(true);
  });

  it("課題の対象: 課題になれる種類 (登場人物・業務・作業・操作・画面) は、課題の件数を数える。課題は残り、対象から外れる", () => {
    const m = sample();
    const issue = m.elements.find((e) => e.kind === "issue")!;
    for (const kind of ["actor", "externalActor", "business", "activity", "usecase", "screen"] as const) {
      const target = m.elements.find((e) => e.kind === kind)!;
      const withIssue = { ...m, elements: m.elements.map((e) => (e.id === issue.id ? { ...e, targetIds: [target.id] } : e)) } as UntieModel;
      expect(count(removalImpact(withIssue, target.id), "課題")).toBe(1);
      const after = okModel(removeElement(withIssue, { id: target.id }));
      expect(after.elements.some((e) => e.id === issue.id)).toBe(true);
      expect((after.elements.find((e) => e.id === issue.id) as { targetIds: string[] }).targetIds).not.toContain(target.id);
    }
    // 課題の対象にならない種類 (情報・イベント) は課題を数えない
    for (const id of ["info_reservation", "ev_checkout_day"]) expect(count(removalImpact(m, id), "課題")).toBe(0);
    // 画面: 課題の無い画面は、使っていた操作だけ
    expect(removalImpact(sample(), "scr_invoice").map((i) => i.label)).toEqual(["操作"]);
  });

  it("操作と条件の結び付きを外すと、関係が持つ代替パターンが一緒に消える。代替パターンの無い関係・ほかの関係 (access つきの情報など) は確認しない", () => {
    const m = sample();
    const alt = m.relations.find((r) => r.kind === "usecaseCondition" && r.alternate !== undefined)!;
    expect(relationRemovalImpact(m, alt.id)).toEqual([{ label: "代替パターン", count: 1, effect: "removed" }]);
    expect(okModel(removeRelation(m, { id: alt.id })).relations.some((r) => r.id === alt.id)).toBe(false);
    const plain = m.relations.find((r) => r.kind === "usecaseCondition" && r.alternate === undefined);
    if (plain) expect(relationRemovalImpact(m, plain.id)).toEqual([]);
    const withAccess = m.relations.find((r) => r.kind === "usecaseInformation" && r.access !== undefined)!;
    expect(relationRemovalImpact(m, withAccess.id)).toEqual([]);
  });
});

describe("システムボードの情報", () => {
  it("操作が扱う情報を、access つきで操作の枠に並べる。同じ情報が複数の操作で扱われていれば、それぞれに出る", () => {
    const m = sample();
    const reg = frame(m, "biz_reservation").rows[0]!.operations[0]!;
    const expected = m.relations.filter((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_register_reservation");
    expect(reg.informations.map((x) => x.information.id)).toEqual(expected.map((r) => r.targetId));
    expect(reg.informations.map((x) => x.access)).toEqual(expected.map((r) => r.access));
    const owners = (infoId: string) => buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations)).filter((o) => o.informations.some((x) => x.information.id === infoId)).length;
    const sharedInfo = m.elements.filter((e) => e.kind === "information").find((i) => m.relations.filter((r) => r.kind === "usecaseInformation" && r.targetId === i.id).length > 1)!;
    expect(owners(sharedInfo.id)).toBeGreaterThan(1);
  });

  it("どの操作にも扱われていない情報は「操作に結ばれていない情報」に出る。検証に通らない関係 (存在しない操作から) でも情報は消えない", () => {
    let m = okModel(addElement(sample(), { kind: "information", name: "宙の情報", id: "info_float" }));
    m = { ...m, relations: [...m.relations, { id: "rel_ghost", kind: "usecaseInformation", sourceId: "uc_nothing", targetId: "info_ghost" } as never], elements: [...m.elements, { id: "info_ghost", kind: "information", name: "幽霊の情報", contextId: null }] };
    const b = buildOperationBoard(m);
    expect(ids(b.unlinkedInformations)).toEqual(expect.arrayContaining(["info_float", "info_ghost"]));
    const shown = new Set([...b.frames.flatMap((f) => f.rows.flatMap((r) => r.operations.flatMap((o) => o.informations.map((x) => x.information)))), ...b.unlinkedOperations.flatMap((o) => o.informations.map((x) => x.information)), ...b.unlinkedInformations].map((i) => i.id));
    for (const i of m.elements.filter((e) => e.kind === "information")) expect(shown.has(i.id)).toBe(true);
  });

  it("操作に情報を足す (扱う情報として結ぶ。access は省略 = 両方)。操作以外には足せない", () => {
    const r = addOperationElement(sample(), "information", "uc_register_reservation");
    const m = okModel(r);
    const rel = m.relations.find((x) => x.kind === "usecaseInformation" && x.targetId === (r as { id: string }).id)!;
    expect(rel.sourceId).toBe("uc_register_reservation");
    expect(rel.access).toBeUndefined();
    expect(validateModel(m).ok).toBe(true);
    expectFail(addOperationElement(sample(), "information", "act_hand_key"), /操作の中/);
  });

  it("情報の削除の影響: 扱っていた操作・関連する情報・バリエーションが外れる (removeElement の結果と一致)。結ばれていなければ空", () => {
    const m = sample();
    const infoId = m.elements.find((e) => e.kind === "information" && m.relations.some((r) => r.kind === "informationVariation" && r.sourceId === e.id) && m.relations.some((r) => r.kind === "usecaseInformation" && r.targetId === e.id))!.id;
    const impact = removalImpact(m, infoId);
    const after = okModel(removeElement(m, { id: infoId }));
    const gone = m.relations.filter((r) => !after.relations.some((x) => x.id === r.id));
    const n = (...k: string[]) => gone.filter((r) => k.includes(r.kind)).length;
    const c = (label: string) => impact.find((i) => i.label === label)?.count ?? 0;
    expect(c("操作")).toBe(n("usecaseInformation"));
    expect(c("関連する情報")).toBe(n("informationRelated"));
    expect(c("バリエーション")).toBe(n("informationVariation"));
    expect(c("操作") + c("関連する情報") + c("バリエーション")).toBe(gone.length);
    expect(removalImpact(okModel(addElement(m, { kind: "information", name: "孤立", id: "info_lone" })), "info_lone")).toEqual([]);
  });

  it("操作と情報の結び付きを外しても、情報は子を持たないので確認は要らない", () => {
    const m = sample();
    const rel = m.relations.find((r) => r.kind === "usecaseInformation")!;
    expect(relationRemovalImpact(m, rel.id)).toEqual([]);
  });
});
