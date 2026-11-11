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

  it("状態はグループの和に、操作は behavior に、代替パターンは guard と example の行になる", () => {
    const r = exportSouther(createHotelSample(), "sys_pms");
    expect(r.moduleName).toBe("untie.sys_pms");
    expect(r.fileName).toBe("sys_pms.sou");
    expect(r.text).toContain("data 予約の状態 = 仮予約 | 確定 | チェックイン済 | チェックアウト済 | 取消");
    // 前提の状態が入力、次の状態が出力
    expect(r.text).toContain("behavior 予約を確定する : (前の予約の状態: 仮予約) -> 確定");
    expect(r.text).toContain("let 予約を確定する (前の予約の状態) = 確定");
    expect(r.text).toContain('    | "ふだんの流れ: 仮予約 から → 確定" : (仮予約) -> 確定');
    // 条件は真偽の入力。条件を満たすときの別の結果は、guard の else
    expect(r.text).toContain("behavior 予約を取り消す : (前の予約の状態: 確定, 取消料が発生する: Bool) -> 取消 | 予約を取り消す_取消料が発生する");
    expect(r.text).toContain("    guard Bool.not(取消料が発生する) else 予約を取り消す_取消料が発生する");
    expect(r.text).toMatch(/\| "取消料が発生するとき: [^"]+" : \(確定, true\) -> 予約を取り消す_取消料が発生する/);
    expect(r.open).toEqual([]);
    expect(r.owed).toBe(0);
    expect(r.behaviors).toBeGreaterThan(5);
    // 前提の状態も条件も無い操作は書き出さない
    expect(r.skipped.map((s) => s.name)).toContain("予約を検索する");
    expect(r.text).not.toContain("behavior 予約を検索する");
  });

  it("条件を満たさないときに別の結果になるなら、guard は条件そのもの", () => {
    const m = createHotelSample();
    const rel = m.relations.find((x) => x.kind === "usecaseCondition" && x.alternate?.when === "unmet");
    if (!rel) return;
    const r = exportSouther(m, "sys_pms");
    expect(r.text).toMatch(/guard [^\s(]+ else \S+_でない/);
  });

  it("条件のときにどうなるかが未定なら、中身は分岐せず、答え待ちの行にする", () => {
    let m = createHotelSample();
    m = okModel(setRelationAlternate(m, { id: cond(m, "uc_cancel_reservation", "cond_cancel_fee").id, alternate: null }));
    const r = exportSouther(m, "sys_pms");
    expect(r.text).toContain("behavior 予約を取り消す : (前の予約の状態: 確定, 取消料が発生する: Bool) -> 取消");
    expect(r.text).toContain("let 予約を取り消す (前の予約の状態, 取消料が発生する) = 取消");
    expect(r.text).toContain('    | "取消料が発生する のとき: まだ決まっていない" : (確定, true) -> <?>');
    expect(r.open).toEqual([{ usecaseId: "uc_cancel_reservation", kind: "alternateUndecided", message: "操作「予約を取り消す」で、条件「取消料が発生する」のときにどうなるかが決まっていません" }]);
    expect(r.owed).toBe(1);
  });

  it("代替パターンがエラーなら、コメントにエラーの種類を書く", () => {
    let m = createHotelSample();
    m = okModel(setRelationAlternate(m, { id: cond(m, "uc_cancel_reservation", "cond_cancel_fee").id, alternate: { when: "met", then: "予約が見つからないと伝える", error: { type: "server", status: 404 } } }));
    expect(exportSouther(m, "sys_pms").text).toContain("//   取消料が発生するとき: 予約が見つからないと伝える (サーバーエラー 404)");
  });

  it("複数のグループの状態が同時に変わる操作は、結果を 1 つの data にまとめる", () => {
    const r = exportSouther(createHotelSample(), "sys_pms");
    expect(r.text).toContain("data チェックアウトを記録する_結果 = { 予約の状態: チェックアウト済, 部屋の状態: 清掃待ち }");
    expect(r.text).toContain("let チェックアウトを記録する (前の予約の状態) = チェックアウトを記録する_結果 { 予約の状態 = チェックアウト済, 部屋の状態 = 清掃待ち }");
  });

  it("前提の状態が複数ある操作は、引数の型を名前の付いた和にする (behavior の引数に、名前の無い和は書けない)", () => {
    const accounting = SAMPLES.find((s) => s.id === "accounting")!.create();
    const system = accounting.elements.find((e) => e.kind === "system" && e.name === "会計システム")!;
    const r = exportSouther(accounting, system.id);
    // グループの状態の一部が前提: その操作の前提だけの和を宣言する
    expect(r.text).toContain("data 売掛金を消し込む_前の売掛金の状態 = 未入金 | 一部入金");
    expect(r.text).toContain("behavior 売掛金を消し込む : (前の売掛金の状態: 売掛金を消し込む_前の売掛金の状態, 入金額が請求額と違う: Bool)");
    expect(r.text).not.toMatch(/^behavior [^\n]*\([^)]*: [^,)]* \| /m);
    // 次の状態が同じグループに複数あるので、中身は書かず、答え待ちの行にする
    expect(r.open.map((o) => o.kind)).toContain("nextStateUndecided");
    expect(r.text).not.toContain("let 売掛金を消し込む");
    // グループの状態のすべてが前提なら、グループの和をそのまま使う
    let m = createHotelSample();
    for (const id of ["st_res_tentative", "st_res_checkedin", "st_res_checkedout", "st_res_cancelled"]) {
      m = { ...m, relations: [...m.relations, { id: `rel_extra_${id}`, kind: "stateUsecase", sourceId: id, targetId: "uc_change_reservation" }] };
    }
    expect(exportSouther(m, "sys_pms").text).toContain("behavior 予約を変更する : (前の予約の状態: 予約の状態) -> 確定");
  });

  it("前提の状態が無くなっても、条件があれば書き出す。操作の無いシステムは空", () => {
    let m = createHotelSample();
    const pre = m.relations.find((x) => x.kind === "stateUsecase" && x.targetId === "uc_cancel_reservation")!;
    m = okModel(removeRelation(m, { id: pre.id }));
    expect(exportSouther(m, "sys_pms").text).toContain("behavior 予約を取り消す : (取消料が発生する: Bool) -> 取消 | 予約を取り消す_取消料が発生する");
    const none = exportSouther(m, "sys_none");
    expect(none.behaviors).toBe(0);
    expect(exportSoutherAll(m).some((x) => x.systemId === "sys_none")).toBe(false);
  });
});
