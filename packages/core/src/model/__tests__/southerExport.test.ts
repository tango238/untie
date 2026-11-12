import { describe, expect, it } from "vitest";
import { SAMPLES } from "../../sample";
import { createHotelSample } from "../../sample";
import { removeRelation, setRelationAlternate } from "../commands";
import { exportSouther, exportSoutherAll, southerIdentifier } from "../southerExport";
import type { UntieModel } from "../types";
import { okModel } from "./helpers";

const cond = (m: UntieModel, usecaseId: string, conditionId: string) => m.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === usecaseId && r.targetId === conditionId)!;

describe("southerIdentifier: 名前を Souther の識別子にする", () => {
  it("日本語はそのまま。記号・空白は _ に、予約語と標準ライブラリの名前は避け、数字で始めない", () => {
    expect(southerIdentifier("予約を確定する")).toBe("予約を確定する");
    expect(southerIdentifier("損益計算書 (PL)")).toBe("損益計算書_PL");
    expect(southerIdentifier("値引き・廃棄")).toBe("値引き_廃棄");
    expect(southerIdentifier("data")).toBe("data_");
    expect(southerIdentifier("Date")).toBe("Date_");
    expect(southerIdentifier("3日以内")).toBe("n3日以内");
    expect(southerIdentifier("  ")).toBe("名前なし");
    expect(southerIdentifier("___")).toBe("名前なし");
  });
});

describe("exportSouther: 業務ルールの骨組みを Souther に書き出す", () => {
  it("サンプルの書き出しは、決まった形になる (同じファイルを CI で Souther のコンパイラに通す)", async () => {
    for (const sample of SAMPLES) {
      for (const file of exportSoutherAll(sample.create())) {
        await expect(file.text).toMatchFileSnapshot(`./__fixtures__/souther/${sample.id}/${file.fileName}`);
      }
    }
  });

  it("状態はグループの和に、操作は behavior に、前提の状態と代替パターンは guard と example の行になる", () => {
    const r = exportSouther(createHotelSample(), "sys_pms");
    expect(r.moduleName).toBe("untie.sys_pms");
    expect(r.fileName).toBe("sys_pms.sou");
    expect(r.text).toContain("data 予約の状態 = 仮予約 | 確定 | チェックイン済 | チェックアウト済 | 取消");
    // 今の状態が入力。前提の状態でなければ「状態が違う」、前提の状態なら次の状態
    expect(r.text).toContain("behavior 予約を確定する : (今の予約の状態: 予約の状態) -> 確定 | 予約を確定する_状態が違う");
    expect(r.text).toContain("    guard 今の予約の状態 == 仮予約 else 予約を確定する_状態が違う");
    expect(r.text).toContain('    | "ふだんの流れ: 仮予約 から → 確定" : (仮予約) -> 確定');
    // 前提でない状態のそれぞれが、行になる (状態 × 操作の表)
    for (const state of ["確定", "チェックイン済", "チェックアウト済", "取消"]) expect(r.text).toContain(`    | "前提の状態が違う: ${state} では行えない" : (${state}) -> 予約を確定する_状態が違う`);
    // 条件は真偽の入力。そのあとの状態が「ふだんと同じ」の代替パターンは、次の状態を持つ別の結果になる
    expect(r.text).toContain("data 予約を取り消す_取消料が発生する = { 予約の状態: 予約の状態 }");
    expect(r.text).toContain("behavior 予約を取り消す : (今の予約の状態: 予約の状態, 取消料が発生する: Bool) -> 取消 | 予約を取り消す_取消料が発生する | 予約を取り消す_状態が違う");
    expect(r.text).toContain("    guard Bool.not(取消料が発生する) else 予約を取り消す_取消料が発生する { 予約の状態 = 取消 }");
    expect(r.text).toMatch(/\| "取消料が発生するとき: [^"]+" : \(確定, true\) -> 予約を取り消す_取消料が発生する \{ 予約の状態 = 取消 \}/);
    expect(r.text).toContain("[そのあとの状態: ふだんと同じ]");
    // そのあとの状態が「変えない」の代替パターンは、状態を持たない別の結果になる
    expect(r.text).toContain("    guard 早めのチェックインができる else チェックインを記録する_早めのチェックインができる_でない");
    expect(r.text).not.toContain("data チェックインを記録する_早めのチェックインができる_でない");
    expect(r.open).toEqual([]);
    expect(r.owed).toBe(0);
    expect(r.behaviors).toBeGreaterThan(5);
    // 前提の状態も条件も無い操作は書き出さない
    expect(r.skipped.map((s) => s.name)).toContain("予約を検索する");
    expect(r.text).not.toContain("behavior 予約を検索する");
  });

  it("条件のときにどうなるかが未定なら、中身は分岐せず、答え待ちの行にする", () => {
    let m = createHotelSample();
    m = okModel(setRelationAlternate(m, { id: cond(m, "uc_cancel_reservation", "cond_cancel_fee").id, alternate: null }));
    const r = exportSouther(m, "sys_pms");
    expect(r.text).toContain("behavior 予約を取り消す : (今の予約の状態: 予約の状態, 取消料が発生する: Bool) -> 取消 | 予約を取り消す_状態が違う");
    expect(r.text).toContain('    | "取消料が発生する のとき: まだ決まっていない" : (確定, true) -> <?>');
    expect(r.open).toEqual([{ usecaseId: "uc_cancel_reservation", kind: "alternateUndecided", message: "操作「予約を取り消す」で、条件「取消料が発生する」のときにどうなるかが決まっていません" }]);
    expect(r.owed).toBe(1);
  });

  it("そのあとの状態: 未定なら答え待ち、選んだ状態ならその状態を持つ結果、エラーなら状態を持たない結果", () => {
    let m = createHotelSample();
    const id = cond(m, "uc_cancel_reservation", "cond_cancel_fee").id;
    // 未定: 操作がふだん状態を変えるので、そのあとの状態が要る
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "取消料を伝える", after: null } }));
    let r = exportSouther(m, "sys_pms");
    expect(r.open).toEqual([{ usecaseId: "uc_cancel_reservation", kind: "alternateAfterUndecided", message: "操作「予約を取り消す」で、条件「取消料が発生する」のときに、そのあとの状態がどうなるかが決まっていません" }]);
    expect(r.text).toContain('    | "取消料が発生するとき: 取消料を伝える" : (確定, true) -> <?>');
    expect(r.text).toContain("[そのあとの状態: 未定]");
    expect(r.owed).toBe(1);
    // 選んだ状態
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "取消料を伝える", after: { type: "states", stateIds: ["st_res_tentative"] } } }));
    r = exportSouther(m, "sys_pms");
    expect(r.text).toContain("    guard Bool.not(取消料が発生する) else 予約を取り消す_取消料が発生する { 予約の状態 = 仮予約 }");
    expect(r.open).toEqual([]);
    // 操作が関わらないグループの状態を選んでも、そのグループを宣言する
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "部屋を空ける", after: { type: "states", stateIds: ["st_room_waiting"] } } }));
    r = exportSouther(m, "sys_pms");
    expect(r.text).toContain("data 予約を取り消す_取消料が発生する = { 部屋の状態: 部屋の状態 }");
    // エラー: 状態は変えない
    m = okModel(setRelationAlternate(m, { id, alternate: { when: "met", then: "予約が見つからないと伝える", error: { type: "server", status: 404 } } }));
    r = exportSouther(m, "sys_pms");
    expect(r.text).toContain("//   取消料が発生するとき: 予約が見つからないと伝える (サーバーエラー 404) [そのあとの状態: 変えない]");
    expect(r.text).toContain("    guard Bool.not(取消料が発生する) else 予約を取り消す_取消料が発生する\n");
    expect(r.open).toEqual([]);
  });

  it("複数のグループの状態が同時に変わる操作は、結果を 1 つの data にまとめる (中身は、グループごとの状態)", () => {
    const r = exportSouther(createHotelSample(), "sys_pms");
    expect(r.text).toContain("data チェックアウトを記録する_結果 = { 予約の状態: 予約の状態, 部屋の状態: 部屋の状態 }");
    expect(r.text).toContain("    チェックアウトを記録する_結果 { 予約の状態 = チェックアウト済, 部屋の状態 = 清掃待ち }");
    expect(r.text).toContain('    | "ふだんの流れ: チェックイン済 から → チェックアウト済・清掃待ち" : (チェックイン済) -> チェックアウトを記録する_結果 { 予約の状態 = チェックアウト済, 部屋の状態 = 清掃待ち }');
  });

  it("前提の状態が複数ある操作は、どれかであることを確かめる。次の状態が同じグループに複数あれば、中身は書かない", () => {
    const accounting = SAMPLES.find((s) => s.id === "accounting")!.create();
    const system = accounting.elements.find((e) => e.kind === "system" && e.name === "会計システム")!;
    const r = exportSouther(accounting, system.id);
    // 引数の型は、グループの和 (名前の無い和は、behavior の引数に書けない)
    expect(r.text).toContain("behavior 売掛金を消し込む : (今の売掛金の状態: 売掛金の状態, 入金額が請求額と違う: Bool)");
    expect(r.text).not.toMatch(/^behavior [^\n]*\([^)]*: [^,)]* \| /m);
    // 次の状態が同じグループに複数あるので、中身は書かず、答え待ちの行にする
    expect(r.open.map((o) => o.kind)).toContain("nextStateUndecided");
    expect(r.text).not.toContain("let 売掛金を消し込む");
    expect(r.text).toContain('    | "前提の状態が違う: 消込済 では行えない" : (消込済, false) -> 売掛金を消し込む_状態が違う');
    // 中身を書ける操作では、前提の状態のどれかであることを確かめる
    let m = createHotelSample();
    m = { ...m, relations: [...m.relations, { id: "rel_extra", kind: "stateUsecase", sourceId: "st_res_tentative", targetId: "uc_change_reservation" }] };
    expect(exportSouther(m, "sys_pms").text).toContain("    guard 今の予約の状態 == 確定 || 今の予約の状態 == 仮予約 else 予約を変更する_状態が違う");
  });

  it("前提の状態が無くなっても、条件があれば書き出す。操作の無いシステムは空", () => {
    let m = createHotelSample();
    const pre = m.relations.find((x) => x.kind === "stateUsecase" && x.targetId === "uc_cancel_reservation")!;
    m = okModel(removeRelation(m, { id: pre.id }));
    expect(exportSouther(m, "sys_pms").text).toContain("behavior 予約を取り消す : (取消料が発生する: Bool) -> 取消 | 予約を取り消す_取消料が発生する\n");
    const none = exportSouther(m, "sys_none");
    expect(none.behaviors).toBe(0);
    expect(exportSoutherAll(m).some((x) => x.systemId === "sys_none")).toBe(false);
  });
});
