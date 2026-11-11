import { expect } from "vitest";
import type { CommandResult } from "../commands";
import type { UntieModel } from "../types";
import { createHotelSample } from "../../sample";
import { addAggregate, addBoundedContext, addContextRelation, addDomainCommand, addDomainEvent, addDomainPolicy, setCandidateExcluded, setDomainTerm } from "../domainCommands";

export function sample(): UntieModel {
  return createHotelSample();
}

/** 成功を期待して model を取り出す */
export function okModel<T>(r: CommandResult<T>): UntieModel {
  if (!r.ok) throw new Error(`コマンドが失敗しました: ${r.reason}`);
  return r.model;
}

export function expectFail<T>(r: CommandResult<T>, pattern?: RegExp) {
  expect(r.ok).toBe(false);
  if (!r.ok && pattern) expect(r.reason).toMatch(pattern);
}

/** 古いファイル・同時編集で重なった状態を作る (コマンドは断るので関係を直接足す) */
export function shareScreen(model: UntieModel, usecaseId: string, screenId: string): UntieModel {
  const rels = model.relations.filter((r) => !(r.sourceId === usecaseId && (r.kind === "usecaseSystem" || r.kind === "usecaseScreen")));
  return { ...model, relations: [...rels, { id: `rel_share_${usecaseId}_${screenId}`, kind: "usecaseScreen", sourceId: usecaseId, targetId: screenId } as UntieModel["relations"][number]] };
}

/** 宿泊施設のサンプルに、ひととおりのドメインモデルを足したもの (id は固定) */
export function sampleWithDomain(): UntieModel {
  let m = sample();
  m = okModel(addBoundedContext(m, { id: "bc_res", name: "予約", english: "Reservation", subdomain: "core", team: "予約チーム", contextIds: ["ctx_reservation", "ctx_customer"], systemIds: ["sys_pms"] }));
  m = okModel(addBoundedContext(m, { id: "bc_bill", name: "請求", contextIds: ["ctx_charge"], systemIds: ["sys_pms", "sys_accounting"] }));
  m = okModel(addBoundedContext(m, { id: "bc_pay", name: "決済 (外部)", systemIds: ["sys_payment"] }));
  m = okModel(
    addAggregate(m, {
      id: "ag_res",
      boundedContextId: "bc_res",
      rootInformationId: "info_reservation",
      memberInformationIds: ["info_guest"],
      stateGroup: "予約の状態",
      english: "Reservation",
      invariants: [{ id: "inv_full", text: "満室の日には予約を受けない", conditionId: "cond_full" }, { text: "確定した予約は宿泊客を持つ" }],
    }),
  );
  m = okModel(addAggregate(m, { id: "ag_bill", boundedContextId: "bc_bill", rootInformationId: "info_bill" }));
  m = okModel(addDomainEvent(m, { id: "de_calc", aggregateId: "ag_bill", eventId: "ev_charge_calculated", english: "ChargeCalculated", properties: [{ name: "請求金額", informationId: "info_bill" }] }));
  m = okModel(addDomainEvent(m, { id: "de_paid", boundedContextId: "bc_pay", name: "決済が完了した", english: "PaymentCompleted" }));
  m = okModel(addDomainCommand(m, { id: "cm_register", aggregateId: "ag_res", source: { usecaseId: "uc_register_reservation" }, english: "RegisterReservation" }));
  m = okModel(addDomainCommand(m, { id: "cm_settle", aggregateId: "ag_bill", name: "請求を精算済みにする", emits: ["de_calc"] }));
  m = okModel(addDomainPolicy(m, { id: "po_settle", eventId: "de_paid", commandId: "cm_settle", auto: true }));
  m = okModel(addContextRelation(m, { id: "cr_pay", upstreamId: "bc_pay", downstreamId: "bc_bill", kind: "acl", integration: "messaging", note: "決済サービスの通知を受ける" }));
  m = okModel(setDomainTerm(m, { elementId: "info_reservation", english: "Reservation", definition: "宿泊の申し込み 1 件", boundedContextId: "bc_res" }));
  m = okModel(setDomainTerm(m, { term: "ノーショー", definition: "連絡なしに来なかった予約", boundedContextId: null }));
  m = okModel(setCandidateExcluded(m, { key: "usecase:uc_cancel_reservation", excluded: true }));
  return m;
}
