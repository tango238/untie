import { describe, expect, it } from "vitest";
import { SAMPLES, createHotelSample } from "../../sample";
import { ACCEPTANCE_README_FILE, ACCEPTANCE_RUNNER_FILE, acceptanceCasesFileName, deriveAcceptanceCases, exportAcceptanceTests } from "../acceptance";
import { setRelationAlternate } from "../commands";
import type { UntieModel } from "../types";
import { okModel } from "./helpers";

const cond = (m: UntieModel, usecaseId: string, conditionId: string) => m.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === usecaseId && r.targetId === conditionId)!;
const of = (m: UntieModel, operation: string) => deriveAcceptanceCases(m, "sys_pms").cases.filter((c) => c.operation === operation);

describe("deriveAcceptanceCases: 設計から、受け入れテストのケースを導く", () => {
  it("サンプルのケースは、決まった形になる", async () => {
    for (const sample of SAMPLES) {
      const out = exportAcceptanceTests(sample.create());
      for (const f of out.files.filter((x) => x.name.endsWith(".cases.json"))) await expect(f.text).toMatchFileSnapshot(`./__fixtures__/acceptance/${sample.id}/${f.name}`);
    }
  });

  it("ふだんの流れ: 前提の状態から、次の状態になる。複数のグループの状態が変わる操作は、どちらも確かめる", () => {
    const m = createHotelSample();
    expect(of(m, "予約を確定する")[0]).toEqual({
      id: "uc_confirm_reservation#1",
      usecaseId: "uc_confirm_reservation",
      operation: "予約を確定する",
      title: "ふだんの流れ: 仮予約 から",
      kind: "normal",
      given: { states: { 予約の状態: "仮予約" }, conditions: {} },
      expect: { outcome: "done", states: { 予約の状態: "確定" } },
    });
    expect(of(m, "チェックアウトを記録する")[0]!.expect).toEqual({ outcome: "done", states: { 予約の状態: "チェックアウト済", 部屋の状態: "清掃待ち" } });
    // 前提の状態も条件も無い操作は、ケースにしない
    expect(of(m, "予約を検索する")).toEqual([]);
  });

  it("前提の状態が違うとき: 前提でない状態のそれぞれで、行えず、状態は変わらない", () => {
    const wrong = of(createHotelSample(), "予約を確定する").filter((c) => c.kind === "wrongState");
    expect(wrong.map((c) => [c.given.states.予約の状態, c.expect.outcome, c.expect.states.予約の状態])).toEqual([
      ["確定", "wrongState", "確定"],
      ["チェックイン済", "wrongState", "チェックイン済"],
      ["チェックアウト済", "wrongState", "チェックアウト済"],
      ["取消", "wrongState", "取消"],
    ]);
  });

  it("代替パターン: そのあとの状態 (変えない・ふだんと同じ・選んだ状態) と、エラーで、確かめる結果が変わる", () => {
    let m = createHotelSample();
    const alternate = (operation: string) => of(m, operation).find((c) => c.kind === "alternate")!;
    // ふだんと同じ: 取消料を足してから取り消す → 取消になる
    expect(alternate("予約を取り消す")).toMatchObject({
      given: { states: { 予約の状態: "確定" }, conditions: { 取消料が発生する: true } },
      expect: { outcome: "alternate", condition: "取消料が発生する", states: { 予約の状態: "取消" } },
    });
    // ふだんの流れのほうは、条件を満たさない側
    expect(of(m, "予約を取り消す")[0]!.given.conditions).toEqual({ 取消料が発生する: false });
    // 変えない: 早めのチェックインができないとき、確定のまま (満たさないときの分岐なので、ふだんは満たす側)
    expect(alternate("チェックインを記録する")).toMatchObject({
      given: { conditions: { 早めのチェックインができる: false } },
      expect: { outcome: "alternate", condition: "早めのチェックインができる", states: { 予約の状態: "確定" } },
    });
    expect(of(m, "チェックインを記録する")[0]!.given.conditions).toEqual({ 早めのチェックインができる: true });
    // 選んだ状態
    const id = cond(m, "uc_cancel_reservation", "cond_cancel_fee").id;
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "仮予約に戻す", after: { type: "states", stateIds: ["st_res_tentative", "st_room_waiting"] } } }));
    expect(alternate("予約を取り消す").expect).toEqual({ outcome: "alternate", condition: "取消料が発生する", states: { 予約の状態: "仮予約", 部屋の状態: "清掃待ち" } });
    // エラー: 種類と HTTP ステータスを確かめ、状態は変わらない
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "見つからないと伝える", error: { type: "server", status: 404 } } }));
    expect(alternate("予約を取り消す")).toMatchObject({ title: "取消料が発生するとき: 見つからないと伝える (サーバーエラー 404)", expect: { outcome: "error", condition: "取消料が発生する", error: { type: "server", status: 404 }, states: { 予約の状態: "確定" } } });
  });

  it("設計で決まっていないことは、ケースにせず、決まっていないこととして挙げる", () => {
    let m = createHotelSample();
    expect(deriveAcceptanceCases(m, "sys_pms").pending).toEqual([]);
    const id = cond(m, "uc_cancel_reservation", "cond_cancel_fee").id;
    // そのあとの状態が未定
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "取消料を伝える", after: null } }));
    expect(deriveAcceptanceCases(m, "sys_pms").pending).toEqual([{ usecaseId: "uc_cancel_reservation", operation: "予約を取り消す", reason: "条件「取消料が発生する」のときに、そのあとの状態がどうなるかが決まっていません" }]);
    expect(of(m, "予約を取り消す").some((c) => c.kind === "alternate")).toBe(false);
    // どうなるかが未定
    m = okModel(setRelationAlternate(m, { id, alternate: null }));
    expect(deriveAcceptanceCases(m, "sys_pms").pending.map((p) => p.reason)).toEqual(["条件「取消料が発生する」のときにどうなるかが決まっていません"]);
    // 次の状態が同じグループに複数ある (経理のサンプルの、売掛金を消し込む)
    const accounting = SAMPLES.find((s) => s.id === "accounting")!.create();
    const system = accounting.elements.find((e) => e.kind === "system" && e.name === "会計システム")!;
    const suite = deriveAcceptanceCases(accounting, system.id);
    expect(suite.pending.map((p) => [p.operation, p.reason])).toContainEqual(["売掛金を消し込む", "次の状態が、同じ「売掛金の状態」に複数あります (一部入金 か 消込済)。どのときにどれになるかが決まっていません"]);
    // ふだんの流れは書けないが、前提の状態が違うときは確かめられる
    expect(suite.cases.filter((c) => c.operation === "売掛金を消し込む").map((c) => c.kind)).toEqual(["wrongState"]);
  });
});

describe("exportAcceptanceTests: 受け入れテストを書き出す", () => {
  it("システムごとのケースと、テストの本体と、説明を書き出す。数も返す", () => {
    const out = exportAcceptanceTests(createHotelSample());
    expect(out.files.map((f) => f.name)).toEqual([acceptanceCasesFileName("sys_pms"), acceptanceCasesFileName("sys_booking_site"), ACCEPTANCE_RUNNER_FILE, ACCEPTANCE_README_FILE]);
    const suite = JSON.parse(out.files[0]!.text);
    expect(suite).toMatchObject({ format: 1, systemId: "sys_pms", system: "宿泊管理システム", pending: [] });
    expect(out.cases).toBe(out.files.slice(0, 2).reduce((n, f) => n + JSON.parse(f.text).cases.length, 0));
    expect(out.pending).toBe(0);
    // テストの本体は、ドライバーを通してケースを当てる
    expect(out.files[2]!.text).toContain('import driver from "./driver.ts";');
    expect(out.files[2]!.text).toContain("設計で決まっていないことが無い");
  });

  it("操作の無いモデルでは、何も書き出さない", () => {
    const m = createHotelSample();
    expect(exportAcceptanceTests({ ...m, relations: [] })).toEqual({ files: [], cases: 0, pending: 0 });
  });
});
