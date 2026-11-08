import { describe, expect, it } from "vitest";
import { addElement, addRelation, moveActivity, removeRelation, setUsecaseTarget } from "../commands";
import { traceToActors, traceWarnings } from "../trace";
import { emptyModel } from "../types";
import { expectFail, okModel, sample } from "./helpers";

describe("traceToActors", () => {
  it("サンプルはすべての要素がアクター / 外部アクターに辿り着く", () => {
    const r = traceToActors(sample());
    expect(r.problems).toEqual([]);
    expect(r.total).toBeGreaterThan(40);
  });

  it("担当の無い作業は途切れ箇所。その作業だけが使う操作・情報は、その作業で途切れている", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "activity", name: "孤立した作業", id: "act_x" }));
    m = okModel(addElement(m, { kind: "usecase", name: "孤立した操作", id: "uc_x" }));
    m = okModel(addElement(m, { kind: "information", name: "孤立した情報", id: "info_x" }));
    m = okModel(addRelation(m, { sourceId: "act_x", targetId: "uc_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_x", targetId: "info_x" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak, p.breakIds])).toEqual([
      ["act_x", true, ["act_x"]],
      ["uc_x", false, ["act_x"]],
      ["info_x", false, ["act_x"]],
    ]);
    expect(r.problems[0]!.reason).toBe("担当 (アクター・外部アクター) がいません");
    expect(r.problems[1]!.reason).toMatch(/作業「孤立した作業」から先が途切れています/);
    // 業務に入れても、担当が無ければ途切れたまま (作業の担当は必須)
    m = okModel(moveActivity(m, { activityId: "act_x", bucId: "buc_dining" }));
    expect(traceToActors(m).problems.map((p) => p.elementId)).toEqual(["act_x", "uc_x", "info_x"]);
    // システムは担当にできない (0.2.0 から)。人を担当にすると辿り着く
    expect(addRelation(m, { sourceId: "sys_pms", targetId: "act_x" }).ok).toBe(false);
    m = okModel(addRelation(m, { sourceId: "actor_front", targetId: "act_x" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("主担当のいない業務は途切れ箇所で、その活動も業務で途切れる。担当のいる作業は辿り着く", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "business", name: "新業務", id: "biz_x" }));
    m = okModel(addElement(m, { kind: "buc", name: "新活動", id: "buc_x", init: { businessId: "biz_x" } }));
    m = okModel(addElement(m, { kind: "activity", name: "新作業", id: "act_x", init: { bucId: "buc_x" } }));
    m = okModel(addRelation(m, { sourceId: "actor_front", targetId: "act_x" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak, p.breakIds])).toEqual([
      ["biz_x", true, ["biz_x"]],
      ["buc_x", false, ["biz_x"]],
    ]);
  });

  it("コンテキスト・システム・帳票・バリエーション・状態・条件も、つながりが無ければ途切れ箇所", () => {
    let m = sample();
    for (const kind of ["context", "system", "ledger", "variation", "state", "condition"] as const) {
      m = okModel(addElement(m, { kind, name: kind, id: `x_${kind}` }));
    }
    const r = traceToActors(m);
    expect(r.problems.every((p) => p.isBreak)).toBe(true);
    const reasonOf = (id: string) => r.problems.find((p) => p.elementId === id)?.reason;
    expect(reasonOf("x_context")).toBe("情報・状態・条件・バリエーションが入っていません");
    expect(reasonOf("x_system")).toBe("どの操作の対象にもなっておらず、画面もイベントもありません");
    expect(reasonOf("x_ledger")).toBe("どの操作の対象にもなっていません");
    expect(reasonOf("x_variation")).toBe("どの情報・条件の種別にもなっていません");
    expect(reasonOf("x_state")).toBe("どの操作・条件ともつながっていません");
    expect(reasonOf("x_condition")).toBe("どの操作の判断にも使われていません");
  });

  it("システムは辿り着く先。操作の対象・イベントの発生元のどちらかか、画面を持っていれば途切れにしない (情報の置き場所は対象から導くので別には数えない)", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "system", name: "新システム", id: "sys_x" }));
    expect(traceToActors(m).problems.map((p) => p.elementId)).toEqual(["sys_x"]);
    const m1 = okModel(setUsecaseTarget(m, { usecaseId: "uc_search_reservation", targetId: "sys_x" }));
    expect(traceToActors(m1).problems).toEqual([]);
    // 情報とは直接結べない (置き場所は操作から導く)
    expectFail(addRelation(m, { sourceId: "info_bill", targetId: "sys_x" }), /結べません/);
    const m2 = okModel(addRelation(m, { sourceId: "sys_x", targetId: "ev_checkout_day" }));
    expect(traceToActors(m2).problems).toEqual([]);
    const m3 = okModel(addElement(m, { kind: "screen", name: "画面", id: "scr_x", init: { systemId: "sys_x" } }));
    expect(traceToActors(m3).problems.map((p) => p.elementId)).toEqual([]);
  });

  it("操作はきっかけのイベントからも辿れ、イベントは発生させる操作・システムから辿る。発生元の無いイベントは途切れ箇所", () => {
    let m = sample();
    // 作業に属さない操作でも、システムが発生させたイベントがきっかけなら辿り着く (サンプルの「請求金額を計算する」)
    expect(traceToActors(m).problems).toEqual([]);
    m = okModel(addElement(m, { kind: "event", name: "発生元の無いイベント", id: "ev_x" }));
    m = okModel(addElement(m, { kind: "usecase", name: "それをきっかけにする操作", id: "uc_x" }));
    m = okModel(addRelation(m, { sourceId: "ev_x", targetId: "uc_x" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak, p.breakIds])).toEqual([
      ["ev_x", true, ["ev_x"]],
      ["uc_x", false, ["ev_x"]],
    ]);
    expect(r.problems[0]!.reason).toBe("どの操作・システムからも発生していません");
    m = okModel(addRelation(m, { sourceId: "sys_pms", targetId: "ev_x" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("画面と非機能要件は属するシステムから辿る。画面は情報と直接結べない (扱う情報は使う操作から導く)。帳票は対象にする操作から辿る", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "screen", name: "画面", id: "scr_x", init: { systemId: "sys_pms" } }));
    m = okModel(addElement(m, { kind: "nfr", name: "要件", id: "nfr_x", init: { systemId: "sys_pms" } }));
    m = okModel(addElement(m, { kind: "information", name: "画面だけの情報", id: "info_x" }));
    expectFail(addRelation(m, { sourceId: "scr_x", targetId: "info_x" }), /結べません/);
    m = okModel(addRelation(m, { sourceId: "uc_record_checkin", targetId: "info_x" }));
    m = okModel(addElement(m, { kind: "ledger", name: "記入用紙", id: "ldg_x" }));
    m = okModel(setUsecaseTarget(m, { usecaseId: "uc_record_checkin", targetId: "ldg_x" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("情報は操作に扱われていなければ途切れ (システム・帳票とは直接結べない)", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "information", name: "台帳だけの情報", id: "info_x" }));
    expectFail(addRelation(m, { sourceId: "sys_pms", targetId: "info_x" }), /結べません/);
    expect(traceToActors(m).problems.map((p) => [p.elementId, p.isBreak])).toEqual([["info_x", true]]);
  });

  it("関連する情報どうしでつながっているだけなら、両方を途切れ箇所にする", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "information", name: "A", id: "info_a" }));
    m = okModel(addElement(m, { kind: "information", name: "B", id: "info_b" }));
    m = okModel(addRelation(m, { sourceId: "info_a", targetId: "info_b" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak])).toEqual([
      ["info_a", true],
      ["info_b", true],
    ]);
    expect(r.problems[0]!.reason).toMatch(/情報「B」も辿り着けません/);
    // 片方が操作に扱われれば、関連を通ってもう片方も辿り着く
    m = okModel(addRelation(m, { sourceId: "uc_record_checkin", targetId: "info_a" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("操作から作業への線を外すと、その操作だけに使われていた要素が途切れる", () => {
    const m0 = sample();
    const rel = m0.relations.find((r) => r.sourceId === "act_clean" && r.kind === "activityUsecase")!;
    const m = okModel(removeRelation(m0, { id: rel.id }));
    const r = traceToActors(m);
    // 清掃状況を更新するは、清掃を指示する・部屋を点検するからも使われているので途切れない
    expect(r.problems.some((p) => p.elementId === rel.targetId)).toBe(false);
  });
});

describe("traceWarnings", () => {
  const businessWarnings = (m: Parameters<typeof traceWarnings>[0]) => traceWarnings(m).filter((w) => w.type === "businessActors");

  it("サンプル (宿泊施設) は警告が出ない", () => {
    expect(traceWarnings(sample())).toEqual([]);
  });

  it("1 つの業務に複数のアクターが付くと、その業務の警告を出す。辿れるかのエラーには数えない", () => {
    let m = sample();
    // 「予約受付」には予約担当が付いている。支配人も付ける
    m = okModel(addRelation(m, { sourceId: "actor_manager", targetId: "biz_reservation" }));
    const w = businessWarnings(m);
    expect(w).toHaveLength(1);
    expect(w[0]!.type).toBe("businessActors");
    expect(w[0]!.elementId).toBe("biz_reservation");
    expect(w[0]!.relatedIds).toEqual(["actor_reservation", "actor_manager"]);
    expect(w[0]!.reason).toBe("主担当のアクターが 2 人います: 「予約担当」、「支配人」");
    expect(w[0]!.fix).toMatch(/主担当は 1 人/);
    // エラーではない: 辿り着ける要素の検証には影響しない
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("業務ごとに数える。3 人でも 1 件で、1 人に戻すと消える", () => {
    let m = sample();
    m = okModel(addRelation(m, { sourceId: "actor_manager", targetId: "biz_reservation" }));
    m = okModel(addRelation(m, { sourceId: "actor_housekeeping", targetId: "biz_reservation" }));
    m = okModel(addRelation(m, { sourceId: "actor_manager", targetId: "biz_checkin" }));
    const w = businessWarnings(m);
    expect(w.map((x) => [x.elementId, x.relatedIds.length])).toEqual([
      ["biz_reservation", 3],
      ["biz_checkin", 2],
    ]);
    const extra = m.relations.find((r) => r.sourceId === "actor_manager" && r.targetId === "biz_checkin")!;
    m = okModel(removeRelation(m, { id: extra.id }));
    expect(businessWarnings(m).map((x) => x.elementId)).toEqual(["biz_reservation"]);
  });

  it("外部アクターが作業の担当になっても、業務の警告にはならない", () => {
    let m = sample();
    m = okModel(addRelation(m, { sourceId: "ext_guest", targetId: "act_accept_reservation" }));
    expect(businessWarnings(m)).toEqual([]);
  });

  /** 作業 1 つに操作を並べたモデル。chain は「次に」でつなぐ操作の id */
  function chainModel(usecases: string[], next: [string, string][], emits: string[]) {
    let m = emptyModel();
    m = okModel(addElement(m, { kind: "actor", name: "担当", id: "actor_a" }));
    m = okModel(addElement(m, { kind: "activity", name: "作業A", id: "act_a" }));
    m = okModel(addRelation(m, { sourceId: "actor_a", targetId: "act_a" }));
    for (const id of usecases) {
      m = okModel(addElement(m, { kind: "usecase", name: id, id }));
      m = okModel(addRelation(m, { sourceId: "act_a", targetId: id }));
    }
    for (const [a, b] of next) m = okModel(addRelation(m, { sourceId: a, targetId: b }));
    for (const id of emits) {
      m = okModel(addElement(m, { kind: "event", name: `${id} の結果`, id: `ev_${id}` }));
      m = okModel(addRelation(m, { sourceId: id, targetId: `ev_${id}` }));
    }
    return m;
  }
  it("作業の操作の並びや、イベントをきっかけにした自動の処理がイベントで終わらなくても警告しない", () => {
    // 作業A: 操作B → 操作C (どちらもイベントを出さない)
    expect(traceWarnings(chainModel(["uc_b", "uc_c"], [["uc_b", "uc_c"]], []))).toEqual([]);
    // 操作が 1 つだけの作業も警告しない
    expect(traceWarnings(chainModel(["uc_b"], [], []))).toEqual([]);
    // 自動の処理の末尾にイベントを出さない操作を足しても警告しない
    let m = sample();
    m = okModel(addElement(m, { kind: "usecase", name: "割引を当てる", id: "uc_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_calc_charge", targetId: "uc_x" }));
    expect(traceWarnings(m)).toEqual([]);
    // 自分自身への「次に」は結べない
    expect(addRelation(chainModel(["uc_b"], [], []), { sourceId: "uc_b", targetId: "uc_b" }).ok).toBe(false);
  });
});

describe("traceToActors: 作業の起点 (0.4.1)", () => {
  it("起点だけでつながった作業は、担当が無ければ途切れとして出る。起点が循環しても終わり、結果が変わらない", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "activity", name: "起点だけの作業", id: "act_t1" }));
    m = okModel(addElement(m, { kind: "activity", name: "もう一つ", id: "act_t2" }));
    m = okModel(addRelation(m, { sourceId: "act_clean", targetId: "act_t1" }));
    m = okModel(addRelation(m, { sourceId: "ev_checkout_day", targetId: "act_t2" }));
    m = okModel(addRelation(m, { sourceId: "act_t1", targetId: "act_t2" }));
    m = okModel(addRelation(m, { sourceId: "act_t2", targetId: "act_t1" }));
    const r = traceToActors(m);
    // 担当のいる作業から起点で結んでも、担い手には辿り着かない
    expect(r.problems.map((p) => [p.elementId, p.isBreak])).toEqual([["act_t1", true], ["act_t2", true]]);
    // 起点を外しても、サンプルの結果は変わらない
    expect(traceToActors(sample()).problems).toEqual([]);
    expect(traceWarnings(m)).toEqual(traceWarnings(sample()));
  });
});
