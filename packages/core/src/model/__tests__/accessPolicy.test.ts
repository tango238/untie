import { describe, expect, it } from "vitest";
import { createHotelSample, SAMPLES } from "../../sample";
import { accessPolicyFileName, deriveAccessPolicy, exportAccessPolicy } from "../accessPolicy";
import { usecasePlaces } from "../placement";
import { emptyModel, type Element, type Relation, type UntieModel } from "../types";

function model(elements: Element[], pairs: [Relation["kind"], string, string, Relation["access"]?][]): UntieModel {
  const m = emptyModel();
  m.elements = elements;
  m.relations = pairs.map(([kind, sourceId, targetId, access], i) => ({ id: `rel_${i}`, kind, sourceId, targetId, ...(access ? { access } : {}) }));
  return m;
}

const base: Element[] = [
  { id: "ctx", kind: "context", name: "受付" },
  { id: "clerk", kind: "actor", name: "受付係" },
  { id: "chief", kind: "actor", name: "責任者" },
  { id: "guest", kind: "externalActor", name: "申込者" },
  { id: "sys", kind: "system", name: "受付システム" },
  { id: "other", kind: "system", name: "会計システム" },
  { id: "biz", kind: "business", name: "受付" },
  { id: "buc", kind: "buc", name: "受付", businessId: "biz", isDefault: true },
  { id: "act", kind: "activity", name: "申し込みを受ける", bucId: "buc" },
  { id: "act2", kind: "activity", name: "申し込みを確かめる", bucId: "buc" },
  { id: "uc", kind: "usecase", name: "申し込みを登録する" },
  { id: "uc2", kind: "usecase", name: "申し込みを承認する" },
  { id: "uc3", kind: "usecase", name: "売上を計上する" },
  { id: "info", kind: "information", name: "申し込み", contextId: "ctx" },
  { id: "ev", kind: "event", name: "申し込みが承認された" },
] as Element[];

describe("deriveAccessPolicy: 分析から、役割 × 操作の表を導く", () => {
  it("作業の担当が、その作業の操作を行える役割になる (このシステムの操作だけ)", () => {
    const m = model(base, [
      ["actorActivity", "clerk", "act"],
      ["actorActivity", "chief", "act2"],
      ["actorActivity", "clerk", "act2"],
      ["activityUsecase", "act", "uc"],
      ["activityUsecase", "act2", "uc2"],
      ["activityUsecase", "act2", "uc3"],
      ["usecaseSystem", "uc", "sys"],
      ["usecaseSystem", "uc2", "sys"],
      ["usecaseSystem", "uc3", "other"],
      ["usecaseInformation", "uc", "info", "write"],
      ["usecaseInformation", "uc2", "info"],
    ]);
    const p = deriveAccessPolicy(m, "sys");
    expect(p).toMatchObject({ format: 1, systemId: "sys", system: "受付システム", pending: [] });
    expect(p.roles).toEqual([
      { id: "clerk", name: "受付係" },
      { id: "chief", name: "責任者" },
    ]);
    expect(p.operations).toEqual([
      { id: "uc", name: "申し込みを登録する", allow: [{ role: "clerk" }], byEvent: false, informations: [{ id: "info", name: "申し込み", access: "write" }] },
      { id: "uc2", name: "申し込みを承認する", allow: [{ role: "clerk" }, { role: "chief" }], byEvent: false, informations: [{ id: "info", name: "申し込み", access: "both" }] },
    ]);
  });

  it("社外の人は、自分で行うかが決まっていないので、行える役割に入れず、保留に挙げる", () => {
    const m = model(base, [
      ["actorActivity", "clerk", "act"],
      ["actorActivity", "guest", "act"],
      ["activityUsecase", "act", "uc"],
      ["usecaseSystem", "uc", "sys"],
    ]);
    const p = deriveAccessPolicy(m, "sys");
    expect(p.roles).toEqual([{ id: "clerk", name: "受付係" }]);
    expect(p.operations[0]!.allow).toEqual([{ role: "clerk" }]);
    expect(p.pending).toEqual([{ usecaseId: "uc", operation: "申し込みを登録する", reason: "社外の「申込者」が、自分でこの操作を行うのかが決まっていません (行える役割に入れていません)" }]);
  });

  it("出来事をきっかけにした操作は、担当が無くてもよい。きっかけも担当も無ければ、保留に挙げる", () => {
    const m = model(base, [
      ["eventUsecase", "ev", "uc"],
      ["usecaseSystem", "uc", "sys"],
      ["activityUsecase", "act", "uc2"],
      ["usecaseSystem", "uc2", "sys"],
      ["usecaseSystem", "uc3", "sys"],
    ]);
    const p = deriveAccessPolicy(m, "sys");
    expect(p.operations.map((o) => [o.id, o.allow, o.byEvent])).toEqual([
      ["uc", [], true],
      ["uc2", [], false],
      ["uc3", [], false],
    ]);
    expect(p.roles).toEqual([]);
    expect(p.pending.map((x) => [x.usecaseId, x.reason])).toEqual([
      ["uc2", "作業の担当が決まっていません"],
      ["uc3", "どの作業で行う操作かが決まっていません"],
    ]);
  });

  it("サンプルのどのシステムでも、このシステムの操作がすべて表に載り、行える役割は表の役割にある", () => {
    for (const s of SAMPLES) {
      const m = s.create();
      const places = usecasePlaces(m);
      for (const system of m.elements.filter((e) => e.kind === "system")) {
        const p = deriveAccessPolicy(m, system.id);
        expect(p.operations.map((o) => o.id).sort()).toEqual(m.elements.filter((e) => e.kind === "usecase" && places.get(e.id) === system.id).map((e) => e.id).sort());
        const roles = new Set(p.roles.map((r) => r.id));
        for (const o of p.operations) for (const a of o.allow) expect(roles.has(a.role)).toBe(true);
      }
    }
  });

  it("宿泊サンプルの宿泊管理システム: 役割は社内の 2 人で、宿泊客が関わる 3 つの操作は保留になる", () => {
    const p = deriveAccessPolicy(createHotelSample(), "sys_pms");
    expect(p.roles.map((r) => r.name)).toEqual(["予約担当", "フロント担当"]);
    const allow = Object.fromEntries(p.operations.map((o) => [o.name, o.allow.map((a) => a.role)]));
    expect(allow["予約を確定する"]).toEqual(["actor_reservation"]);
    expect(allow["チェックインを記録する"]).toEqual(["actor_front"]);
    expect(allow["予約を検索する"]).toEqual(["actor_reservation", "actor_front"]);
    expect(allow["請求金額を計算する"]).toEqual([]);
    expect(p.pending.map((x) => x.operation).sort()).toEqual(["チェックインを記録する", "予約を取り消す", "予約を変更する"].sort());
  });
});

describe("exportAccessPolicy: 書き出す", () => {
  it("システムの id から名前を作り、JSON にする", () => {
    expect(accessPolicyFileName("sys_pms")).toBe("sys_pms.access.json");
    const out = exportAccessPolicy(createHotelSample(), "sys_pms");
    expect(out.fileName).toBe("sys_pms.access.json");
    expect(JSON.parse(out.text)).toEqual(out.policy);
  });
});
