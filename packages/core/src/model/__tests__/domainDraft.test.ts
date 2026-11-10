import { describe, expect, it } from "vitest";
import { createNetshopSample } from "../../sample";
import { checkDomain } from "../domainCheck";
import { applyDomainDraft, draftScopeContextIds, type DomainDraft } from "../domainDraft";
import { resolveDomain } from "../domainResolve";
import { validateModel } from "../validate";
import { sample, sampleWithDomain } from "./helpers";

/** 宿泊管理システムの下書き (予約と請求) */
const draft = (): DomainDraft => ({
  contexts: [
    {
      name: "予約",
      english: "Reservation",
      description: "予約を受けてからチェックアウトまで",
      subdomain: "core",
      contextIds: ["ctx_reservation", "ctx_customer"],
      aggregates: [
        {
          english: "Reservation",
          rootInformationId: "info_reservation",
          memberInformationIds: ["info_guest"],
          stateGroup: "予約の状態",
          invariants: [{ text: "満室の日には予約を受けない", conditionId: "cond_full" }, { text: "" }],
          commands: [
            { usecaseId: "uc_confirm_reservation", english: "ConfirmReservation" },
            { usecaseId: "uc_record_checkout", name: "チェックアウトする", english: "CheckOut", emits: ["GuestCheckedOut"] },
          ],
          events: [{ name: "チェックアウトした", english: "GuestCheckedOut", properties: ["予約番号", ""] }],
        },
      ],
    },
    {
      name: "請求",
      english: "Billing",
      subdomain: "supporting",
      contextIds: ["ctx_charge"],
      aggregates: [
        {
          english: "Bill",
          rootInformationId: "info_bill",
          commands: [
            { usecaseId: "uc_calc_charge", name: "請求を計算する", english: "CalculateCharge", emits: ["ChargeCalculated"] },
            { name: "請求を精算済みにする", english: "SettleBill" },
          ],
          events: [{ eventId: "ev_charge_calculated", english: "ChargeCalculated" }],
        },
      ],
      events: [{ eventId: "ev_checkout_day", english: "CheckoutDayArrived" }],
    },
  ],
  policies: [{ event: "GuestCheckedOut", command: "SettleBill" }],
  relations: [{ upstream: "Reservation", downstream: "Billing", kind: "customerSupplier", integration: "messaging" }],
  terms: [{ elementId: "info_reservation", english: "Reservation", definition: "宿泊の申し込み 1 件" }, { term: "ノーショー", definition: "連絡なしに来なかった予約" }],
  excluded: ["usecase:uc_cancel_reservation"],
});

describe("applyDomainDraft: AI の下書きをドメインモデルへ当てる", () => {
  it("入れ子の下書きを、平らな保存の形にする。名前を省くと分析の名前、英語名でイベントとコマンドをつなぐ", () => {
    const r = applyDomainDraft(sample(), { systemId: "sys_pms", draft: draft() });
    if (!r.ok) throw new Error(r.reason);
    expect(r.summary).toEqual({ replaced: 0, contexts: 2, aggregates: 2, commands: 4, events: 3, policies: 1, relations: 1, terms: 2, excluded: 1 });
    const d = r.model.domain;
    expect(d.contexts.map((c) => [c.name, c.english, c.subdomain, c.systemIds])).toEqual([
      ["予約", "Reservation", "core", ["sys_pms"]],
      ["請求", "Billing", "supporting", ["sys_pms"]],
    ]);
    const res = d.aggregates.find((a) => a.english === "Reservation")!;
    expect(res).toMatchObject({ name: "予約", memberInformationIds: ["info_guest"], stateGroup: "予約の状態" });
    // 空の不変条件は捨てる
    expect(res.invariants.map((i) => [i.text, i.conditionId])).toEqual([["満室の日には予約を受けない", "cond_full"]]);
    const checkout = d.commands.find((c) => c.english === "CheckOut")!;
    const checkedOut = d.events.find((e) => e.english === "GuestCheckedOut")!;
    expect(checkout).toMatchObject({ name: "チェックアウトする", source: { usecaseId: "uc_record_checkout" }, emits: [checkedOut.id] });
    expect(checkedOut).toMatchObject({ aggregateId: res.id, properties: [{ name: "予約番号" }] });
    expect(d.commands.find((c) => c.english === "ConfirmReservation")!.name).toBe("予約を確定する");
    // 集約に属さないイベントは、コンテキストに付く
    const day = d.events.find((e) => e.english === "CheckoutDayArrived")!;
    expect(day).toMatchObject({ eventId: "ev_checkout_day", name: "チェックアウトの日になった", boundedContextId: d.contexts[1]!.id });
    expect("aggregateId" in day).toBe(false);
    const settle = d.commands.find((c) => c.english === "SettleBill")!;
    expect(settle.source).toBeUndefined();
    expect(d.policies).toEqual([{ id: d.policies[0]!.id, eventId: checkedOut.id, commandId: settle.id, auto: true }]);
    expect(d.relations[0]).toMatchObject({ upstreamId: d.contexts[0]!.id, downstreamId: d.contexts[1]!.id, kind: "customerSupplier", integration: "messaging" });
    expect(d.terms.map((t) => [t.term, t.english])).toEqual([["予約", "Reservation"], ["ノーショー", undefined]]);
    expect(d.excluded).toEqual(["usecase:uc_cancel_reservation"]);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
    // 分析は変えない
    expect(r.model.elements).toEqual(sample().elements);
    expect(r.model.relations).toEqual(sample().relations);
    // ボードには、保存したものとして出る
    const resolved = resolveDomain(r.model, "sys_pms");
    expect(resolved.commands.find((c) => c.saved?.english === "CalculateCharge")).toMatchObject({ name: "請求を計算する" });
    expect(checkDomain(r.model).filter((p) => p.level === "error")).toEqual([]);
  });

  it("そのシステムだけが実装するコンテキストを置き換え、ほかのシステムのコンテキストと複数のシステムのコンテキストは残す (英語名で指せる)", () => {
    const m = sampleWithDomain();
    // bc_res は sys_pms だけ。bc_bill は 2 つのシステム、bc_pay は別のシステム
    expect(draftScopeContextIds(m, "sys_pms")).toEqual(["bc_res"]);
    const only: DomainDraft = {
      contexts: [{ name: "予約受付", english: "Booking", contextIds: ["ctx_reservation"], aggregates: [{ english: "Booking", rootInformationId: "info_reservation", commands: [{ name: "予約を取り置く", english: "HoldBooking" }] }] }],
      // 残すコンテキストのイベント (決済が完了した) を、英語名で指す
      policies: [{ event: "PaymentCompleted", command: "HoldBooking", auto: false }],
    };
    const r = applyDomainDraft(m, { systemId: "sys_pms", draft: only });
    if (!r.ok) throw new Error(r.reason);
    expect(r.summary.replaced).toBe(1);
    const d = r.model.domain;
    expect(d.contexts.map((c) => c.id).slice(0, 2)).toEqual(["bc_bill", "bc_pay"]);
    expect(d.contexts.map((c) => c.english)).toEqual([undefined, undefined, "Booking"]);
    // 置き換えた範囲の集約・コマンドは消え、残す範囲のものは残る
    expect(d.aggregates.map((a) => a.id).includes("ag_res")).toBe(false);
    expect(d.aggregates.some((a) => a.id === "ag_bill")).toBe(true);
    expect(d.commands.some((c) => c.id === "cm_settle")).toBe(true);
    expect(d.policies.find((p) => p.eventId === "de_paid" && p.commandId !== "cm_settle")).toMatchObject({ auto: false });
    expect(validateModel(r.model)).toMatchObject({ ok: true });
  });

  it("当てられないところがあれば、何も変えずに、直すところをまとめて返す", () => {
    const m = sample();
    const bad: DomainDraft = {
      contexts: [
        {
          name: "予約",
          english: "予約",
          aggregates: [],
        },
        {
          name: "請求",
          english: "Billing",
          subdomain: "main" as never,
          aggregates: [
            { english: "Bill", rootInformationId: "info_nope" },
            {
              english: "Room",
              rootInformationId: "info_room",
              commands: [{ english: "DoSomething" }, { usecaseId: "uc_assign_room", english: "AssignRoom", emits: ["Nope"] }, { usecaseId: "uc_nope", english: "X1" }],
              events: [{ name: "a", english: "Dup" }, { name: "b", english: "Dup" }],
            },
          ],
        },
      ],
      policies: [{ event: "Nope", command: "AssignRoom" }],
      relations: [{ upstream: "Billing", downstream: "Nowhere", kind: "friend" as never }],
      terms: [{}],
      excluded: ["policy:rel_x", "usecase:uc_nope", "なんでも"],
    };
    const r = applyDomainDraft(m, { systemId: "sys_pms", draft: bad });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const lines = r.reason.split("\n");
    const has = (text: string) => lines.some((l) => l.includes(text));
    expect(has("コンテキスト 予約: 英語名は、英字で始まる")).toBe(true);
    expect(has("サブドメインの分類は core / supporting / generic")).toBe(true);
    expect(has("集約 Bill: ルートの情報が存在しません")).toBe(true);
    expect(has("コマンド DoSomething: 分析の操作 (usecaseId) を指さないコマンドには、名前 (name) が必要です")).toBe(true);
    expect(has("発生させるイベント Nope がありません")).toBe(true);
    expect(has("英語名 Dup が重なっています")).toBe(true);
    expect(has("イベント Nope がありません")).toBe(true);
    expect(has("コンテキスト Nowhere がありません")).toBe(true);
    expect(has("関係の種類 (kind) は")).toBe(true);
    expect(has("分析の要素 (elementId) か語 (term) が必要です")).toBe(true);
    expect(lines.filter((l) => l.startsWith("外す候補")).length).toBe(3);
    // 英語名の無いもの・コンテキストの無い下書き・無いシステムも断る
    expect(applyDomainDraft(m, { systemId: "sys_pms", draft: { contexts: [{ name: "x", english: "" }] } }).ok).toBe(false);
    expect(applyDomainDraft(m, { systemId: "sys_pms", draft: { contexts: [] } }).ok).toBe(false);
    expect(applyDomainDraft(m, { systemId: "nope", draft: draft() }).ok).toBe(false);
  });

  it("サンプル (ネットショップ) の販売管理システムにも当てられ、残すコンテキスト (決済・会計) との関係を英語名で書ける", () => {
    const m = createNetshopSample();
    const r = applyDomainDraft(m, {
      systemId: "sys_oms",
      draft: {
        contexts: [{ name: "販売", english: "Sales", contextIds: ["ctx_order"], aggregates: [{ english: "Order", rootInformationId: "info_order", commands: [{ usecaseId: "uc_confirm_order", english: "ConfirmOrder" }] }] }],
        relations: [{ upstream: "Payment", downstream: "Sales", kind: "acl" }],
      },
    });
    if (!r.ok) throw new Error(r.reason);
    // 受注・在庫・出荷 (販売管理システムだけ) を置き換え、決済・会計は残す
    expect(r.summary.replaced).toBe(3);
    expect(r.model.domain.contexts.map((c) => c.english)).toEqual(["Payment", "Accounting", "Sales"]);
    expect(r.model.domain.relations.map((x) => x.kind)).toEqual(["acl"]);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
  });
});
