import { describe, expect, it } from "vitest";
import { createAccountingSample, createNetshopSample, createRetailSample } from "../../sample";
import { addElement, addRelation, setRelationAccess } from "../commands";
import { commandKey, deriveDomainModel, stateGroupOwners, stateGroupSubject } from "../domainModel";
import { okModel, sample } from "./helpers";

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("コマンド候補", () => {
  it("情報を書く (write か省略) 操作をコマンド候補にし、読むだけの操作はクエリ候補にする", () => {
    const d = deriveDomainModel(createNetshopSample());
    const cmd = d.commands.find((c) => c.usecase.id === "uc_confirm_order")!;
    expect(cmd.key).toBe(commandKey("uc_confirm_order"));
    expect(names(cmd.writes)).toEqual(["注文"]);
    expect(names(cmd.actors)).toEqual(["受注担当"]);
    expect(names(cmd.preStates)).toEqual(["受付済"]);
    expect(names(cmd.postStates)).toEqual(["確定"]);
    expect(names(cmd.events)).toEqual(["注文が確定した"]);
    expect(cmd.place?.name).toBe("販売管理システム");
    expect(cmd.aggregate?.name).toBe("注文");
    expect(cmd.auto).toBe(false);
    expect(cmd.readOnly).toBe(false);
    // 読むだけでイベントも状態の遷移も無い操作はコマンドにならず、クエリ候補 (純粋な問い合わせ) になる
    expect(d.commands.some((c) => c.usecase.id === "uc_search_order")).toBe(false);
    const q = d.queries.find((q) => q.usecase.id === "uc_search_order")!;
    expect(q.screen?.name).toBe("受注一覧");
    expect(names(q.reads)).toEqual(["注文", "出荷"]);
    expect(q.activities.length).toBe(4);
    expect(q.place?.name).toBe("販売管理システム");
    expect(names(d.queries.map((q) => q.usecase))).toEqual(["モールの注文を確認する", "注文を検索する", "損益計算書を見る", "貸借対照表を見る"]);
  });

  it("読むだけでもイベントを発生させる・状態を変える操作はコマンド候補 (readOnly) にし、集約は変える状態グループの持ち主にする", () => {
    const d = deriveDomainModel(createNetshopSample());
    const pay = d.commands.find((c) => c.usecase.id === "uc_record_payment")!;
    expect(pay.readOnly).toBe(true);
    expect(pay.writes).toEqual([]);
    expect(names(pay.reads)).toEqual(["注文"]);
    expect(names(pay.postStates)).toEqual(["入金済"]);
    expect(names(pay.events)).toEqual(["入金が確認された"]);
    expect(pay.aggregate?.name).toBe("注文");
    expect(pay.place?.name).toBe("決済サービス");
    const pick = d.commands.find((c) => c.usecase.id === "uc_issue_pick_list")!;
    expect(pick.readOnly).toBe(true);
    expect(pick.aggregate).toBeNull();
    expect(names(pick.events)).toEqual(["ピッキングの指示が出た"]);
    expect(d.queries.some((q) => q.usecase.id === "uc_record_payment" || q.usecase.id === "uc_issue_pick_list")).toBe(false);
  });

  it("作業に属さず、きっかけのイベントがある操作は自動で、担当は空。作業にもきっかけにも結んでいない操作は自動にしない", () => {
    let m = createNetshopSample();
    const auto = deriveDomainModel(m).commands.find((c) => c.usecase.id === "uc_allocate_stock")!;
    expect(auto.auto).toBe(true);
    expect(auto.actors).toEqual([]);
    expect(names(auto.triggeredBy)).toEqual(["注文が確定した"]);
    expect(names(auto.conditions)).toEqual(["在庫が足りない"]);
    m = okModel(addElement(m, { kind: "usecase", name: "書きかけの操作", id: "uc_draft" }));
    m = okModel(addRelation(m, { sourceId: "uc_draft", targetId: "info_order" }));
    const draft = deriveDomainModel(m).commands.find((c) => c.usecase.id === "uc_draft")!;
    expect(draft.auto).toBe(false);
    expect(draft.activities).toEqual([]);
  });

  it("複数の作業が使う操作は、作業ごとの候補に分ける (意図が違いうる)", () => {
    const d = deriveDomainModel(createNetshopSample());
    const split = d.commands.filter((c) => c.usecase.id === "uc_update_stock");
    expect(split.map((c) => c.key)).toEqual([
      commandKey("uc_update_stock", "act_shelve"),
      commandKey("uc_update_stock", "act_update_stock"),
      commandKey("uc_update_stock", "act_restock"),
    ]);
    expect(split.every((c) => c.activity && c.activities.length === 1)).toBe(true);
    // 1 つの作業だけが使う操作は分けない
    expect(d.commands.filter((c) => c.usecase.id === "uc_confirm_order")).toHaveLength(1);
  });

  it("集約の候補は、書く情報のうち状態グループの持ち主を優先する", () => {
    const d = deriveDomainModel(createNetshopSample());
    const reg = d.commands.find((c) => c.usecase.id === "uc_register_order")!;
    expect(names(reg.writes)).toEqual(["注文", "購入者"]);
    expect(reg.aggregate?.name).toBe("注文");
  });
});

describe("状態グループの持ち主", () => {
  it("名前の合う情報か、次の状態へ遷移させる操作が最も多く書く情報を持ち主にし、同数なら決めない", () => {
    const groups = stateGroupOwners(createNetshopSample());
    const order = groups.find((g) => g.group === "注文の状態")!;
    expect(order.owner?.name).toBe("注文");
    expect(order.candidates.map((c) => `${c.information.name}:${c.count}`)).toEqual(["注文:3", "購入者:1", "出荷:1"]);
    // 「実行できる状態」(stateUsecase) だけの操作は数えない (在庫を引き当てるは確定で実行できるが、注文の状態を変えない)
    expect(names(order.usecases)).not.toContain("在庫を引き当てる");
    const retail = stateGroupOwners(createRetailSample());
    // 書く回数は「発注」「入荷」で同数だが、グループの名前に合う「発注」が持ち主
    const purchase = retail.find((g) => g.group === "発注の状態")!;
    expect(purchase.candidates.map((c) => `${c.information.name}:${c.count}`)).toEqual(["発注:1", "入荷:1"]);
    expect(purchase.owner?.name).toBe("発注");
    // 名前の合う情報が無く、書く回数も同数なら、決めない
    expect(retail.find((g) => g.group === "1 日の締めの状態")!.owner).toBeNull();
    expect(stateGroupSubject("部屋状態")).toBe("部屋");
    expect(stateGroupSubject(" 注文のステータス ")).toBe("注文");
    expect(retail.find((g) => g.group === "売掛金の状態")!.owner?.name).toBe("売掛金");
  });
});

describe("ドメインイベントとポリシー", () => {
  it("イベントごとに発生元・属性候補 (発生元が書く情報)・受け手を集め、タイミングのあるものは時間のイベントにする", () => {
    const d = deriveDomainModel(createNetshopSample());
    const row = (id: string) => d.events.find((e) => e.event.id === id)!;
    expect(names(row("ev_order_confirmed").usecases)).toEqual(["注文を確定する"]);
    expect(names(row("ev_order_confirmed").properties)).toEqual(["注文"]);
    expect(names(row("ev_order_confirmed").consumers.usecases)).toEqual(["在庫を引き当てる"]);
    expect(row("ev_order_confirmed").context?.name).toBe("注文");
    // 不定期 (adhoc。Webhook など外からの呼び出し) は時間のイベントにしない。定期 (scheduled) だけ
    expect(row("ev_payment_confirmed").timed).toBe(false);
    expect(deriveDomainModel(sample()).events.find((e) => e.event.id === "ev_checkout_day")!.timed).toBe(true);
    expect(names(row("ev_month_closed").systems)).toEqual(["会計システム"]);
    expect(names(row("ev_received").consumers.activities)).toEqual(["商品を棚に収める"]);
    expect(row("ev_stock_changed").consumers).toEqual({ usecases: [], activities: [] });
  });

  it("イベント → 操作をポリシー候補にし、自動かどうかとコンテキストをまたぐかを添える", () => {
    const d = deriveDomainModel(createNetshopSample());
    const pol = (event: string, usecase: string) => d.policies.find((p) => p.event.name === event && p.usecase.name === usecase)!;
    expect(pol("注文が確定した", "在庫を引き当てる")).toMatchObject({ auto: true, crossesContext: true });
    expect(pol("出荷が記録された", "売掛金を登録する")).toMatchObject({ auto: true, crossesContext: true });
    const human = pol("返品を受け付けた", "返品の検品結果を記録する");
    expect(human.auto).toBe(false);
    expect(names(human.activities)).toEqual(["返品を検品する"]);
    expect(human.crossesContext).toBe(false);
    expect(d.policies).toHaveLength(7);
    expect(deriveDomainModel(createAccountingSample()).policies).toEqual([]);
  });
});

describe("集約候補とコンテキスト候補", () => {
  it("状態を持つ情報はルート候補、書かれる情報は集約候補、書かれない情報は参照データにする", () => {
    const d = deriveDomainModel(createNetshopSample());
    const agg = (name: string) => d.aggregates.find((a) => a.information.name === name)!;
    expect(agg("注文")).toMatchObject({ role: "lifecycle", stateGroups: ["注文の状態"] });
    expect(names(agg("注文").states)).toEqual(["受付済", "確定", "入金済", "出荷済", "取消"]);
    expect(names(agg("注文").coWritten)).toEqual(["購入者"]);
    expect(names(agg("注文").related)).toContain("出荷");
    expect(agg("在庫")).toMatchObject({ role: "written", stateGroups: [] });
    expect(names(agg("在庫").commands.map((c) => c.usecase))).toContain("在庫を引き当てる");
    expect(agg("商品")).toMatchObject({ role: "reference" });
    expect(agg("商品").commands).toEqual([]);
  });

  it("分析のコンテキストごとに所属要素・状態グループ・関わる業務を集め、未分類は入るものがあるときだけ出す", () => {
    let m = createNetshopSample();
    let d = deriveDomainModel(m);
    const order = d.contexts.find((c) => c.context?.id === "ctx_order")!;
    expect(order.stateGroups).toEqual(["注文の状態", "返品の状態"]);
    expect(names(order.informations)).toEqual(["注文", "返品"]);
    expect(names(order.businesses)).toEqual(["受注処理", "出荷", "返品・交換", "問い合わせ対応"]);
    expect(names(order.aggregates.map((a) => a.information))).toEqual(["注文", "返品"]);
    expect(d.contexts.some((c) => c.context === null)).toBe(false);
    m = okModel(addElement(m, { kind: "information", name: "未分類の情報", id: "info_x" }));
    d = deriveDomainModel(m);
    const none = d.contexts.find((c) => c.context === null)!;
    expect(names(none.informations)).toEqual(["未分類の情報"]);
    expect(none.aggregates[0]!.role).toBe("reference");
  });

  it("access を変えると候補も変わる (書くのをやめれば readOnly のコマンド候補か、クエリ候補になる)", () => {
    let m = sample();
    expect(deriveDomainModel(m).commands.find((c) => c.usecase.id === "uc_register_reservation")!.readOnly).toBe(false);
    for (const r of m.relations.filter((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_register_reservation")) {
      m = okModel(setRelationAccess(m, { id: r.id, access: "read" }));
    }
    // 予約を登録する は次の状態 (受付済) へ遷移させるので、書かなくてもコマンド候補のまま (readOnly)
    const d = deriveDomainModel(m);
    expect(d.commands.find((c) => c.usecase.id === "uc_register_reservation")!.readOnly).toBe(true);
    expect(d.queries.some((q) => q.usecase.id === "uc_register_reservation")).toBe(false);
    // 状態の遷移も外せばクエリ候補になる
    m = { ...m, relations: m.relations.filter((r) => !(r.kind === "usecaseState" && r.sourceId === "uc_register_reservation")) };
    const d2 = deriveDomainModel(m);
    expect(d2.commands.some((c) => c.usecase.id === "uc_register_reservation")).toBe(false);
    expect(d2.queries.some((q) => q.usecase.id === "uc_register_reservation")).toBe(true);
  });

  it("同じ操作が同じ情報を 2 本の関係で持っていても 1 つに数える (同時編集の合流で起きうる)", () => {
    let m = createNetshopSample();
    const dup = m.relations.find((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_confirm_order")!;
    m = { ...m, relations: [...m.relations, { ...dup, id: "rel_dup" }, { ...dup, id: "rel_dup2", access: "read" }] };
    const d = deriveDomainModel(m);
    const cmd = d.commands.find((c) => c.usecase.id === "uc_confirm_order")!;
    expect(names(cmd.writes)).toEqual(["注文"]);
    expect(names(cmd.reads)).toEqual(["注文"]);
    // 一緒に書かれる情報にも重複が出ない (注文を登録する の 購入者 だけ)
    expect(names(d.aggregates.find((a) => a.information.id === "info_order")!.coWritten)).toEqual(["購入者"]);
  });

  it("画面のシステムが無い操作は対象なしになり、落ちない", () => {
    let m = createNetshopSample();
    m = { ...m, elements: m.elements.filter((e) => e.id !== "sys_payment") };
    const d = deriveDomainModel(m);
    expect(d.commands.find((c) => c.usecase.id === "uc_record_payment")!.place).toBeNull();
  });

  it("1 つの情報が 2 つの状態グループの持ち主なら、両方を集約候補に持つ", () => {
    let m = createNetshopSample();
    m = okModel(addElement(m, { kind: "state", name: "請求済", id: "st_billed", init: { group: "請求の状態", contextId: "ctx_order" } }));
    m = okModel(addRelation(m, { sourceId: "uc_confirm_order", targetId: "st_billed" }));
    const agg = deriveDomainModel(m).aggregates.find((a) => a.information.id === "info_order")!;
    expect(agg.stateGroups).toEqual(["注文の状態", "請求の状態"]);
    expect(names(agg.states)).toContain("請求済");
  });

  it("存在しない要素を指す関係があっても落ちない", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "event", name: "x", id: "ev_x" }));
    m = okModel(addRelation(m, { sourceId: "ev_x", targetId: "uc_register_reservation" }));
    m = { ...m, elements: m.elements.filter((e) => e.id !== "ev_x") };
    const d = deriveDomainModel(m);
    expect(d.policies.some((p) => p.event.id === "ev_x")).toBe(false);
    expect(d.commands.find((c) => c.usecase.id === "uc_register_reservation")!.triggeredBy).toEqual([]);
  });
});
