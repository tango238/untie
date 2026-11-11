import { describe, expect, it } from "vitest";
import { validateModel } from "@untie/core/model/validate";
import type { UntieModel } from "@untie/core/model/types";
import { createNetshopSample } from "@untie/core/sample";
import { sample } from "@untie/core/testing";
import { DOMAIN_TALK_TOOLS, domainForAi, domainTalkOpening, domainTalkSystemPrompt, executeDomainTalkTool } from "../domainTalk";
import type { ModelEditor } from "../tools";

function editorOf(initial: UntieModel): ModelEditor & { model: UntieModel } {
  const e = {
    model: initial,
    getModel: () => e.model,
    apply: ((command: (m: UntieModel) => { ok: boolean; model?: UntieModel }) => {
      const r = command(e.model);
      if (r.ok && r.model) e.model = r.model;
      return r;
    }) as ModelEditor["apply"],
  };
  return e;
}
const parse = (content: string) => JSON.parse(content) as Record<string, unknown>;
const call = (e: ModelEditor, name: string, input: unknown, systemId = "sys_pms") => {
  const r = executeDomainTalkTool(e, systemId, name, input);
  return { ...r, data: parse(r.content) };
};

describe("ドメインモデルの対話の道具", () => {
  it("道具は、モデルとドメインモデルを読むものと、ドメインモデルに書くもの・課題の登録だけ (分析を変える道具は無い)", () => {
    expect(DOMAIN_TALK_TOOLS.map((t) => t.name)).toEqual([
      "get_model",
      "get_domain",
      "save_context",
      "save_aggregate",
      "save_command",
      "save_event",
      "add_policy",
      "set_relation",
      "set_term",
      "exclude_candidate",
      "remove_domain_part",
      "add_issue",
    ]);
    expect(domainTalkSystemPrompt()).toContain("分析 (業務・作業・操作・情報・イベントなど) は変えない");
    expect(domainTalkOpening(sample(), "sys_pms")).toContain("システム「宿泊管理システム」");
  });

  it("get_domain は、保存したものと候補を重ねた一覧・つながり・気づき・まだ決めていないことを返す", () => {
    const data = domainForAi(createNetshopSample(), "sys_oms") as {
      contexts: { id: string; saved: boolean }[];
      commands: { id: string; saved: boolean; usecaseId?: string; excludeKey?: string; toBe?: boolean }[];
      contextFlows: { upstream: string; downstream: string; relation: unknown }[];
      questions: string[];
      undecided: string[];
    };
    expect(data.contexts.find((c) => c.id === "bc_ordering")).toMatchObject({ saved: true, english: "Ordering", subdomain: "core" });
    expect(data.contexts.find((c) => c.id === "ctx_customer")).toMatchObject({ saved: false });
    expect(data.commands.find((c) => c.id === "cm_ship")).toMatchObject({ saved: true, usecaseId: "uc_record_shipment", english: "ShipOrder" });
    expect(data.commands.find((c) => c.id === "uc_record_count")).toMatchObject({ saved: false, excludeKey: "usecase:uc_record_count" });
    expect(data.commands.find((c) => c.id === "cm_mark_paid")).toMatchObject({ toBe: true });
    expect(data.contextFlows.some((f) => f.upstream === "受注" && f.downstream === "在庫" && f.relation)).toBe(true);
    expect(data.questions.length).toBeGreaterThan(0);
    expect(data.undecided).toEqual([]);
  });

  it("候補を採用して決めていく: コンテキスト → 集約と不変条件 → コマンドとイベントの名前 → ポリシー", () => {
    const e = editorOf(sample());
    const before = e.model;
    // 候補の情報を、そのコンテキストのまま集約にする (コンテキストも一緒に保存する)
    const agg = call(e, "save_aggregate", { root_information_id: "info_reservation", english: "Reservation", invariants: [{ text: "満室の日には予約を受けない", condition_id: "cond_full" }] });
    expect(agg.ok && agg.changed).toBe(true);
    const aggregateId = agg.data.id as string;
    const contextId = e.model.domain.aggregates[0]!.boundedContextId;
    expect(e.model.domain.aggregates[0]).toMatchObject({ id: aggregateId, english: "Reservation", stateGroup: "予約の状態" });
    expect(e.model.domain.aggregates[0]!.invariants.map((i) => i.conditionId)).toEqual(["cond_full"]);
    // コンテキストに英語名と分類を付ける
    expect(call(e, "save_context", { id: contextId, english: "Reservation", subdomain: "core", description: "予約を受けてから取り消しまで" }).ok).toBe(true);
    expect(e.model.domain.contexts[0]).toMatchObject({ english: "Reservation", subdomain: "core", systemIds: ["sys_pms"] });
    // 不変条件を置き換えても、同じ文のものは id を引き継ぐ
    const invId = e.model.domain.aggregates[0]!.invariants[0]!.id;
    call(e, "save_aggregate", { id: aggregateId, invariants: [{ text: "満室の日には予約を受けない" }, { text: "確定した予約は宿泊客を持つ" }] });
    expect(e.model.domain.aggregates[0]!.invariants.map((i) => i.id)[0]).toBe(invId);
    expect(e.model.domain.aggregates[0]!.invariants).toHaveLength(2);
    // コマンドの候補に意図の名前と英語名を付ける。あるべき姿のコマンドとイベントを足し、ポリシーでつなぐ
    const cmd = call(e, "save_command", { usecase_id: "uc_record_checkout", name: "チェックアウトする", english: "CheckOut" });
    expect(e.model.domain.commands.find((c) => c.id === cmd.data.id)).toMatchObject({ name: "チェックアウトする", english: "CheckOut", source: { usecaseId: "uc_record_checkout" }, aggregateId });
    const ev = call(e, "save_event", { aggregate_id: aggregateId, name: "チェックアウトした", english: "GuestCheckedOut", properties: ["予約番号"] });
    expect(e.model.domain.events.find((x) => x.id === ev.data.id)).toMatchObject({ aggregateId, properties: [{ name: "予約番号" }] });
    expect(call(e, "save_command", { id: cmd.data.id, emits: [ev.data.id] }).ok).toBe(true);
    const toBe = call(e, "save_command", { aggregate_id: aggregateId, name: "予約を完了にする", english: "CompleteReservation" });
    expect(call(e, "add_policy", { event_id: ev.data.id, command_id: toBe.data.id, auto: false }).ok).toBe(true);
    expect(e.model.domain.policies[0]).toMatchObject({ eventId: ev.data.id, commandId: toBe.data.id, auto: false });
    // 分析のイベントの候補を採用する
    const calc = call(e, "save_event", { event_id: "ev_charge_calculated", english: "ChargeCalculated" });
    expect(e.model.domain.events.find((x) => x.id === calc.data.id)).toMatchObject({ eventId: "ev_charge_calculated", name: "請求金額が計算された" });
    // 分析は変えていない
    expect(e.model.elements).toBe(before.elements);
    expect(e.model.relations).toBe(before.relations);
    expect(validateModel(e.model)).toMatchObject({ ok: true });
  });

  it("関係・用語・候補を外す・消す。分析の誤りは課題として残す", () => {
    const e = editorOf(createNetshopSample());
    // 同じ向きの関係があれば変える。無ければ足す
    expect(call(e, "set_relation", { upstream_id: "bc_ordering", downstream_id: "bc_inventory", kind: "partnership", note: "一緒に計画する" }, "sys_oms").data).toEqual({ id: "cr_ordering_inventory" });
    expect(e.model.domain.relations.find((r) => r.id === "cr_ordering_inventory")).toMatchObject({ kind: "partnership", integration: "messaging", note: "一緒に計画する" });
    const added = call(e, "set_relation", { upstream_id: "bc_inventory", downstream_id: "bc_shipping", kind: "separateWays" }, "sys_oms");
    expect(e.model.domain.relations.find((r) => r.id === added.data.id)).toMatchObject({ kind: "separateWays" });
    // 用語: 要素の用語と、分析に無い語 (同じ語は変える)
    call(e, "set_term", { element_id: "info_return", english: "ReturnRequest", definition: "購入者が商品を返すこと", context_id: "bc_ordering" }, "sys_oms");
    expect(e.model.domain.terms.find((t) => t.elementId === "info_return")).toMatchObject({ term: "返品", english: "ReturnRequest", boundedContextId: "bc_ordering" });
    call(e, "set_term", { term: "引き当て", definition: "取り置くこと" }, "sys_oms");
    expect(e.model.domain.terms.filter((t) => t.term === "引き当て")).toHaveLength(1);
    expect(e.model.domain.terms.find((t) => t.term === "引き当て")!.definition).toBe("取り置くこと");
    // 候補を外す・戻す
    call(e, "exclude_candidate", { key: "usecase:uc_record_count" }, "sys_oms");
    expect(e.model.domain.excluded).toEqual(["usecase:uc_record_count"]);
    call(e, "exclude_candidate", { key: "usecase:uc_record_count", excluded: false }, "sys_oms");
    expect(e.model.domain.excluded).toEqual([]);
    // 保存したものを id で消す。候補は消せない
    expect(call(e, "remove_domain_part", { id: "po_mark_paid" }, "sys_oms").ok).toBe(true);
    expect(e.model.domain.policies).toEqual([]);
    expect(call(e, "remove_domain_part", { id: "cm_mark_paid" }, "sys_oms").ok).toBe(true);
    const none = call(e, "remove_domain_part", { id: "uc_record_count" }, "sys_oms");
    expect(none.ok).toBe(false);
    expect(none.data.error).toContain("exclude_candidate");
    // 課題: 対象は業務・作業・操作など。情報は対象にできない
    const issue = call(e, "add_issue", { name: "入金を記録する操作が、注文の状態を変えている", description: "決済サービスの操作が注文を入金済にしている", target_ids: ["uc_record_payment"] }, "sys_oms");
    expect(e.model.elements.find((x) => x.id === issue.data.id)).toMatchObject({ kind: "issue", targetIds: ["uc_record_payment"] });
    expect(call(e, "add_issue", { name: "x", target_ids: ["info_order"] }, "sys_oms").ok).toBe(false);
    expect(validateModel(e.model)).toMatchObject({ ok: true });
  });

  it("作業ごとのコマンドを足せる。不変条件を置き換えても、もとの条件は引き継ぐ。型の違う入力でも、検証に通らないモデルを作らない", () => {
    const e = editorOf(createNetshopSample());
    // 在庫数を更新する は 3 つの作業が使う。その 1 つの分を、意図の名前で保存する
    const activityId = e.model.relations.find((r) => r.kind === "activityUsecase" && r.targetId === "uc_update_stock")!.sourceId;
    const cmd = call(e, "save_command", { usecase_id: "uc_update_stock", activity_id: activityId, name: "在庫を補充する", english: "RestockItem" }, "sys_oms");
    expect(cmd.ok).toBe(true);
    expect(e.model.domain.commands.find((c) => c.id === cmd.data.id)).toMatchObject({ aggregateId: "ag_stock", name: "在庫を補充する", source: { usecaseId: "uc_update_stock", activityId } });
    // 同じ文の不変条件は、id ともとの条件を引き継ぐ
    const before = e.model.domain.aggregates.find((a) => a.id === "ag_stock")!.invariants[0]!;
    call(e, "save_aggregate", { id: "ag_stock", invariants: [{ text: before.text }, { text: "在庫の数は 0 より小さくならない" }] }, "sys_oms");
    expect(e.model.domain.aggregates.find((a) => a.id === "ag_stock")!.invariants[0]).toEqual(before);
    expect(before.conditionId).toBe("cond_out_of_stock");
    // 型の違う入力・無い要素
    const bad: [string, unknown][] = [
      ["exclude_candidate", { key: "usecase:zz" }],
      ["save_context", { id: "bc_ordering", subdomain: "main" }],
      ["save_context", { id: "bc_ordering", english: "受注" }],
      ["save_context", { id: "bc_ordering", context_ids: ["nope"] }],
      ["set_relation", { upstream_id: "bc_ordering", downstream_id: "bc_inventory", kind: "friend" }],
      ["set_relation", { upstream_id: "bc_ordering", downstream_id: "bc_inventory", kind: "acl", integration: "smoke" }],
      ["save_event", { id: "de_shipped", context_id: "bc_nope" }],
      ["save_command", { id: "cm_ship", emits: ["de_nope"] }],
      ["add_policy", { event_id: "de_nope", command_id: "cm_ship" }],
    ];
    for (const [name, input] of bad) {
      const snapshot = e.model;
      expect(call(e, name, input, "sys_oms").ok, `${name} ${JSON.stringify(input)}`).toBe(false);
      expect(e.model).toBe(snapshot);
    }
    // 数値や文字列でない値は、渡さなかったものとして扱う (何も壊さない)
    call(e, "save_context", { id: "bc_ordering", team: 3, name: 5, context_ids: "x" }, "sys_oms");
    call(e, "add_issue", { name: "x", target_ids: "uc_ship" }, "sys_oms");
    expect(validateModel(e.model)).toMatchObject({ ok: true });
  });

  it("足りない引数・無い id・形の誤りは、理由を返して何も変えない", () => {
    const e = editorOf(sample());
    const before = e.model;
    expect(call(e, "save_context", {}).data.error).toContain("name が必要");
    expect(call(e, "save_aggregate", {}).data.error).toContain("root_information_id が必要");
    expect(call(e, "save_aggregate", { id: "ag_nope", name: "x" }).data.error).toContain("集約が存在しません");
    expect(call(e, "save_command", { name: "x" }).data.error).toContain("aggregate_id と name が必要");
    expect(call(e, "save_event", { name: "x" }).data.error).toContain("aggregate_id か context_id");
    expect(call(e, "add_policy", { event_id: "de_x" }).ok).toBe(false);
    expect(call(e, "set_relation", { upstream_id: "a", downstream_id: "b" }).ok).toBe(false);
    expect(call(e, "set_term", {}).ok).toBe(false);
    expect(call(e, "exclude_candidate", { key: "なんでも" }).ok).toBe(false);
    expect(call(e, "save_context", { name: "予約", english: "予約" }).data.error).toContain("英語名");
    expect(call(e, "add_element", { kind: "usecase", name: "x" }).data.error).toContain("不明な道具");
    expect(e.model).toBe(before);
  });
});
