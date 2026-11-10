import { describe, expect, it } from "vitest";
import { createAccountingSample, createNetshopSample, createRetailSample } from "../../sample";
import { addElement, addRelation, removeRelation } from "../commands";
import { DOMAIN_NOTICE_HINTS, DOMAIN_NOTICE_LEVELS, DOMAIN_NOTICE_ORDER, DOMAIN_NOTICE_TITLES, domainNotices, groupDomainNotices } from "../domainNotices";
import { traceWarnings } from "../trace";
import { okModel, sample } from "./helpers";

const ofType = (m: ReturnType<typeof createNetshopSample>, type: string) => domainNotices(m).filter((n) => n.type === type);

describe("気づきの定義", () => {
  it("すべての種類に区分・見出し・説明と出す順がある", () => {
    for (const type of DOMAIN_NOTICE_ORDER) {
      expect(DOMAIN_NOTICE_LEVELS[type]).toBeDefined();
      expect(DOMAIN_NOTICE_TITLES[type]).toBeTruthy();
      expect(DOMAIN_NOTICE_HINTS[type]).toBeTruthy();
    }
    expect(new Set(DOMAIN_NOTICE_ORDER).size).toBe(Object.keys(DOMAIN_NOTICE_TITLES).length);
  });

  it("分析の検証の警告とは別の枠で、サンプルの警告は空のまま", () => {
    for (const m of [sample(), createNetshopSample(), createRetailSample(), createAccountingSample()]) {
      expect(traceWarnings(m)).toEqual([]);
      expect(domainNotices(m).length).toBeGreaterThan(0);
    }
  });
});

describe("境界と状態の持ち主", () => {
  it("別のシステムの操作が状態を変えるのは境界の問いにし、読むだけでイベントを出す問いは重ねない", () => {
    const m = createNetshopSample();
    const boundary = ofType(m, "boundaryStateChange");
    expect(boundary.map((n) => n.elementIds[0])).toEqual(["uc_record_payment", "uc_record_refund"]);
    expect(boundary[0]!.message).toContain("決済サービス");
    expect(boundary[0]!.message).toContain("「注文」の保存先ではありません");
    expect(boundary[0]!.level).toBe("question");
    // 同じ操作には「読むだけの操作がイベントを発生させている」を重ねない
    expect(ofType(m, "readOnlyEmitsEvent").map((n) => n.elementIds[0])).toEqual(["uc_issue_pick_list", "uc_report_month"]);
    expect(ofType(m, "readOnlyChangesState")).toEqual([]);
  });

  it("状態を変える操作が持ち主の情報を書いていなければ問いにし、持ち主が決まらなければ別の問いにする", () => {
    const mismatch = ofType(createNetshopSample(), "stateOwnerMismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.message).toContain("「出荷を記録する」");
    expect(mismatch[0]!.message).toContain("持ち主の「注文」は書きません");
    const unknown = ofType(createRetailSample(), "stateGroupOwnerUnknown");
    expect(unknown.map((n) => n.message)).toEqual([expect.stringContaining("「発注の状態」"), expect.stringContaining("「1 日の締めの状態」")]);
  });

  it("帳票が対象の操作は境界にせず、持ち主の問いにする", () => {
    const notices = domainNotices(sample());
    expect(notices.filter((n) => n.type === "boundaryStateChange")).toEqual([]);
    expect(notices.find((n) => n.type === "stateOwnerMismatch")!.message).toContain("「清掃状況を更新する」");
  });

  it("1 つのコンテキストに状態グループが複数あれば分割の候補にする", () => {
    const n = ofType(createNetshopSample(), "contextWithManyStateGroups");
    expect(n).toHaveLength(1);
    expect(n[0]!.elementIds[0]).toBe("ctx_order");
    expect(n[0]!.message).toContain("「注文の状態」「返品の状態」");
  });
});

describe("コマンドまわり", () => {
  it("複数の作業が使う書く操作、課題の付いた操作、条件を満たさないときの結果が無い操作を問いにし、コマンド候補のキーを付ける", () => {
    const m = createNetshopSample();
    const shared = ofType(m, "sharedCommand");
    expect(shared.map((n) => n.elementIds[0])).toEqual(["uc_update_stock", "uc_record_inquiry"]);
    expect(shared[0]!.commandKey).toBe("usecase:uc_update_stock/activity:act_shelve");
    expect(shared[0]!.message).toContain("3 つの作業");
    const cond = ofType(m, "conditionWithoutFailureEvent");
    expect(cond.map((n) => n.elementIds[0])).toEqual(["uc_allocate_stock", "uc_register_return"]);
    expect(cond[0]!.commandKey).toBe("usecase:uc_allocate_stock");
    // 課題の付いた操作 (宿泊施設のサンプル)
    const issue = domainNotices(sample()).filter((n) => n.type === "issueOnCommand");
    expect(issue.map((n) => n.message)).toEqual([expect.stringContaining("「予約を取り消す」"), expect.stringContaining("「追加料金を登録する」")]);
  });

  it("同じ操作で一緒に書く情報は組ごとに 1 件にし、書く操作をすべて添える", () => {
    const co = ofType(createNetshopSample(), "coWritten");
    expect(co).toHaveLength(1);
    expect(co[0]!.message).toBe("「注文」と「購入者」を 「注文を登録する」 が一緒に書きます");
    const hotel = domainNotices(sample()).filter((n) => n.type === "coWritten");
    expect(hotel[0]!.message).toContain("「予約を登録する」「チェックインを記録する」");
  });

  it("情報の名前と同じ語が別のコンテキストの要素に出ていれば問いにする (同じコンテキストは数えない)", () => {
    const homonym = ofType(createNetshopSample(), "homonym");
    const payout = homonym.find((n) => n.message.startsWith("「入金」"))!;
    expect(payout.message).toContain("「入金済」(注文)");
    expect(payout.message).toContain("「入金が確認された」(注文)");
    expect(payout.message).not.toContain("未入金");
    expect(payout.elementIds).toContain("st_ord_paid");
  });
});

describe("イベントまわりの情報", () => {
  it("受け手の無いイベントと、イベントを発生させない書く操作を情報にする (帳票への記入は除く)", () => {
    let m = createNetshopSample();
    const noConsumer = ofType(m, "eventWithoutConsumer");
    expect(noConsumer).toHaveLength(11);
    expect(noConsumer.every((n) => n.level === "info")).toBe(true);
    expect(ofType(m, "commandWithoutEvent")).toEqual([]);
    // 操作のイベントを外すと、その操作だけが「イベントを発生させない書く操作」になる (帳票に記入する操作はもともと出ない)
    const rel = m.relations.find((r) => r.kind === "usecaseEvent" && r.sourceId === "uc_confirm_order")!;
    m = okModel(removeRelation(m, { id: rel.id }));
    const silent = ofType(m, "commandWithoutEvent");
    expect(silent.map((n) => n.elementIds[0])).toEqual(["uc_confirm_order"]);
    expect(silent[0]!.commandKey).toBe("usecase:uc_confirm_order");
  });

  it("イベントが無いモデルでは 1 件にまとめ、少ないモデルでも操作ごとに出さず 1 件にまとめる", () => {
    const none = domainNotices(createAccountingSample());
    expect(none.filter((n) => n.type === "noEvents")).toHaveLength(1);
    expect(none.some((n) => n.type === "commandWithoutEvent" || n.type === "fewEvents" || n.type === "eventWithoutConsumer")).toBe(false);
    const few = domainNotices(createRetailSample());
    expect(few.filter((n) => n.type === "fewEvents").map((n) => n.message)).toEqual([expect.stringContaining("14 件のうち 13 件")]);
    expect(few.some((n) => n.type === "commandWithoutEvent")).toBe(false);
  });

  it("イベントが無く書く操作も無ければ何も出さない", () => {
    let m = createAccountingSample();
    m = { ...m, relations: m.relations.filter((r) => r.kind !== "usecaseInformation") };
    expect(domainNotices(m).some((n) => n.type === "noEvents")).toBe(false);
  });
});

describe("並びとまとめ", () => {
  it("出す順に並び、種類ごとにまとめられる (問いが先)", () => {
    let m = createNetshopSample();
    m = okModel(addElement(m, { kind: "event", name: "受け手の無いイベント", id: "ev_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_confirm_order", targetId: "ev_x" }));
    const notices = domainNotices(m);
    const order = notices.map((n) => DOMAIN_NOTICE_ORDER.indexOf(n.type));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const groups = groupDomainNotices(notices);
    expect(groups[0]!.type).toBe("boundaryStateChange");
    expect(groups.map((g) => g.level)).toEqual([...groups.filter((g) => g.level === "question"), ...groups.filter((g) => g.level === "info")].map((g) => g.level));
    expect(groups.find((g) => g.type === "eventWithoutConsumer")!.notices).toHaveLength(12);
  });
});
