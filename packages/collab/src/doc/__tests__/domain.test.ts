import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { setRelationAlternate } from "@untie/core";
import { createNetshopSample } from "@untie/core/sample";
import { addAggregate, addBoundedContext, addDomainCommand, addDomainPolicy, adoptCommandCandidate, emptyDomain, updateDomainEvent, removeBoundedContext, removeElement, setCandidateExcluded, setDomainTerm, updateAggregate, updateBoundedContext, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { okModel, sampleWithDomain } from "@untie/core/testing";
import { applyModelDiff, getRoots, loadModel, observeModelChanges, readModel, rebuildModel, repairDoc } from "..";
import { cloneDoc, sync } from "./helpers";

const fresh = (m: UntieModel) => {
  const doc = new Y.Doc();
  loadModel(doc, m);
  return doc;
};

describe("ドメインモデル (0.6.0) の往復", () => {
  it("loadModel → rebuildModel でそのまま戻る。部品は id をキーにした値で、1 つのルートに平らに置く", () => {
    const m = sampleWithDomain();
    const doc = fresh(m);
    expect(rebuildModel(doc)).toStrictEqual(m);
    const root = getRoots(doc).domain;
    expect(root.get("bc_res")).toMatchObject({ part: "context", id: "bc_res", name: "予約" });
    expect(root.get("ag_res")).toMatchObject({ part: "aggregate", boundedContextId: "bc_res" });
    expect(root.get("cm_register")).toMatchObject({ part: "command", aggregateId: "ag_res" });
    expect(root.get("x:usecase:uc_cancel_reservation")).toMatchObject({ part: "excluded", key: "usecase:uc_cancel_reservation" });
    // 入れ子の Y.Map は使わない
    for (const v of root.values()) expect(v instanceof Y.Map).toBe(false);
  });

  it("applyModelDiff は変わった部品だけを書き、並びも保つ", () => {
    const before = sampleWithDomain();
    const doc = fresh(before);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    let after = okModel(updateBoundedContext(before, { id: "bc_bill", patch: { name: "請求・精算", english: "Billing" } }));
    applyModelDiff(doc, before, after, "local");
    expect(updates).toHaveLength(1);
    expect(rebuildModel(doc)).toStrictEqual(after);
    // 足す・消す・外した候補
    const next = okModel(setCandidateExcluded(okModel(addBoundedContext(after, { id: "bc_new", name: "清掃", contextIds: ["ctx_room"] })), { key: "event:ev_checkout_day", excluded: true }));
    applyModelDiff(doc, after, next, "local");
    after = okModel(removeBoundedContext(next, { id: "bc_pay" }));
    applyModelDiff(doc, next, after, "local");
    const rebuilt = rebuildModel(doc);
    expect(rebuilt).toStrictEqual(after);
    expect(rebuilt.domain.contexts.map((c) => c.id)).toEqual(["bc_res", "bc_bill", "bc_new"]);
    expect(rebuilt.domain.excluded).toEqual(["usecase:uc_cancel_reservation", "event:ev_checkout_day"]);
    expect(validateModel(rebuilt)).toMatchObject({ ok: true });
  });

  it("別々の部品を 2 人が同時に直しても両方残る。同じ集約を同時に直すと後勝ちで 1 つになる", () => {
    const base = sampleWithDomain();
    const a = fresh(base);
    const b = cloneDoc(a);
    const byA = okModel(updateAggregate(base, { id: "ag_res", patch: { name: "予約 (A)" } }));
    const byB = okModel(addDomainCommand(base, { id: "cm_b", aggregateId: "ag_bill", name: "請求を取り消す" }));
    applyModelDiff(a, base, byA, "a");
    applyModelDiff(b, base, byB, "b");
    sync(a, b);
    const merged = rebuildModel(a);
    expect(rebuildModel(b)).toStrictEqual(merged);
    expect(merged.domain.aggregates.find((x) => x.id === "ag_res")!.name).toBe("予約 (A)");
    expect(merged.domain.commands.map((c) => c.id)).toContain("cm_b");
    // 同じ集約
    const c = fresh(base);
    const d = cloneDoc(c);
    applyModelDiff(c, base, okModel(updateAggregate(base, { id: "ag_res", patch: { name: "C の名前" } })), "c");
    applyModelDiff(d, base, okModel(updateAggregate(base, { id: "ag_res", patch: { memberInformationIds: [] } })), "d");
    sync(c, d);
    const one = rebuildModel(c).domain.aggregates.find((x) => x.id === "ag_res")!;
    expect(rebuildModel(d).domain.aggregates.find((x) => x.id === "ag_res")).toStrictEqual(one);
    expect([one.name === "C の名前" && one.memberInformationIds.length === 1, one.name === "予約" && one.memberInformationIds.length === 0]).toContain(true);
  });

  it("合流で残った壊れた参照 (消えた情報をルートにする集約) は、表示から外し、サーバーの repairDoc が Y.Doc からも消す", () => {
    const base = sampleWithDomain();
    const a = fresh(base);
    const b = cloneDoc(a);
    // A は情報を消し (集約 ag_bill も一緒に消える)、B は同じ集約にコマンドを足す
    applyModelDiff(a, base, okModel(removeElement(base, { id: "info_bill" })), "a");
    applyModelDiff(b, base, okModel(addDomainCommand(base, { id: "cm_late", aggregateId: "ag_bill", name: "遅れて足したコマンド" })), "b");
    sync(a, b);
    expect(getRoots(a).domain.has("cm_late")).toBe(true);
    const shown = rebuildModel(a);
    expect(shown.domain.commands.map((c) => c.id)).toEqual(["cm_register"]);
    expect(validateModel(shown)).toMatchObject({ ok: true });
    const changes = repairDoc(a, "repair");
    expect(changes.some((c) => c.includes("コマンド cm_late"))).toBe(true);
    expect(getRoots(a).domain.has("cm_late")).toBe(false);
    expect(rebuildModel(a)).toStrictEqual(shown);
  });

  it("形の壊れた部品は読み飛ばし、形の合わない英語名・長すぎる名前は部品を残して直す", () => {
    const m = sampleWithDomain();
    const doc = fresh(m);
    const root = getRoots(doc).domain as Y.Map<unknown>;
    root.set("bc_broken", { part: "context", id: "bc_broken", order: "z" });
    root.set("ag_unknown", { part: "mystery", id: "ag_unknown", order: "z" });
    root.set("x:broken", { part: "excluded", key: "other", order: "z" });
    root.set("bc_res", { ...(root.get("bc_res") as object), english: "予約", name: "あ".repeat(300) });
    const read = readModel(doc);
    expect(read.domain.contexts.map((c) => c.id)).toEqual(["bc_res", "bc_bill", "bc_pay"]);
    expect(read.domain.contexts[0]!.name).toHaveLength(200);
    expect("english" in read.domain.contexts[0]!).toBe(false);
    expect(read.domain.excluded).toEqual(["usecase:uc_cancel_reservation"]);
    expect(validateModel(rebuildModel(doc))).toMatchObject({ ok: true });
  });

  it("prev を渡すと、変わっていない部品は同じ参照を使い回す (ドメインモデルだけが変わっても画面に届く)", () => {
    const base = sampleWithDomain();
    const doc = fresh(base);
    const prev = rebuildModel(doc);
    expect(rebuildModel(doc, prev)).toBe(prev);
    const after = okModel(setDomainTerm(prev, { term: "キャンセル待ち", definition: "空きが出たら案内する予約", boundedContextId: "bc_res" }));
    applyModelDiff(doc, prev, after, "local");
    const next = rebuildModel(doc, prev);
    expect(next).not.toBe(prev);
    expect(next.domain).not.toBe(prev.domain);
    expect(next.domain.contexts).toBe(prev.domain.contexts);
    expect(next.domain.aggregates[0]).toBe(prev.domain.aggregates[0]);
    expect(next.elements).toBe(prev.elements);
    expect(next.domain.terms).toHaveLength(prev.domain.terms.length + 1);
  });

  it("observeModelChanges はドメインモデルの変更を知らせる", () => {
    const base = sampleWithDomain();
    const doc = fresh(base);
    const calls: boolean[] = [];
    observeModelChanges(doc, (c) => calls.push(c.domain));
    applyModelDiff(doc, base, okModel(addAggregate(base, { boundedContextId: "bc_res", rootInformationId: "info_room" })), "local");
    applyModelDiff(doc, base, { ...base, meta: { name: "別の名前" } }, "local");
    expect(calls).toEqual([true, false]);
  });

  it("ドメインモデルが空のモデルも往復する", () => {
    const m = { ...sampleWithDomain(), domain: emptyDomain() };
    expect(rebuildModel(fresh(m))).toStrictEqual(m);
    expect(getRoots(fresh(m)).domain.size).toBe(0);
  });

  it("同じ候補を 2 人が同時に採用したら 1 つにし、消した方を指すポリシーは残した方へ付け替える", () => {
    const base = sampleWithDomain();
    const a = fresh(base);
    const b = cloneDoc(a);
    // A も B も「請求金額を計算する」を採用する。B は、採用したコマンドへのポリシーも足す
    const ra = adoptCommandCandidate(base, { systemId: "sys_pms", key: "uc_calc_charge", patch: { english: "CalculateCharge" } });
    const rb = adoptCommandCandidate(base, { systemId: "sys_pms", key: "uc_calc_charge", patch: { name: "請求を計算する" } });
    if (!ra.ok || !rb.ok) throw new Error("採用に失敗した");
    const byB = okModel(addDomainPolicy(rb.model, { id: "po_b", eventId: "de_paid", commandId: rb.id, auto: true }));
    applyModelDiff(a, base, ra.model, "a");
    applyModelDiff(b, base, byB, "b");
    sync(a, b);
    // 合流した直後は、同じ出どころのコマンドが 2 つある (検証に通らない)。読むときに 1 つにして見せ、repairDoc が Y.Doc も直す
    const shown = rebuildModel(a);
    expect(rebuildModel(b)).toStrictEqual(shown);
    const kept = shown.domain.commands.filter((c) => c.source?.usecaseId === "uc_calc_charge");
    expect(kept).toHaveLength(1);
    expect(shown.domain.policies.find((p) => p.id === "po_b")).toMatchObject({ eventId: "de_paid", commandId: kept[0]!.id });
    expect(validateModel(shown)).toMatchObject({ ok: true });
    expect(repairDoc(a, "repair").length).toBeGreaterThan(0);
    expect(getRoots(a).domain.has(kept[0]!.id === ra.id ? rb.id : ra.id)).toBe(false);
    expect(repairDoc(a, "repair")).toEqual([]);
  });

  it("集約を別のコンテキストへ移すのと、その集約のイベントの編集が重なったら、イベントは集約のコンテキストへ付いていく", () => {
    const base = sampleWithDomain();
    const a = fresh(base);
    const b = cloneDoc(a);
    // A は請求の集約を予約のコンテキストへ移す (イベントも一緒に移る)。B は同じイベントの名前を変える (古いコンテキストのまま書き戻す)
    const byA = okModel(updateAggregate(base, { id: "ag_bill", patch: { boundedContextId: "bc_res" } }));
    const byB = okModel(updateDomainEvent(base, { id: "de_calc", patch: { name: "請求が確定した" } }));
    applyModelDiff(a, base, byA, "a");
    applyModelDiff(b, base, byB, "b");
    sync(a, b);
    const merged = rebuildModel(a);
    expect(rebuildModel(b)).toStrictEqual(merged);
    const event = merged.domain.events.find((e) => e.id === "de_calc")!;
    expect(event).toMatchObject({ aggregateId: "ag_bill", boundedContextId: "bc_res" });
    expect(validateModel(merged)).toMatchObject({ ok: true });
  });
});

describe("代替パターン (関係の alternate。0.6.1) の往復", () => {
  it("サンプルの代替パターンがそのまま戻り、決め直すと関係の値ごと届く。形の合わないものは、決めていないものとして読む", () => {
    const m = createNetshopSample();
    const doc = fresh(m);
    expect(rebuildModel(doc)).toStrictEqual(m);
    const r = m.relations.find((x) => x.kind === "usecaseCondition" && x.alternate)!;
    const next = okModel(setRelationAlternate(m, { id: r.id, alternate: { when: "unmet", then: "受け付けない", eventId: "ev_stock_changed" } }));
    const other = cloneDoc(doc);
    applyModelDiff(doc, m, next, "local");
    sync(doc, other);
    expect(rebuildModel(other).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "受け付けない", eventId: "ev_stock_changed" });
    expect(rebuildModel(other)).toStrictEqual(next);
    // エラーの種類 (0.6.2) も、関係の値ごと届く
    const failing = okModel(setRelationAlternate(next, { id: r.id, alternate: { when: "unmet", then: "見つからないと伝える", error: { type: "server", status: 404 } } }));
    applyModelDiff(doc, next, failing, "local");
    sync(doc, other);
    expect(rebuildModel(other).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "見つからないと伝える", error: { type: "server", status: 404 } });
    expect(rebuildModel(other)).toStrictEqual(failing);
    // 形の合わないエラー (知らない種類・範囲の外のステータス) は読まない
    const relations = getRoots(doc).relations;
    relations.set(r.id, { ...relations.get(r.id)!, alternate: { when: "unmet", then: "x", error: { type: "server", status: 200 } } as never });
    expect(rebuildModel(doc).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "x", error: { type: "server" } });
    relations.set(r.id, { ...relations.get(r.id)!, alternate: { when: "unmet", then: "x", error: { type: "other" } } as never });
    expect(rebuildModel(doc).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "x" });
    applyModelDiff(doc, rebuildModel(doc), failing, "local");
    // そのあとの状態 (0.6.3) も、関係の値ごと届く。形の合わないものは、決めていないものとして読む
    const state = m.elements.find((e) => e.kind === "state")!;
    const moved = okModel(setRelationAlternate(failing, { id: r.id, alternate: { when: "unmet", then: "受け付けない", after: { type: "states", stateIds: [state.id] } } }));
    applyModelDiff(doc, failing, moved, "local");
    sync(doc, other);
    expect(rebuildModel(other).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "受け付けない", after: { type: "states", stateIds: [state.id] } });
    expect(rebuildModel(other)).toStrictEqual(moved);
    relations.set(r.id, { ...relations.get(r.id)!, alternate: { when: "unmet", then: "x", after: { type: "states", stateIds: [] } } as never });
    expect(rebuildModel(doc).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "x" });
    relations.set(r.id, { ...relations.get(r.id)!, alternate: { when: "unmet", then: "x", after: { type: "normal", stateIds: [state.id] } } as never });
    expect(rebuildModel(doc).relations.find((x) => x.id === r.id)!.alternate).toEqual({ when: "unmet", then: "x", after: { type: "normal" } });
    applyModelDiff(doc, rebuildModel(doc), failing, "local");
    // 未定に戻す
    const cleared = okModel(setRelationAlternate(failing, { id: r.id, alternate: null }));
    applyModelDiff(doc, failing, cleared, "local");
    expect("alternate" in rebuildModel(doc).relations.find((x) => x.id === r.id)!).toBe(false);
    // 形の合わない値 (古いクライアントや壊れた書き込み) は読まない
    const root = getRoots(doc).relations;
    root.set(r.id, { ...root.get(r.id)!, alternate: { when: "maybe", then: 1 } as never });
    expect("alternate" in rebuildModel(doc).relations.find((x) => x.id === r.id)!).toBe(false);
    expect(validateModel(rebuildModel(doc))).toMatchObject({ ok: true });
  });
});
