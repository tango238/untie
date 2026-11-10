import { describe, expect, it } from "vitest";
import { removeElement, updateElement } from "../commands";
import { domainReferences, inspectDomain, isEmptyDomain, isEnglishName, usedDomainIds } from "../domain";
import {
  addAggregate,
  addBoundedContext,
  addContextRelation,
  addDomainCommand,
  addDomainEvent,
  addDomainPolicy,
  removeAggregate,
  removeBoundedContext,
  removeContextRelation,
  removeDomainCommand,
  removeDomainEvent,
  removeDomainPolicy,
  removeDomainTerm,
  setCandidateExcluded,
  setDomainModel,
  setDomainTerm,
  updateAggregate,
  updateBoundedContext,
  updateContextRelation,
  updateDomainCommand,
  updateDomainEvent,
  updateDomainPolicy,
} from "../domainCommands";
import { repairModel } from "../repair";
import { cleanDomain } from "../truncate";
import { emptyDomain, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { expectFail, okModel, sample, sampleWithDomain } from "./helpers";

const withDomain = sampleWithDomain;

describe("ドメインモデルのコマンド", () => {
  it("ひととおり足せて、検証に通る。名前を省くと、もとの情報・操作・イベントの名前になる", () => {
    const m = withDomain();
    expect(validateModel(m)).toMatchObject({ ok: true });
    const d = m.domain;
    expect(d.contexts.map((c) => c.id)).toEqual(["bc_res", "bc_bill", "bc_pay"]);
    expect(d.aggregates[0]).toMatchObject({ name: "予約", english: "Reservation", stateGroup: "予約の状態", memberInformationIds: ["info_guest"] });
    expect(d.aggregates[0]!.invariants.map((i) => i.text)).toEqual(["満室の日には予約を受けない", "確定した予約は宿泊客を持つ"]);
    expect(d.aggregates[0]!.invariants[1]!.id).toMatch(/^inv_/);
    expect(d.commands[0]).toMatchObject({ name: "予約を登録する", source: { usecaseId: "uc_register_reservation" } });
    expect(d.events[0]).toMatchObject({ name: "請求金額が計算された", boundedContextId: "bc_bill", aggregateId: "ag_bill" });
    expect(d.terms[0]).toMatchObject({ term: "予約", elementId: "info_reservation" });
    expect(d.excluded).toEqual(["usecase:uc_cancel_reservation"]);
    expect(isEmptyDomain(d)).toBe(false);
    expect(isEmptyDomain(emptyDomain())).toBe(true);
    expect(usedDomainIds(d).has("inv_full")).toBe(true);
  });

  it("壊れた参照や重なりを作る入力は断る", () => {
    const m = withDomain();
    expectFail(addBoundedContext(m, { name: "" }), /名前が必要/);
    expectFail(addBoundedContext(m, { name: "x", english: "予約" }), /英語名は/);
    expectFail(addBoundedContext(m, { name: "x", contextIds: ["info_reservation"] }), /分析のコンテキストが存在しません/);
    expectFail(addBoundedContext(m, { name: "x", systemIds: ["nope"] }), /システムが存在しません/);
    expectFail(addBoundedContext(m, { id: "bc_res", name: "x" }), /すでに使われています/);
    expectFail(addAggregate(m, { boundedContextId: "nope", rootInformationId: "info_room" }), /コンテキストが存在しません/);
    expectFail(addAggregate(m, { boundedContextId: "bc_res", rootInformationId: "cond_full" }), /ルートの情報が存在しません/);
    // 同じコンテキストのほかの集約に入っている情報は入れない。別のコンテキストなら入れてよい
    expectFail(addAggregate(m, { boundedContextId: "bc_res", rootInformationId: "info_guest" }), /同じコンテキストの集約「予約」に入っています/);
    expect(addAggregate(m, { boundedContextId: "bc_bill", rootInformationId: "info_guest" }).ok).toBe(true);
    expectFail(updateAggregate(m, { id: "ag_res", patch: { stateGroup: "無い状態" } }), /状態グループが存在しません/);
    expectFail(updateAggregate(m, { id: "ag_res", patch: { invariants: [{ text: "x", conditionId: "nope" }] } }), /条件が存在しません/);
    expectFail(addDomainCommand(m, { aggregateId: "ag_res", source: { usecaseId: "uc_register_reservation" } }), /すでにあります/);
    expectFail(addDomainCommand(m, { aggregateId: "ag_res", name: "x", emits: ["nope"] }), /ドメインイベントが存在しません/);
    expectFail(addDomainCommand(m, { aggregateId: "ag_res" }), /名前が必要/);
    expectFail(addDomainEvent(m, { boundedContextId: "bc_res", aggregateId: "ag_bill", name: "x" }), /同じコンテキストの集約/);
    expectFail(addDomainEvent(m, { boundedContextId: "bc_bill", eventId: "ev_charge_calculated" }), /すでにあります/);
    expectFail(addDomainPolicy(m, { eventId: "de_paid", commandId: "cm_settle" }), /すでにあります/);
    expectFail(addContextRelation(m, { upstreamId: "bc_res", downstreamId: "bc_res", kind: "partnership" }), /同じコンテキストどうし/);
    expectFail(addContextRelation(m, { upstreamId: "bc_pay", downstreamId: "bc_bill", kind: "conformist" }), /同じ向きの関係/);
    expectFail(addContextRelation(m, { upstreamId: "bc_res", downstreamId: "bc_bill", kind: "bogus" as never }), /関係の種類/);
    expectFail(setDomainTerm(m, { definition: "x" }), /用語が必要/);
    expectFail(setDomainTerm(m, { elementId: "nope", definition: "x" }), /要素が存在しません/);
    expectFail(setCandidateExcluded(m, { key: " ", excluded: true }), /キーが正しくありません/);
  });

  it("変えられる。空文字や null で、省略できる項目を消す", () => {
    let m = withDomain();
    m = okModel(updateBoundedContext(m, { id: "bc_res", patch: { name: "予約受付", english: "", subdomain: null, team: null, systemIds: [] } }));
    expect(m.domain.contexts[0]).toEqual({ id: "bc_res", name: "予約受付", contextIds: ["ctx_reservation", "ctx_customer"], systemIds: [] });
    m = okModel(updateAggregate(m, { id: "ag_res", patch: { stateGroup: "", english: null, rootInformationId: "info_guest" } }));
    // ルートを中の情報にしたら、中の情報から外れる
    expect(m.domain.aggregates[0]).toMatchObject({ rootInformationId: "info_guest", memberInformationIds: [] });
    expect("stateGroup" in m.domain.aggregates[0]!).toBe(false);
    expect("english" in m.domain.aggregates[0]!).toBe(false);
    m = okModel(updateDomainCommand(m, { id: "cm_register", patch: { source: null, name: "予約を受ける", emits: ["de_calc"] } }));
    expect(m.domain.commands[0]).toEqual({ id: "cm_register", aggregateId: "ag_res", name: "予約を受ける", english: "RegisterReservation", emits: ["de_calc"] });
    m = okModel(updateDomainEvent(m, { id: "de_calc", patch: { eventId: null, aggregateId: null, properties: [] } }));
    expect(m.domain.events[0]).toEqual({ id: "de_calc", boundedContextId: "bc_bill", name: "請求金額が計算された", english: "ChargeCalculated" });
    m = okModel(updateDomainPolicy(m, { id: "po_settle", auto: false }));
    expect(m.domain.policies[0]!.auto).toBe(false);
    m = okModel(updateContextRelation(m, { id: "cr_pay", patch: { kind: "conformist", integration: null, note: "" } }));
    expect(m.domain.relations[0]).toEqual({ id: "cr_pay", upstreamId: "bc_pay", downstreamId: "bc_bill", kind: "conformist" });
    // 集約を別のコンテキストへ移すと、その集約のイベントも一緒に移る
    let moved = withDomain();
    moved = okModel(updateAggregate(moved, { id: "ag_bill", patch: { boundedContextId: "bc_res" } }));
    expect(moved.domain.events.find((e) => e.id === "de_calc")!.boundedContextId).toBe("bc_res");
    expect(validateModel(moved)).toMatchObject({ ok: true });
  });

  it("要素の用語は、英語も定義も空にすると消える。同じ要素の用語は 1 つ", () => {
    let m = withDomain();
    const before = m.domain.terms.length;
    const again = setDomainTerm(m, { elementId: "info_reservation", definition: "予約 1 件" });
    m = okModel(again);
    expect(m.domain.terms).toHaveLength(before);
    expect(m.domain.terms[0]).toMatchObject({ definition: "予約 1 件", english: "Reservation" });
    m = okModel(setDomainTerm(m, { elementId: "info_reservation", definition: "", english: "" }));
    expect(m.domain.terms.some((t) => t.elementId === "info_reservation")).toBe(false);
    // 無い用語を空で置いても何も足さない
    const none = setDomainTerm(m, { elementId: "info_room", definition: "" });
    expect(none.ok && none.model).toBe(m);
    m = okModel(removeDomainTerm(m, { id: m.domain.terms[0]!.id }));
    expect(m.domain.terms).toEqual([]);
  });

  it("消すと連鎖する: コンテキスト → 集約・イベント・関係 (用語は全体で共通に)、集約 → コマンド → ポリシー、イベント → emits とポリシー", () => {
    let m = withDomain();
    m = okModel(removeDomainEvent(m, { id: "de_calc" }));
    expect(m.domain.commands.find((c) => c.id === "cm_settle")!.emits).toEqual([]);
    m = okModel(removeDomainCommand(m, { id: "cm_settle" }));
    expect(m.domain.policies).toEqual([]);
    m = withDomain();
    m = okModel(removeAggregate(m, { id: "ag_bill" }));
    expect(m.domain.commands.map((c) => c.id)).toEqual(["cm_register"]);
    expect(m.domain.policies).toEqual([]);
    expect("aggregateId" in m.domain.events.find((e) => e.id === "de_calc")!).toBe(false);
    m = withDomain();
    m = okModel(removeBoundedContext(m, { id: "bc_res" }));
    expect(m.domain.aggregates.map((a) => a.id)).toEqual(["ag_bill"]);
    expect(m.domain.commands.map((c) => c.id)).toEqual(["cm_settle"]);
    expect(m.domain.terms.every((t) => t.boundedContextId === null)).toBe(true);
    m = okModel(removeBoundedContext(m, { id: "bc_pay" }));
    expect(m.domain.relations).toEqual([]);
    expect(m.domain.events.map((e) => e.id)).toEqual(["de_calc"]);
    expect(m.domain.policies).toEqual([]);
    expect(validateModel(m)).toMatchObject({ ok: true });
    m = withDomain();
    m = okModel(removeDomainPolicy(m, { id: "po_settle" }));
    m = okModel(removeContextRelation(m, { id: "cr_pay" }));
    m = okModel(setCandidateExcluded(m, { key: "usecase:uc_cancel_reservation", excluded: false }));
    expect([m.domain.policies, m.domain.relations, m.domain.excluded]).toEqual([[], [], []]);
  });

  it("setDomainModel はまるごと置き換え、参照が壊れていれば断る", () => {
    const m = withDomain();
    const target = sample();
    const ok = setDomainModel(target, { domain: m.domain });
    expect(ok.ok && ok.model.domain).toEqual(m.domain);
    const broken = { ...m.domain, aggregates: [{ ...m.domain.aggregates[0]!, rootInformationId: "nope" }] };
    expectFail(setDomainModel(target, { domain: broken }), /ルートの情報 nope が無い/);
  });
});

describe("要素を消したときの掃除と、消える前の要約", () => {
  it("情報を消すと、それをルートにする集約 (とコマンド) が消え、中の情報・属性・用語からは外れる", () => {
    let m = withDomain();
    expect(domainReferences(m, "info_reservation")).toEqual(["集約 (ドメインモデル。コマンドも一緒に消えます) 1", "用語の定義 (ドメインモデル。用語は残ります) 1"]);
    expect(domainReferences(m, "info_guest")).toEqual(["集約の中の情報 1"]);
    m = okModel(removeElement(m, { id: "info_guest" }));
    expect(m.domain.aggregates[0]!.memberInformationIds).toEqual([]);
    m = okModel(removeElement(m, { id: "info_reservation" }));
    expect(m.domain.aggregates.map((a) => a.id)).toEqual(["ag_bill"]);
    expect(m.domain.commands.map((c) => c.id)).toEqual(["cm_settle"]);
    expect("elementId" in m.domain.terms[0]!).toBe(false);
    m = okModel(removeElement(m, { id: "info_bill" }));
    expect(m.domain.aggregates).toEqual([]);
    expect(m.domain.events.find((e) => e.id === "de_calc")).toEqual({ id: "de_calc", boundedContextId: "bc_bill", name: "請求金額が計算された", english: "ChargeCalculated", eventId: "ev_charge_calculated", properties: [{ name: "請求金額" }] });
    expect(validateModel(m)).toMatchObject({ ok: true });
  });

  it("コンテキスト・システム・操作・イベント・条件を消すと、参照だけが外れる (コマンドとイベントはあるべき姿のものとして残る)", () => {
    let m = withDomain();
    expect(domainReferences(m, "ctx_customer")).toEqual(["境界づけられたコンテキストの言語の範囲 1"]);
    expect(domainReferences(m, "sys_pms")).toEqual(["境界づけられたコンテキストの実装先 2"]);
    expect(domainReferences(m, "uc_register_reservation")).toEqual(["コマンドの出どころ (ドメインモデル。コマンドは残ります) 1"]);
    expect(domainReferences(m, "ev_charge_calculated")).toEqual(["ドメインイベントのもとのイベント (ドメインモデル。イベントは残ります) 1"]);
    expect(domainReferences(m, "cond_full")).toEqual(["不変条件のもとの条件 1"]);
    expect(domainReferences(m, "actor_front")).toEqual([]);
    for (const id of ["ctx_customer", "sys_pms", "uc_register_reservation", "ev_charge_calculated", "cond_full"]) m = okModel(removeElement(m, { id }));
    expect(m.domain.contexts.map((c) => [c.contextIds, c.systemIds])).toEqual([[["ctx_reservation"], []], [["ctx_charge"], ["sys_accounting"]], [[], ["sys_payment"]]]);
    expect(m.domain.commands[0]).toEqual({ id: "cm_register", aggregateId: "ag_res", name: "予約を登録する", english: "RegisterReservation", emits: [] });
    expect("eventId" in m.domain.events[0]!).toBe(false);
    expect(m.domain.aggregates[0]!.invariants[0]).toEqual({ id: "inv_full", text: "満室の日には予約を受けない" });
    expect(validateModel(m)).toMatchObject({ ok: true });
  });

  it("状態グループの名前を変えきると集約の状態グループも付いてくる。状態グループが無くなると外れる", () => {
    let m = withDomain();
    const states = m.elements.filter((e) => e.kind === "state" && e.group === "予約の状態");
    for (const s of states) m = okModel(updateElement(m, { id: s.id, patch: { group: "予約のライフサイクル" } }));
    expect(m.domain.aggregates[0]!.stateGroup).toBe("予約のライフサイクル");
    for (const s of states) m = okModel(removeElement(m, { id: s.id }));
    expect("stateGroup" in m.domain.aggregates[0]!).toBe(false);
    expect(validateModel(m)).toMatchObject({ ok: true });
  });
});

describe("inspectDomain と修復", () => {
  it("壊れていなければ同じ参照を返す", () => {
    const m = withDomain();
    const r = inspectDomain(m.domain, m.elements);
    expect(r.problems).toEqual([]);
    expect(r.domain).toBe(m.domain);
    expect(repairModel(m).model).toBe(m);
  });

  it("同時編集で残りうる壊れた参照 (消えた集約のコマンド、重なった採用、別のコンテキストの集約を指すイベント) を直し、知らせには id だけを出す", () => {
    const m = withDomain();
    const d = m.domain;
    const broken: UntieModel = {
      ...m,
      domain: {
        ...d,
        aggregates: d.aggregates.filter((a) => a.id !== "ag_bill"),
        commands: [...d.commands, { id: "cm_dup", aggregateId: "ag_res", name: "予約を登録する (重複)", source: { usecaseId: "uc_register_reservation" }, emits: [] }],
        events: [...d.events, { id: "de_dup", boundedContextId: "bc_bill", name: "x", eventId: "ev_charge_calculated" }, { id: "de_wrong", boundedContextId: "bc_pay", aggregateId: "ag_res", name: "y" }],
        relations: [...d.relations, { id: "cr_self", upstreamId: "bc_res", downstreamId: "bc_res", kind: "partnership" }, { id: "bc_res", upstreamId: "bc_res", downstreamId: "bc_bill", kind: "partnership" }],
        terms: [...d.terms, { id: "tm_x", term: "x", definition: "y", boundedContextId: "bc_nope" }],
        excluded: [...d.excluded, ...d.excluded],
      },
    };
    expect(validateModel(broken).ok).toBe(false);
    const r = repairModel(broken);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
    const fixed = r.model.domain;
    expect(fixed.commands.map((c) => c.id)).toEqual(["cm_register"]);
    expect(fixed.events.map((e) => e.id)).toEqual(["de_calc", "de_paid", "de_wrong"]);
    expect("aggregateId" in fixed.events[0]!).toBe(false);
    expect("aggregateId" in fixed.events[2]!).toBe(false);
    expect(fixed.policies).toEqual([]);
    expect(fixed.relations.map((x) => x.id)).toEqual(["cr_pay"]);
    expect(fixed.terms.find((t) => t.id === "tm_x")!.boundedContextId).toBeNull();
    expect(fixed.excluded).toEqual(["usecase:uc_cancel_reservation"]);
    expect(r.changes.every((c) => c.startsWith("ドメインモデルの"))).toBe(true);
    // 名前などの中身は知らせに出さない
    expect(r.changes.join("\n")).not.toContain("予約を登録する");
  });

  it("長すぎる文字列は切り詰め、形の合わない英語名・分類・統合の方式は部品を残して項目だけ外す", () => {
    const m = withDomain();
    const d = m.domain;
    const dirty = {
      ...d,
      contexts: [{ ...d.contexts[0]!, name: "あ".repeat(250), english: "予約", subdomain: "bogus" as never }, ...d.contexts.slice(1)],
      aggregates: [{ ...d.aggregates[0]!, invariants: [{ id: "inv_full", text: "い".repeat(4100) }] }, d.aggregates[1]!],
      relations: [{ ...d.relations[0]!, integration: "smoke" as never }],
    };
    const r = cleanDomain(dirty);
    expect(r.domain.contexts[0]!.name).toHaveLength(200);
    expect("english" in r.domain.contexts[0]!).toBe(false);
    expect("subdomain" in r.domain.contexts[0]!).toBe(false);
    expect(r.domain.aggregates[0]!.invariants[0]!.text).toHaveLength(4000);
    expect("integration" in r.domain.relations[0]!).toBe(false);
    expect(r.domain.contexts[1]).toBe(d.contexts[1]);
    expect(r.changes).toHaveLength(3);
    expect(cleanDomain(d).domain).toBe(d);
    const repaired = repairModel({ ...m, domain: dirty });
    expect(validateModel(repaired.model)).toMatchObject({ ok: true });
  });

  it("英語名は、英字で始まる英数字とアンダースコアだけ", () => {
    expect(isEnglishName("OrderPlaced")).toBe(true);
    expect(isEnglishName("order_2")).toBe(true);
    expect(isEnglishName("2nd")).toBe(false);
    expect(isEnglishName("Order Placed")).toBe(false);
    expect(isEnglishName("注文")).toBe(false);
    expect(isEnglishName("")).toBe(false);
  });
});
