import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { addAggregate, addBoundedContext, addDomainCommand, emptyDomain, removeBoundedContext, removeElement, setCandidateExcluded, setDomainTerm, updateAggregate, updateBoundedContext, validateModel } from "@untie/core";
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
});
