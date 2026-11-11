import { describe, expect, it } from "vitest";
import { createAccountingSample, createHotelSample, createNetshopSample, createRetailSample } from "../../sample";
import { addElement, addRelation } from "../commands";
import { cachedDomainModel, cachedDomainScope } from "../domainCache";
import { buildDomainScope, domainSelectionElementExists, domainSelectionExists, noticesAbout } from "../domainScope";
import { okModel } from "./helpers";

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("システムへのしぼり込み", () => {
  it("対象がそのシステム (直接か、そのシステムの画面) の操作だけをコマンド・クエリにし、作業で分けた候補は操作ごとに代表を 1 つにする", () => {
    const s = buildDomainScope(createNetshopSample(), "sys_oms");
    expect(s.commands.every((c) => c.place?.id === "sys_oms")).toBe(true);
    expect(s.commands).toHaveLength(13);
    expect(new Set(s.commands.map((c) => c.usecase.id)).size).toBe(13);
    // 在庫数を更新する (3 作業)・問い合わせを記録する (3 作業) は表では作業ごとの行
    expect(s.splitCommands).toHaveLength(17);
    expect(names(s.queries.map((q) => q.usecase))).toEqual(["注文を検索する"]);
    // 決済サービスの操作は入らない
    expect(s.commands.some((c) => c.usecase.id === "uc_record_payment")).toBe(false);
  });

  it("イベントは、このシステムが発生させるもの (内) と、別のところで発生してこのシステムの操作のきっかけになるもの (外) に分ける", () => {
    const s = buildDomainScope(createNetshopSample(), "sys_oms");
    const ev = (id: string) => s.events.find((e) => e.row.event.id === id)!;
    expect(ev("ev_order_confirmed").origin).toBe("inside");
    const paid = ev("ev_payment_confirmed");
    expect(paid.origin).toBe("outside");
    expect(names(paid.sources)).toEqual(["決済サービス"]);
    // 内のイベントの受け手のうち、外の操作は対象の名前つき
    const shipped = ev("ev_shipped");
    expect(shipped.outsideConsumers.map((c) => `${c.usecase.name}@${c.place?.name}`)).toEqual(["売掛金を登録する@会計システム"]);
    // 会計システムが出すイベントは入らない
    expect(s.events.some((e) => e.row.event.id === "ev_month_closed")).toBe(false);
    // システムが直接出すイベントは、操作が無くても内 (自社サイトのカート)
    const cart = buildDomainScope(createNetshopSample(), "sys_cart");
    expect(cart.commands).toEqual([]);
    expect(cart.events.map((e) => [e.row.event.name, e.origin])).toEqual([["注文を受け付けた", "inside"]]);
  });

  it("コンテキストは、そのシステムの操作が扱う情報のものだけで、集約はそのシステムで書くか・ほかのところが書くかを持つ", () => {
    const pay = buildDomainScope(createNetshopSample(), "sys_payment");
    expect(pay.contexts.map((c) => c.context?.name)).toEqual(["注文"]);
    const order = pay.contexts[0]!.aggregates.find((a) => a.candidate.information.id === "info_order")!;
    expect(order.writtenHere).toBe(false);
    expect(order.commandsHere).toEqual([]);
    expect(names(order.commandsElsewhere.map((c) => c.usecase))).toEqual(["注文を登録する", "注文を確定する", "注文を取り消す"]);
    expect(names(order.stores)).toEqual(["販売管理システム"]);
    const oms = buildDomainScope(createNetshopSample(), "sys_oms");
    expect(oms.contexts.map((c) => c.context?.name)).toEqual(["注文", "商品・在庫", "顧客", "出荷"]);
    const stock = oms.contexts.find((c) => c.context?.id === "ctx_item")!;
    expect(stock.aggregates.map((a) => [a.candidate.information.name, a.writtenHere])).toEqual([
      ["商品", false],
      ["在庫", true],
    ]);
    // 帳票 (入荷検品表) に書く操作は、ほかのところ
    expect(names(stock.aggregates[1]!.commandsElsewhere.map((c) => c.usecase))).toEqual(["入荷検品表に記入する"]);
    expect(oms.contexts.find((c) => c.context?.id === "ctx_order")!.stateGroups).toEqual(["注文の状態", "返品の状態"]);
  });

  it("気づきは、しぼった操作・情報・イベント・コンテキストのどれかが入っているものだけ", () => {
    const pay = buildDomainScope(createNetshopSample(), "sys_payment");
    expect(pay.notices.some((n) => n.type === "boundaryStateChange" && n.elementIds[0] === "uc_record_payment")).toBe(true);
    // 会計だけの気づき (受け手の無い「売掛金が消し込まれた」) は入らない
    expect(pay.notices.some((n) => n.elementIds.includes("ev_receivable_cleared"))).toBe(false);
    expect(noticesAbout(pay, "uc_record_payment").map((n) => n.type)).toEqual(["boundaryStateChange"]);
  });

  it("システムでない id や、操作の無いシステムでは空", () => {
    const m = createNetshopSample();
    expect(buildDomainScope(m, "nope")).toMatchObject({ commands: [], events: [], contexts: [], terms: [] });
    expect(buildDomainScope(m, "act_pick").commands).toEqual([]);
    const none = okModel(addElement(m, { kind: "system", name: "新しいシステム", id: "sys_new" }));
    expect(buildDomainScope(none, "sys_new")).toMatchObject({ commands: [], queries: [], events: [], contexts: [], notices: [] });
  });

  it("イベントの無いモデルでも、コマンドと集約の候補は出る", () => {
    const s = buildDomainScope(createAccountingSample(), "sys_accounting");
    expect(s.commands.length).toBeGreaterThan(0);
    expect(s.events).toEqual([]);
    expect(s.contexts.length).toBeGreaterThan(0);
  });
});

describe("用語", () => {
  it("しぼった範囲の情報・状態・バリエーション・条件・イベント・操作を、コンテキスト → 種類の順に並べる", () => {
    const s = buildDomainScope(createNetshopSample(), "sys_oms");
    const kinds = s.terms.filter((t) => t.context?.id === "ctx_order").map((t) => t.kind);
    // 種類の順は 情報 → 状態 → バリエーション → 条件 → イベント → 操作
    expect(kinds).toEqual([...kinds].sort((a, b) => ["information", "state", "variation", "condition", "event", "usecase"].indexOf(a) - ["information", "state", "variation", "condition", "event", "usecase"].indexOf(b)));
    expect(s.terms[0]!.element.name).toBe("注文");
    const channel = s.terms.find((t) => t.element.id === "var_channel")!;
    expect(channel.values).toEqual(["自社サイト", "モールA", "モールB"]);
    expect(s.terms.find((t) => t.element.id === "cond_return_period")!.description).toBe("商品が届いてから 8 日以内の申し出だけ受ける。");
    // 同じ語が別のコンテキストに出ている要素に印 (入金済 は 会計の「入金」と)
    expect(s.terms.find((t) => t.element.id === "st_ord_paid")!.homonym).toBe(true);
    expect(s.terms.find((t) => t.element.id === "st_ord_received")!.homonym).toBe(false);
    // 操作は、書く情報のコンテキスト
    expect(s.terms.find((t) => t.element.id === "uc_issue_label")!.context?.name).toBe("出荷");
    expect(new Set(s.terms.map((t) => t.element.id)).size).toBe(s.terms.length);
  });
});

describe("選択と覚えておく結果", () => {
  it("選んでいるものが、しぼった範囲にあるかを返す", () => {
    const s = buildDomainScope(createNetshopSample(), "sys_oms");
    expect(domainSelectionExists(s, { kind: "context", id: "ctx_order" })).toBe(true);
    expect(domainSelectionExists(s, { kind: "context", id: "ctx_accounting" })).toBe(false);
    expect(domainSelectionExists(s, { kind: "context", id: null })).toBe(false);
    expect(domainSelectionExists(s, { kind: "aggregate", id: "info_order" })).toBe(true);
    expect(domainSelectionExists(s, { kind: "aggregate", id: "info_receivable" })).toBe(false);
    expect(domainSelectionExists(s, { kind: "event", id: "ev_payment_confirmed" })).toBe(true);
    expect(domainSelectionExists(s, { kind: "command", id: "uc_confirm_order" })).toBe(true);
    expect(domainSelectionExists(s, { kind: "command", id: "uc_search_order" })).toBe(false);
  });

  it("同じモデル・同じシステムなら同じ結果を使い回し、モデルが変われば作り直す", () => {
    let m = createNetshopSample();
    const a = cachedDomainScope(m, "sys_oms");
    expect(cachedDomainScope(m, "sys_oms")).toBe(a);
    expect(cachedDomainModel(m)).toBe(cachedDomainModel(m));
    m = okModel(addElement(m, { kind: "event", name: "追加のイベント", id: "ev_new" }));
    m = okModel(addRelation(m, { sourceId: "uc_confirm_order", targetId: "ev_new" }));
    const b = cachedDomainScope(m, "sys_oms");
    expect(b).not.toBe(a);
    expect(b.events.some((e) => e.row.event.id === "ev_new")).toBe(true);
  });
});

describe("レビューを受けた振る舞い", () => {
  it("作業で分けたコマンドの代表は、使う作業と担い手を和にする (キーは操作の id)", () => {
    const s = buildDomainScope(createNetshopSample(), "sys_oms");
    const inquiry = s.commands.find((c) => c.usecase.id === "uc_record_inquiry")!;
    expect(inquiry.key).toBe("usecase:uc_record_inquiry");
    expect(inquiry.activity).toBeNull();
    expect(names(inquiry.activities)).toEqual(["問い合わせに答える", "配送状況を調べる", "対応を記録する"]);
    expect(names(inquiry.actors)).toEqual(["カスタマーサポート", "購入者", "配送業者"]);
  });

  it("ほかのシステムでも書く集約は、書くシステムを持つ (帳票は入れない)", () => {
    const hotel = createHotelSample();
    const pms = buildDomainScope(hotel, "sys_pms");
    const bill = pms.contexts.flatMap((c) => c.aggregates).find((a) => a.candidate.information.name === "請求")!;
    expect(bill.writtenHere).toBe(true);
    expect(bill.otherWriterSystems.length).toBeGreaterThanOrEqual(1);
    const oms = buildDomainScope(createNetshopSample(), "sys_oms");
    // 在庫は帳票 (入荷検品表) でも書くが、帳票はシステムではないので入れない
    expect(oms.contexts.flatMap((c) => c.aggregates).find((a) => a.candidate.information.id === "info_stock")!.otherWriterSystems).toEqual([]);
  });

  it("読むだけのコンテキストは上流 (upstream) として後に並べ、関わる業務はこのシステムの操作の作業の業務だけにする", () => {
    const acc = buildDomainScope(createNetshopSample(), "sys_accounting");
    expect(acc.contexts.map((c) => [c.context?.name, c.role])).toEqual([
      ["会計", "own"],
      ["注文", "upstream"],
    ]);
    const order = acc.contexts.find((c) => c.context?.id === "ctx_order")!;
    expect(names(order.businesses)).not.toContain("受注処理");
    const oms = buildDomainScope(createNetshopSample(), "sys_oms");
    expect(oms.contexts.every((c) => c.role === "own")).toBe(true);
  });

  it("内のイベントで、ほかにも発生させるところがあれば添える", () => {
    const oms = buildDomainScope(createNetshopSample(), "sys_oms");
    expect(names(oms.events.find((e) => e.row.event.id === "ev_order_received")!.otherSources)).toEqual(["自社サイトのカート"]);
    expect(oms.events.find((e) => e.row.event.id === "ev_order_confirmed")!.otherSources).toEqual([]);
  });

  it("気づきは主役の要素が範囲にあるものだけ。モデル全体の数の気づきは「モデル全体で」と添える", () => {
    const mall = buildDomainScope(createNetshopSample(), "sys_mall");
    // モールの管理画面は問い合わせ 1 つだけ。ほかのシステムが主役の問いは出さない
    expect(mall.notices.every((n) => n.elementIds[0] === "uc_check_mall_order" || n.elementIds[0] === "info_order" || n.elementIds[0] === "ctx_order")).toBe(true);
    const retail = buildDomainScope(createRetailSample(), "sys_pos");
    const few = retail.notices.find((n) => n.type === "fewEvents")!;
    expect(few.message.startsWith("モデル全体で、")).toBe(true);
  });

  it("選択の要素がモデルにあるか (範囲は見ない)", () => {
    const m = createNetshopSample();
    expect(domainSelectionElementExists(m, { kind: "command", id: "uc_record_payment" })).toBe(true);
    expect(domainSelectionElementExists(m, { kind: "aggregate", id: "uc_record_payment" })).toBe(false);
    expect(domainSelectionElementExists(m, { kind: "context", id: null })).toBe(true);
    expect(domainSelectionElementExists(m, { kind: "event", id: "nope" })).toBe(false);
    const oms = buildDomainScope(m, "sys_oms");
    expect(domainSelectionExists(oms, { kind: "query", id: "uc_search_order" })).toBe(true);
    expect(domainSelectionExists(oms, { kind: "query", id: "uc_confirm_order" })).toBe(false);
  });
});
