import { describe, expect, it } from "vitest";
import {
  analysisBoardId,
  ANALYSIS_KINDS,
  informationLocations,
  issueDistribution,
  parseAnalysisBoardId,
  performerWorkList,
  screenInformationTables,
  systemEventLists,
} from "../analysis";
import { addElement, addRelation, removeRelation, setIssueTargets, setRelationAccess, setUsecaseTarget } from "../commands";
import { createNetshopSample } from "../../sample";
import { expectFail, okModel, sample } from "./helpers";

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("分析ボードの id", () => {
  it("種類と相互に変換できる", () => {
    for (const k of ANALYSIS_KINDS) expect(parseAnalysisBoardId(analysisBoardId(k))).toBe(k);
    expect(parseAnalysisBoardId("fixed:activity")).toBeNull();
    expect(parseAnalysisBoardId("analysis:nope")).toBeNull();
  });
});

describe("担当別の作業一覧", () => {
  it("担い手 (人) ごとに担当する作業を業務・活動の順に並べ、担当の無い作業は最後にまとめる", () => {
    let m = sample();
    const { performers, unassigned } = performerWorkList(m);
    const front = performers.find((p) => p.performer.id === "actor_front")!;
    expect(front.sections.map((s) => [s.business?.name, s.buc?.name ?? null])).toEqual([
      ["チェックイン", null],
      ["滞在中の対応", "客室対応"],
      ["滞在中の対応", "飲食提供"],
      ["滞在中の対応", "追加料金の対応"],
      ["チェックアウト", null],
    ]);
    // システムは作業の担当にならないので並ばない (0.2.0 から)
    expect(performers.some((p) => p.performer.kind === "system")).toBe(false);
    expect(unassigned).toEqual([]);
    m = okModel(addElement(m, { kind: "activity", name: "担当なし", id: "act_x" }));
    expect(performerWorkList(m).unassigned.map((s) => names(s.activities))).toEqual([["担当なし"]]);
  });
});

describe("情報の所在", () => {
  it("取得元・保存先を並べ、紙だけ・保存先が複数・置き場所なしに印を付ける", () => {
    let m = sample();
    const r = informationLocations(m);
    const row = (id: string) => r.rows.find((x) => x.information.id === id)!;
    // 置き場所は、扱う操作の対象 (画面ならそのシステム) と access から導く
    expect(row("info_reservation").places.get("sys_pms")).toEqual(["source", "store"]);
    expect(row("info_reservation").places.get("sys_booking_site")).toEqual(["source", "store"]);
    expect(row("info_plan").places.get("sys_pms")).toEqual(["source"]);
    expect(row("info_cleaning_record").flags).toEqual(["paperOnly"]);
    expect(row("info_guest").flags).toEqual(["multipleStores"]);
    // 操作の access を変えると置き場所の役割も変わる
    const readOnly = okModel(setRelationAccess(m, { id: "rel_uc_register_reservation__info_reservation", access: "read" }));
    expect(informationLocations(readOnly).rows.find((x) => x.information.id === "info_reservation")!.places.get("sys_booking_site")).toEqual(["source"]);
    m = okModel(addElement(m, { kind: "information", name: "x", id: "info_x" }));
    expect(informationLocations(m).rows.find((x) => x.information.id === "info_x")!.flags).toEqual(["noPlace"]);
  });
});

describe("課題の分布", () => {
  it("業務・その作業・作業が使う操作に付いた課題を業務ごとに重要度順に集める。どこにも辿れない課題は最後", () => {
    let m = sample();
    const r = issueDistribution(m);
    const res = r.find((x) => x.business?.id === "biz_reservation")!;
    expect(res.issues.map((i) => i.severity)).toEqual([5, 2]);
    expect(res.maxSeverity).toBe(5);
    expect(r.find((x) => x.business?.id === "biz_checkout")!.issues).toEqual([]);
    // どの作業にも使われていない操作に付いた具体的な課題は、最後の「辿れない」にまとめる
    m = okModel(addElement(m, { kind: "usecase", name: "宙に浮いた操作", id: "uc_x" }));
    m = okModel(addElement(m, { kind: "issue", name: "宙に浮いた課題", id: "issue_x", init: { severity: 1, targetIds: ["uc_x"] } }));
    const dist = issueDistribution(m);
    expect(dist[dist.length - 1]).toMatchObject({ business: null, maxSeverity: 1 });
    // 対象の無い未整理の課題は、業務の表にも「辿れない」にも入れない (別の表で出す)
    const unsorted = okModel(setIssueTargets(m, { issueId: "issue_x", targetIds: [] }));
    expect(issueDistribution(unsorted).some((d) => d.issues.some((i) => i.id === "issue_x"))).toBe(false);
    // 登場人物が対象の全体的な課題は、業務の表にも「辿れない」にも入れない
    const overall = okModel(setIssueTargets(m, { issueId: "issue_x", targetIds: ["actor_front"] }));
    expect(issueDistribution(overall).some((d) => d.issues.some((i) => i.id === "issue_x"))).toBe(false);
    // 作業から操作への線を外すと、操作に付いた課題はその業務から外れる
    const rel = m.relations.find((x) => x.sourceId === "act_change_cancel" && x.targetId === "uc_cancel_reservation")!;
    m = okModel(removeRelation(m, { id: rel.id }));
    const res2 = issueDistribution(m).find((x) => x.business?.id === "biz_reservation")!;
    expect(res2.spots.some((s) => s.element.id === "uc_cancel_reservation")).toBe(false);
  });
});

describe("画面と情報", () => {
  it("システムごとに、行は画面、列はその画面が扱う情報。画面の無いシステムは表を作らず並べる", () => {
    const m = createNetshopSample();
    const { tables, systemsWithoutScreens } = screenInformationTables(m);
    expect(tables.map((t) => t.system.name)).toEqual(["モールの管理画面", "販売管理システム", "決済サービス", "会計システム"]);
    expect(systemsWithoutScreens.map((s) => s.name)).toEqual(["自社サイトのカート"]);
    const accounting = tables.find((t) => t.system.id === "sys_accounting")!;
    expect(accounting.rows.map((r) => r.screen.name)).toEqual(["入金の登録画面", "売掛金の消込画面", "月次レポート", "損益計算書の画面", "貸借対照表の画面"]);
    expect(accounting.informations.map((i) => i.name)).toEqual(["売掛金", "入金", "損益計算書 (PL)", "貸借対照表 (BS)"]);
    const report = accounting.rows.find((r) => r.screen.id === "scr_monthly_report")!;
    // 画面が扱う情報は、画面を使う操作が扱う情報 (取得・保存) から導く
    expect([...report.cells]).toEqual([
      ["info_pl", ["source"]],
      ["info_bs", ["source"]],
    ]);
    // 画面を使う操作を添える
    expect(report.usecases.map((u) => u.name)).toEqual(["月次の数字を報告する"]);
  });

  it("画面が扱う情報は使う操作から導く (画面と情報は直接結べない)。情報を扱わない画面は noInformation", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "screen", name: "チェックイン画面", id: "scr_a", init: { systemId: "sys_pms" } }));
    m = okModel(addElement(m, { kind: "screen", name: "空の画面", id: "scr_b", init: { systemId: "sys_pms" } }));
    expectFail(addRelation(m, { sourceId: "scr_a", targetId: "info_reservation" }), /結べません/);
    // チェックインを記録する (予約: 取得・保存、宿泊客: 取得・保存) をこの画面で行う
    m = okModel(setUsecaseTarget(m, { usecaseId: "uc_record_checkin", targetId: "scr_a" }));
    m = okModel(setRelationAccess(m, { id: "rel_uc_record_checkin__info_guest", access: "read" }));
    const pms = screenInformationTables(m).tables.find((t) => t.system.id === "sys_pms")!;
    const a = pms.rows.find((r) => r.screen.id === "scr_a")!;
    expect([...a.cells]).toEqual([
      ["info_reservation", ["source", "store"]],
      ["info_guest", ["source"]],
    ]);
    expect(a.noInformation).toBe(false);
    expect(pms.rows.find((r) => r.screen.id === "scr_b")!.noInformation).toBe(true);
  });
});

describe("情報の所在: システムのイベント", () => {
  it("システムごとに、直接発生させるイベントと、そのシステムを対象にした操作 (画面を通すものも) が発生させるイベントを並べ、きっかけにする操作と作業を添える", () => {
    const { lists, systemsWithoutEvents, eventsWithoutSystem } = systemEventLists(createNetshopSample());
    expect(lists.map((l) => l.system.name)).toEqual(["自社サイトのカート", "販売管理システム", "決済サービス", "会計システム"]);
    expect(systemsWithoutEvents.map((s) => s.name)).toEqual(["モールの管理画面"]);
    expect(eventsWithoutSystem).toEqual([]);
    const accounting = lists.find((l) => l.system.id === "sys_accounting")!;
    const closed = accounting.rows.find((r) => r.event.name === "月次の締めが済んだ")!;
    // 会計システムが直接発生させる
    expect([closed.direct, names(closed.usecases)]).toEqual([true, []]);
    expect(closed.triggers.map((t) => [t.usecase.name, names(t.activities)])).toEqual([["損益計算書を見る", ["損益を確認する"]]]);
    // 操作から: 対象の画面が販売管理システムに属する操作。きっかけにするのは作業に属さない自動の処理
    const sales = lists.find((l) => l.system.id === "sys_oms")!;
    const fixed = sales.rows.find((r) => r.event.name === "注文が確定した")!;
    expect([fixed.direct, names(fixed.usecases)]).toEqual([false, ["注文を確定する"]]);
    expect(fixed.triggers.map((t) => [t.usecase.name, names(t.activities)])).toEqual([["在庫を引き当てる", []]]);
  });

  it("帳票を対象にした操作のイベントや、何にもつながらないイベントは、システムにつながらないイベントに並べる", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "usecase", name: "清掃を記録する", id: "uc_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_x", targetId: "ldg_cleaning_sheet" }));
    m = okModel(addElement(m, { kind: "event", name: "清掃が記録された", id: "ev_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_x", targetId: "ev_x" }));
    m = okModel(addElement(m, { kind: "event", name: "ひとりのイベント", id: "ev_y" }));
    expect(names(systemEventLists(m).eventsWithoutSystem)).toEqual(["清掃が記録された", "ひとりのイベント"]);
  });
});
