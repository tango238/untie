import { describe, expect, it } from "vitest";
import { createAccountingSample, createHotelSample, createNetshopSample, createRetailSample } from "../../sample";
import { removeElement, removeRelation, setRelationAlternate } from "../commands";
import { repairModel } from "../repair";
import { deriveSequences, SEQUENCE_AUTO, sequenceAlternateLines, sequenceCallLabel, sequenceGaps, sequenceToMermaid, type SequenceStep } from "../sequence";
import type { UntieModel } from "../types";
import { validateModel } from "../validate";
import { expectFail, okModel } from "./helpers";

const steps = <T extends SequenceStep["type"]>(list: SequenceStep[], type: T) => list.filter((s): s is Extract<SequenceStep, { type: T }> => s.type === type);
const cond = (m: UntieModel, usecaseId: string, conditionId: string) => m.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === usecaseId && r.targetId === conditionId)!;

describe("deriveSequences: 業務ごとの流れを分析から導く", () => {
  it("業務ごとに、担当 → 操作の対象 (システム・帳票) の順で並べ、設計の対象のシステムが登場する業務に印を付ける", () => {
    const list = deriveSequences(createHotelSample(), "sys_pms");
    expect(list.map((s) => [s.name, s.touchesSystem])).toEqual([
      ["予約受付", true],
      ["チェックイン", true],
      ["滞在中の対応", true],
      ["チェックアウト", true],
      ["清掃・準備", false],
      ["自動の処理 (業務に属さないもの)", true],
    ]);
    const reception = list[0]!;
    // 人が左、システム・帳票が右。設計の対象に印
    expect(reception.participants.map((p) => [p.name, p.kind, p.target])).toEqual([
      ["予約担当", "actor", false],
      ["予約サイト", "system", false],
      ["宿泊管理システム", "system", true],
    ]);
    // 作業の区切り → 操作 → 扱う情報と状態 → 分岐
    expect(steps(reception.steps, "activity").map((s) => s.activity.name)).toEqual(["予約を受け付ける", "予約内容を確認する", "予約を変更・取消する"]);
    const calls = steps(reception.steps, "call");
    expect(calls.map(sequenceCallLabel)).toEqual(["予約を登録する", "予約を検索する [予約の検索画面]", "予約を確定する [予約の確定画面]", "予約を変更する [予約の変更画面]", "予約を取り消す [予約の取消画面]"]);
    const who = (id: string) => reception.participants.find((p) => p.id === id)!.name;
    expect([who(calls[0]!.from), who(calls[0]!.to), calls[0]!.auto]).toEqual(["予約担当", "予約サイト", false]);
    const confirm = steps(reception.steps, "note").find((n) => n.usecase.id === "uc_confirm_reservation")!;
    expect(confirm).toMatchObject({ on: "sys_pms", writes: ["予約"], reads: [], states: "仮予約 → 確定" });
    // 読むだけの情報は「読む」に出す
    expect(steps(reception.steps, "note").find((n) => n.usecase.id === "uc_search_reservation")).toMatchObject({ writes: [], reads: ["予約"] });
    expect(reception.gaps).toEqual([]);
  });

  it("出来事: きっかけにする操作が自動 (人が担当しない) なら続けて書き、人が担当する操作なら、届いたことだけを書く。業務に属さない自動の処理は最後にまとめる", () => {
    const shop = deriveSequences(createNetshopSample(), "sys_oms");
    const order = shop.find((s) => s.name === "受注処理")!;
    // 注文が確定した → 在庫を引き当てる (自動) は、出来事の線がそのまま呼び出しになる
    const allocate = steps(order.steps, "call").find((c) => c.usecase.id === "uc_allocate_stock")!;
    expect(allocate).toMatchObject({ auto: true, from: "sys_oms", to: "sys_oms" });
    expect(sequenceCallLabel(allocate)).toBe("注文が確定した → 在庫を引き当てる (自動)");
    // 受け手の無い出来事は、起きたことだけ
    expect(steps(order.steps, "event").some((e) => e.to === null)).toBe(true);
    // 出荷: 出荷が記録された → 売掛金を登録する (会計システム。自動)
    const shipping = shop.find((s) => s.name === "出荷")!;
    expect(steps(shipping.steps, "call").find((c) => c.usecase.id === "uc_register_receivable")).toMatchObject({ auto: true, from: "sys_oms", to: "sys_accounting" });
    // 宿泊: 時間の出来事 (チェックアウトの日になった) がきっかけの操作は、業務に属さない
    const hotel = deriveSequences(createHotelSample(), "sys_pms");
    const auto = hotel.find((s) => s.id === SEQUENCE_AUTO)!;
    expect(auto.business).toBeNull();
    expect(steps(auto.steps, "call").map(sequenceCallLabel)).toEqual(["チェックアウトの日になった → 請求金額を計算する (自動)"]);
  });

  it("分岐: 操作が判断する条件ごとに 1 つ。代替パターンが決まっていなければ、決めることとして挙げる", () => {
    const m = createHotelSample();
    const reception = deriveSequences(m, "sys_pms")[0]!;
    const alternates = steps(reception.steps, "alternate");
    expect(alternates.map((a) => [a.usecase.name, a.condition.name, a.alternate?.when])).toEqual([
      ["予約を登録する", "満室である", "met"],
      ["予約を取り消す", "取消料が発生する", "met"],
    ]);
    expect(sequenceAlternateLines(alternates[0]!)).toEqual(["［満室である］のとき", "→ 予約を受けず、別の日か別の部屋タイプを案内する。"]);
    // 未定に戻す
    const undecided = okModel(setRelationAlternate(m, { id: cond(m, "uc_cancel_reservation", "cond_cancel_fee").id, alternate: null }));
    const again = deriveSequences(undecided, "sys_pms")[0]!;
    const step = steps(again.steps, "alternate")[1]!;
    expect(step.alternate).toBeNull();
    expect(sequenceAlternateLines(step)).toEqual(["［取消料が発生する］のとき / でないとき", "→ 未定 (どうなるかを決める)"]);
    expect(again.gaps).toEqual([{ type: "alternateUndecided", usecaseId: "uc_cancel_reservation", relationId: step.relationId, message: "操作「予約を取り消す」で、条件「取消料が発生する」のときにどうなるかが決まっていません" }]);
    // 検証には、設計の対象のシステムが登場する業務の分だけ出す
    expect(sequenceGaps(undecided, "sys_pms").map((g) => [g.sequence.name, g.gap.type])).toEqual([["予約受付", "alternateUndecided"]]);
    expect(sequenceGaps(undecided, "sys_accounting")).toEqual([]);
  });

  it("担当の無い作業・対象の無い操作は、仮の縦の線に出して、決めることとして挙げる", () => {
    let m = createHotelSample();
    const actor = m.relations.find((r) => r.kind === "actorActivity" && m.elements.find((e) => e.id === r.targetId)?.name === "予約内容を確認する")!;
    m = okModel(removeRelation(m, { id: actor.id }));
    const screen = m.relations.find((r) => r.kind === "usecaseScreen" && r.sourceId === "uc_confirm_reservation")!;
    m = okModel(removeRelation(m, { id: screen.id }));
    const reception = deriveSequences(m, "sys_pms")[0]!;
    expect(reception.participants.filter((p) => p.kind === "missing").map((p) => p.name)).toEqual(["(担当なし)", "(対象なし)"]);
    expect(reception.gaps.map((g) => g.type).sort()).toEqual(["noActor", "noPlace"]);
  });

  it("サンプル 4 つは、どの業務にも決まっていないことが無い", () => {
    for (const m of [createHotelSample(), createNetshopSample(), createRetailSample(), createAccountingSample()]) {
      expect(validateModel(m)).toMatchObject({ ok: true });
      expect(deriveSequences(m).flatMap((s) => s.gaps.map((g) => `${m.meta.name}: ${g.message}`))).toEqual([]);
    }
  });

  it("Mermaid の sequenceDiagram にできる (分岐は alt)", () => {
    const text = sequenceToMermaid(deriveSequences(createHotelSample(), "sys_pms")[0]!);
    expect(text.startsWith("sequenceDiagram\n  actor p0 as 予約担当\n  participant p1 as 予約サイト\n  participant p2 as 宿泊管理システム\n")).toBe(true);
    expect(text).toContain("  p0->>p1: 予約を登録する\n");
    expect(text).toContain("  alt 満室である (条件を満たすとき)\n    p1-->>p0: 予約を受けず、別の日か別の部屋タイプを案内する。\n  end\n");
    expect(text).toContain("  p0->>p2: 予約を確定する [予約の確定画面]\n  Note right of p2: 書く 予約 / 状態 仮予約 → 確定\n");
  });
});

describe("代替パターン (操作 → 条件 の関係の alternate。0.6.1)", () => {
  it("決める・直す・未定に戻す。条件の関係にだけ付けられ、起きる出来事は分析のイベント", () => {
    let m = createNetshopSample();
    const r = cond(m, "uc_allocate_stock", "cond_out_of_stock");
    expect(r.alternate).toEqual({ when: "met", then: "引き当てずに、入荷を待つ注文として残す。" });
    m = okModel(setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "  引き当てずに待つ  ", eventId: "ev_stock_changed" } }));
    expect(cond(m, "uc_allocate_stock", "cond_out_of_stock").alternate).toEqual({ when: "met", then: "引き当てずに待つ", eventId: "ev_stock_changed" });
    expect(validateModel(m)).toMatchObject({ ok: true });
    // 同じ内容なら何も変えない
    const same = setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "引き当てずに待つ", eventId: "ev_stock_changed" } });
    expect(same.ok && same.model).toBe(m);
    // 出来事を外す
    m = okModel(setRelationAlternate(m, { id: r.id, alternate: { when: "unmet", then: "引き当てずに待つ", eventId: null } }));
    expect(cond(m, "uc_allocate_stock", "cond_out_of_stock").alternate).toEqual({ when: "unmet", then: "引き当てずに待つ" });
    // どうなるかを空にすると、未定に戻る
    m = okModel(setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "  " } }));
    expect("alternate" in cond(m, "uc_allocate_stock", "cond_out_of_stock")).toBe(false);
    // 断るもの
    expect(setRelationAlternate(m, { id: r.id, alternate: { when: "sometimes" as never, then: "x" } }).ok).toBe(false);
    expect(setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "x", eventId: "info_order" } }).ok).toBe(false);
    expect(setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "あ".repeat(5000) } }).ok).toBe(false);
    const other = m.relations.find((x) => x.kind === "usecaseInformation")!;
    expect(setRelationAlternate(m, { id: other.id, alternate: { when: "met", then: "x" } }).ok).toBe(false);
    expect(setRelationAlternate(m, { id: "rel_nope", alternate: null }).ok).toBe(false);
  });

  it("エラー (0.6.2): 入力エラーか、サーバーエラー (HTTP ステータスを持てる)。起きる出来事とは、どちらか一方", () => {
    let m = createNetshopSample();
    const id = cond(m, "uc_allocate_stock", "cond_out_of_stock").id;
    const alt = () => cond(m, "uc_allocate_stock", "cond_out_of_stock").alternate;
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "入力を直してもらう", error: { type: "input" } } }));
    expect(alt()).toEqual({ when: "met", then: "入力を直してもらう", error: { type: "input" } });
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: { type: "server", status: 404 } } }));
    expect(alt()).toEqual({ when: "met", then: "見つからないと伝える", error: { type: "server", status: 404 } });
    expect(validateModel(m)).toMatchObject({ ok: true });
    // 同じ内容なら何も変えない。ステータスを外すと、サーバーエラーだけが残る
    const same = setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: { type: "server", status: 404 } } });
    expect(same.ok && same.model).toBe(m);
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: { type: "server", status: null } } }));
    expect(alt()).toEqual({ when: "met", then: "見つからないと伝える", error: { type: "server" } });
    // 断るもの: 入力エラーに HTTP ステータス・範囲の外や整数でないステータス・知らない種類・出来事との両方
    expectFail(setRelationAlternate(m, { id, alternate: { when: "met", then: "x", error: { type: "input", status: 400 } } }), /サーバーエラーにだけ/);
    for (const status of [200, 600, 404.5, Number.NaN]) expectFail(setRelationAlternate(m, { id, alternate: { when: "met", then: "x", error: { type: "server", status } } }), /400〜599/);
    expectFail(setRelationAlternate(m, { id, alternate: { when: "met", then: "x", error: { type: "other" as never } } }), /エラーの種類/);
    expectFail(setRelationAlternate(m, { id, alternate: { when: "met", then: "x", eventId: "ev_stock_changed", error: { type: "server" } } }), /どちらか一方/);
    // 図の添え書きと Mermaid に、エラーの種類が出る
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: { type: "server", status: 404 } } }));
    const order = deriveSequences(m, "sys_oms").find((s) => s.name === "受注処理")!;
    const step = steps(order.steps, "alternate").find((s) => s.relationId === id)!;
    expect(sequenceAlternateLines(step)[1]).toBe("→ 見つからないと伝える (サーバーエラー 404)");
    expect(sequenceToMermaid(order)).toContain("サーバーエラー 404");
    // エラーを外す
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: null } }));
    expect(alt()).toEqual({ when: "met", then: "見つからないと伝える" });
    // 壊れたもの (出来事とエラーの両方・入力エラーにステータス) は、修復で直す
    const broken = JSON.parse(JSON.stringify(m)) as UntieModel;
    broken.relations.find((x) => x.id === id)!.alternate = { when: "met", then: "x", eventId: "ev_stock_changed", error: { type: "input", status: 400 } };
    expect(validateModel(broken).ok).toBe(false);
    const repaired = repairModel(broken);
    expect(repaired.model.relations.find((x) => x.id === id)!.alternate).toEqual({ when: "met", then: "x", error: { type: "input" } });
    expect(validateModel(repaired.model)).toMatchObject({ ok: true });
  });

  it("起きる出来事を消すと、出来事の参照だけ外れる (どうなるかの文は残る)。壊れたものは修復で直す", () => {
    let m = createNetshopSample();
    const r = cond(m, "uc_allocate_stock", "cond_out_of_stock");
    m = okModel(setRelationAlternate(m, { id: r.id, alternate: { when: "met", then: "待つ", eventId: "ev_stock_changed" } }));
    m = okModel(removeElement(m, { id: "ev_stock_changed" }));
    expect(cond(m, "uc_allocate_stock", "cond_out_of_stock").alternate).toEqual({ when: "met", then: "待つ" });
    expect(validateModel(m)).toMatchObject({ ok: true });
    // 同時編集で残りうる壊れ方: 無い出来事を指す、条件でない関係に付いている
    const broken: UntieModel = {
      ...m,
      relations: m.relations.map((x) => (x.id === r.id ? { ...x, alternate: { when: "met", then: "待つ", eventId: "ev_nope" } } : x.kind === "usecaseNext" ? { ...x, alternate: { when: "met", then: "x" } } : x)),
    };
    expect(validateModel(broken).ok).toBe(false);
    const fixed = repairModel(broken);
    expect(validateModel(fixed.model)).toMatchObject({ ok: true });
    expect(cond(fixed.model, "uc_allocate_stock", "cond_out_of_stock").alternate).toEqual({ when: "met", then: "待つ" });
    expect(fixed.model.relations.some((x) => x.kind === "usecaseNext" && x.alternate !== undefined)).toBe(false);
  });
});
