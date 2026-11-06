// 架空の日用品店 (駅前の 1 店舗。本部が発注の基準を出す) のサンプルモデル。実在の店・データは使わない。
// 発注・入荷・陳列・レジ・レジ締め・棚卸の流れと、現場の困りごとを置く。
import { relationKindFor } from "../model/relations";
import { MODEL_VERSION, type BoardNode, type Element, type Relation, type UntieModel } from "../model/types";

// ---------------------------------------------------------------- 要素

const actors: Element[] = [
  { id: "actor_manager", kind: "actor", name: "店長" },
  { id: "actor_cashier", kind: "actor", name: "レジ担当" },
  { id: "actor_floor", kind: "actor", name: "売場担当" },
  { id: "actor_backyard", kind: "actor", name: "バックヤード担当" },
  // 本部の担当者。店の外にいるが、同じ会社の人 (外部アクターではない)
  { id: "actor_hq_purchase", kind: "actor", name: "本部の仕入担当" },
  { id: "actor_hq_accounting", kind: "actor", name: "本部の経理担当" },
];

const externalActors: Element[] = [
  { id: "ext_shopper", kind: "externalActor", name: "来店客" },
  { id: "ext_supplier", kind: "externalActor", name: "仕入先" },
];

/** システム (自社・社外を問わない。作業の担当にも、情報の置き場所にもなる) と、紙の帳票 (情報の置き場所) */
const systems: Element[] = [
  { id: "sys_pos", kind: "system", name: "POSレジ" },
  { id: "sys_terminal", kind: "system", name: "決済端末" },
  { id: "sys_ordering", kind: "system", name: "本部の発注システム" },
  { id: "sys_accounting", kind: "system", name: "会計システム" },
  { id: "ldg_receiving_slip", kind: "ledger", name: "納品書・検品票" },
  { id: "ldg_closing_sheet", kind: "ledger", name: "レジ締め表" },
  { id: "ldg_stocktake_sheet", kind: "ledger", name: "棚卸表" },
];

const businessDefs: [id: string, name: string][] = [
  ["biz_purchase", "発注・入荷"],
  ["biz_display", "陳列・在庫管理"],
  ["biz_register", "レジ・接客"],
  ["biz_closing", "レジ締め・売上報告"],
  ["biz_stocktake", "棚卸"],
  ["biz_receivable", "売掛金・入金管理"],
  ["biz_monthly", "月次の数字の確認"],
];

const businesses: Element[] = businessDefs.map(([id, name]) => ({ id, kind: "business", name }));

/** 業務ごとの既定 BUC (名前は業務名と同じ) */
const defaultBucs: Element[] = businessDefs.map(([id, name]) => ({
  id: `buc_default_${id.replace("biz_", "")}`,
  kind: "buc",
  name,
  businessId: id,
  isDefault: true,
}));

const bucs: Element[] = [
  { id: "buc_checkout", kind: "buc", name: "会計", businessId: "biz_register", isDefault: false },
  { id: "buc_return", kind: "buc", name: "返品・交換", businessId: "biz_register", isDefault: false },
  { id: "buc_special", kind: "buc", name: "お取り寄せ", businessId: "biz_register", isDefault: false },
];

const dflt = (bizId: string) => `buc_default_${bizId.replace("biz_", "")}`;

const activities: Element[] = [
  { id: "act_decide_qty", kind: "activity", name: "発注数を決める", bucId: dflt("biz_purchase"), hours: 0.5 },
  { id: "act_place_order", kind: "activity", name: "発注する", bucId: dflt("biz_purchase") },
  { id: "act_receive", kind: "activity", name: "入荷を検品する", bucId: dflt("biz_purchase") },
  { id: "act_record_receiving", kind: "activity", name: "検品の結果を記録する", bucId: dflt("biz_purchase") },
  { id: "act_display", kind: "activity", name: "商品を陳列する", bucId: dflt("biz_display") },
  { id: "act_price", kind: "activity", name: "売価・値札を直す", bucId: dflt("biz_display") },
  { id: "act_check_shelf", kind: "activity", name: "棚の在庫を確認する", bucId: dflt("biz_display") },
  { id: "act_markdown", kind: "activity", name: "売れ残りを値引き・廃棄する", bucId: dflt("biz_display") },
  { id: "act_scan", kind: "activity", name: "商品を読み取る", bucId: "buc_checkout" },
  { id: "act_payment", kind: "activity", name: "代金を受け取る", bucId: "buc_checkout" },
  { id: "act_return", kind: "activity", name: "返品・交換に応じる", bucId: "buc_return" },
  { id: "act_special", kind: "activity", name: "お取り寄せを受ける", bucId: "buc_special" },
  { id: "act_count_cash", kind: "activity", name: "現金を数える", bucId: dflt("biz_closing"), hours: 0.2 },
  { id: "act_reconcile", kind: "activity", name: "売上と現金を突き合わせる", bucId: dflt("biz_closing"), hours: 0.5 },
  {
    id: "act_report_sales",
    kind: "activity",
    name: "売上を本部へ報告する",
    bucId: dflt("biz_closing"),
    // 架空のマニュアル (example.com はリンクの例示用ドメイン)
    links: [
      { title: "日次報告の手順", url: "https://example.com/manual/daily-report" },
      { title: "報告の締め時間", url: "https://example.com/manual/report-deadline" },
    ],
  },
  { id: "act_deposit", kind: "activity", name: "売上金を保管・入金する", bucId: dflt("biz_closing") },
  { id: "act_stocktake", kind: "activity", name: "棚卸をする", bucId: dflt("biz_stocktake"), hours: 2 },
  { id: "act_apply_count", kind: "activity", name: "実在庫を帳簿に反映する", bucId: dflt("biz_stocktake") },
  { id: "act_review_stock", kind: "activity", name: "欠品・過剰在庫を確認する", bucId: dflt("biz_stocktake") },
  // 本部の会計システムが担当する。クレジットカードや電子マネーの売上は、あとから決済会社がまとめて振り込む (その間は売掛金)
  { id: "act_book_receivable", kind: "activity", name: "売掛金を計上する", bucId: dflt("biz_receivable") },
  { id: "act_manage_settlement", kind: "activity", name: "入金を管理する", bucId: dflt("biz_receivable") },
  { id: "act_clear_receivable", kind: "activity", name: "入金を消し込む", bucId: dflt("biz_receivable"), hours: 0.4 },
  // 本部の会計システムで、損益計算書 (PL) と貸借対照表 (BS) を見る
  { id: "act_review_pl", kind: "activity", name: "損益を確認する", bucId: dflt("biz_monthly") },
  { id: "act_review_bs", kind: "activity", name: "財務の状況を確認する", bucId: dflt("biz_monthly") },
];

const usecases: Element[] = [
  { id: "uc_register_order", kind: "usecase", name: "発注を登録する" },
  { id: "uc_register_receiving", kind: "usecase", name: "入荷を登録する" },
  { id: "uc_search_item", kind: "usecase", name: "商品と在庫を検索する", hours: 0.1 },
  { id: "uc_change_price", kind: "usecase", name: "売価を変更する" },
  { id: "uc_record_disposal", kind: "usecase", name: "値引き・廃棄を記録する" },
  { id: "uc_register_sale", kind: "usecase", name: "売上を登録する" },
  { id: "uc_record_payment", kind: "usecase", name: "支払を記録する" },
  { id: "uc_register_return", kind: "usecase", name: "返品・交換を登録する" },
  { id: "uc_register_special", kind: "usecase", name: "取り寄せを登録する" },
  { id: "uc_record_cash", kind: "usecase", name: "現金の実際の額を記録する", hours: 0.1 },
  {
    id: "uc_issue_daily_report",
    kind: "usecase",
    name: "日次の売上を出力する",
    links: [{ title: "POSレジ操作手順 (日次の締め)", url: "https://example.com/manual/pos-closing" }],
  },
  { id: "uc_send_report", kind: "usecase", name: "売上を本部へ送る" },
  { id: "uc_record_deposit", kind: "usecase", name: "入金を記録する" },
  { id: "uc_record_stocktake", kind: "usecase", name: "棚卸の数を記録する" },
  { id: "uc_adjust_stock", kind: "usecase", name: "在庫を調整する" },
  { id: "uc_register_receivable", kind: "usecase", name: "売掛金を登録する" },
  { id: "uc_record_settlement", kind: "usecase", name: "入金を登録する" },
  { id: "uc_clear_receivable", kind: "usecase", name: "売掛金を消し込む" },
  { id: "uc_view_pl", kind: "usecase", name: "損益計算書を見る" },
  { id: "uc_view_bs", kind: "usecase", name: "貸借対照表を見る" },
];

/** 役割の同じ情報と、それに関係の深い状態・条件・バリエーションをまとめる親カテゴリ */
const contexts: Element[] = [
  { id: "ctx_item", kind: "context", name: "商品・在庫" },
  { id: "ctx_purchase", kind: "context", name: "発注・入荷" },
  { id: "ctx_sales", kind: "context", name: "売上" },
  { id: "ctx_accounting", kind: "context", name: "会計" },
];

const informations: Element[] = [
  { id: "info_item", kind: "information", name: "商品", contextId: "ctx_item" },
  { id: "info_stock", kind: "information", name: "在庫", contextId: "ctx_item" },
  { id: "info_stocktake", kind: "information", name: "棚卸の結果", contextId: "ctx_item" },
  { id: "info_order", kind: "information", name: "発注", contextId: "ctx_purchase" },
  { id: "info_receiving", kind: "information", name: "入荷", contextId: "ctx_purchase" },
  { id: "info_sale", kind: "information", name: "売上", contextId: "ctx_sales" },
  { id: "info_payment", kind: "information", name: "現金・支払", contextId: "ctx_sales" },
  { id: "info_receivable", kind: "information", name: "売掛金", contextId: "ctx_accounting" },
  { id: "info_settlement", kind: "information", name: "入金", contextId: "ctx_accounting" },
  { id: "info_pl", kind: "information", name: "損益計算書 (PL)", contextId: "ctx_accounting" },
  { id: "info_bs", kind: "information", name: "貸借対照表 (BS)", contextId: "ctx_accounting" },
];

const states: Element[] = [
  { id: "st_po_placed", kind: "state", name: "発注済", group: "発注の状態", contextId: "ctx_purchase" },
  { id: "st_po_received", kind: "state", name: "入荷済", group: "発注の状態", contextId: "ctx_purchase" },
  { id: "st_po_shortage", kind: "state", name: "数が足りない", group: "発注の状態", contextId: "ctx_purchase" },
  { id: "st_day_open", kind: "state", name: "営業中", group: "1 日の締めの状態", contextId: "ctx_sales" },
  { id: "st_day_counted", kind: "state", name: "現金確認済", group: "1 日の締めの状態", contextId: "ctx_sales" },
  { id: "st_day_reconciled", kind: "state", name: "突き合わせ済", group: "1 日の締めの状態", contextId: "ctx_sales" },
  { id: "st_day_reported", kind: "state", name: "報告済", group: "1 日の締めの状態", contextId: "ctx_sales" },
  { id: "st_day_deposited", kind: "state", name: "入金済", group: "1 日の締めの状態", contextId: "ctx_sales" },
  { id: "st_rec_open", kind: "state", name: "未入金", group: "売掛金の状態", contextId: "ctx_accounting" },
  { id: "st_rec_partial", kind: "state", name: "一部入金", group: "売掛金の状態", contextId: "ctx_accounting" },
  { id: "st_rec_cleared", kind: "state", name: "消込済", group: "売掛金の状態", contextId: "ctx_accounting" },
];

const variations: Element[] = [
  { id: "var_payment_method", kind: "variation", name: "支払方法", values: ["現金", "クレジットカード", "電子マネー"], contextId: "ctx_sales" },
  { id: "var_category", kind: "variation", name: "商品区分", values: ["日用品", "食品", "雑貨"], contextId: "ctx_item" },
  { id: "var_order_type", kind: "variation", name: "発注の種類", values: ["定番品", "特売品", "新商品"], contextId: "ctx_purchase" },
];

const conditions: Element[] = [
  { id: "cond_low_stock", kind: "condition", name: "棚の在庫が少ない", description: "発注点を下回っている。", contextId: "ctx_item" },
  { id: "cond_receipt", kind: "condition", name: "レシートがある", description: "返品・交換は、レシートがあるときだけ受ける。", contextId: "ctx_sales" },
  { id: "cond_difference", kind: "condition", name: "売上と現金にずれがある", description: "ずれがあれば、原因を調べてから報告する。", contextId: "ctx_sales" },
];

const issues: Element[] = [
  {
    id: "issue_closing_gap",
    kind: "issue",
    name: "レジ締めの金額が合わず、原因探しに毎晩時間がかかる",
    description: "閉店後に、POSレジの売上と数えた現金が 1 円単位で合わない日が週に何度もある。",
    severity: 5,
    targetIds: ["biz_closing", "act_reconcile"],
    analysis: {
      phenomenon: "閉店後にレジ担当が現金を数え、POSレジの売上と合わせている。週に 3 日ほど数百円から数千円のずれが出て、原因を探すのに 30 分から 1 時間かかる。",
      location: "レジ締め・売上報告の「売上と現金を突き合わせる」。返品や値引きの訂正が、POSレジではなく紙のレシートの裏に書かれている。",
      cause: "返品・値引き・釣り銭の出し入れの記録がレジの操作ごとに残らず、ずれたときに手がかりが無い。担当によって準備金の扱いも違う。",
      impact: "退勤が遅れて残業になる。原因が分からないまま「過不足」として処理する日があり、本部への報告も遅れる。",
    },
  },
  {
    id: "issue_stock_gap",
    kind: "issue",
    name: "帳簿の在庫と実際の在庫がずれて、欠品や過剰在庫になる",
    description: "棚卸のたびに差が出るが、どの作業で生まれたのかが分からない。",
    severity: 4,
    targetIds: ["biz_stocktake", "act_apply_count"],
  },
  {
    id: "issue_order_guess",
    kind: "issue",
    name: "発注数を店長の経験で決めていて、欠品と売れ残りが両方出る",
    severity: 4,
    targetIds: ["biz_purchase", "act_decide_qty"],
  },
  {
    id: "issue_hq_report",
    kind: "issue",
    name: "本部への連絡が電話とメールに分かれている",
    severity: 3,
    targetIds: ["act_report_sales", "uc_send_report"],
  },
  {
    id: "issue_evening_work",
    kind: "issue",
    name: "夕方に値引きと値札の貼り替えが重なり、人手が足りない",
    severity: 2,
    targetIds: ["act_markdown", "act_price"],
  },
];

// ---------------------------------------------------------------- 関係

const pairs: [source: string, target: string][] = [
  // actorBusiness
  ["actor_manager", "biz_purchase"],
  ["actor_floor", "biz_display"],
  ["actor_cashier", "biz_register"],
  ["actor_cashier", "biz_closing"],
  ["actor_floor", "biz_stocktake"],
  ["actor_manager", "biz_monthly"],
  ["actor_hq_accounting", "biz_receivable"],
  // actorActivity
  ["actor_manager", "act_decide_qty"],
  ["actor_hq_purchase", "act_decide_qty"],
  ["actor_manager", "act_place_order"],
  ["sys_ordering", "act_place_order"],
  ["actor_backyard", "act_receive"],
  ["ext_supplier", "act_receive"],
  ["actor_backyard", "act_record_receiving"],
  ["actor_floor", "act_display"],
  ["actor_floor", "act_price"],
  ["actor_floor", "act_check_shelf"],
  ["actor_floor", "act_markdown"],
  ["actor_manager", "act_markdown"],
  ["actor_cashier", "act_scan"],
  ["sys_pos", "act_scan"],
  ["ext_shopper", "act_scan"],
  ["actor_cashier", "act_payment"],
  ["sys_terminal", "act_payment"],
  ["ext_shopper", "act_payment"],
  ["actor_cashier", "act_return"],
  ["actor_manager", "act_return"],
  ["ext_shopper", "act_return"],
  ["actor_cashier", "act_special"],
  ["ext_shopper", "act_special"],
  ["actor_hq_purchase", "act_special"],
  ["actor_cashier", "act_count_cash"],
  ["actor_cashier", "act_reconcile"],
  ["sys_pos", "act_reconcile"],
  ["actor_manager", "act_report_sales"],
  ["actor_hq_purchase", "act_report_sales"],
  ["actor_manager", "act_deposit"],
  ["actor_floor", "act_stocktake"],
  ["actor_backyard", "act_stocktake"],
  // システムが担当する作業 (自動で行う)
  ["sys_pos", "act_apply_count"],
  ["actor_manager", "act_apply_count"],
  ["actor_manager", "act_review_stock"],
  ["sys_accounting", "act_book_receivable"],
  ["sys_accounting", "act_manage_settlement"],
  ["actor_hq_accounting", "act_manage_settlement"],
  ["sys_terminal", "act_manage_settlement"],
  ["sys_accounting", "act_clear_receivable"],
  ["actor_hq_accounting", "act_clear_receivable"],
  ["actor_manager", "act_review_pl"],
  ["actor_hq_accounting", "act_review_pl"],
  ["actor_manager", "act_review_bs"],
  ["actor_hq_accounting", "act_review_bs"],
  // activityUsecase
  ["act_decide_qty", "uc_search_item"],
  ["act_place_order", "uc_register_order"],
  ["act_receive", "uc_register_receiving"],
  ["act_record_receiving", "uc_register_receiving"],
  ["act_price", "uc_change_price"],
  ["act_check_shelf", "uc_search_item"],
  ["act_markdown", "uc_record_disposal"],
  ["act_scan", "uc_register_sale"],
  ["act_payment", "uc_record_payment"],
  ["act_return", "uc_register_return"],
  ["act_special", "uc_register_special"],
  ["act_count_cash", "uc_record_cash"],
  ["act_reconcile", "uc_issue_daily_report"],
  ["act_report_sales", "uc_send_report"],
  ["act_deposit", "uc_record_deposit"],
  ["act_stocktake", "uc_record_stocktake"],
  ["act_apply_count", "uc_adjust_stock"],
  ["act_review_stock", "uc_search_item"],
  ["act_book_receivable", "uc_register_receivable"],
  ["act_manage_settlement", "uc_record_settlement"],
  ["act_clear_receivable", "uc_clear_receivable"],
  ["act_review_pl", "uc_view_pl"],
  ["act_review_bs", "uc_view_bs"],
  // usecaseInformation
  ["uc_register_order", "info_order"],
  ["uc_register_order", "info_item"],
  ["uc_register_receiving", "info_receiving"],
  ["uc_register_receiving", "info_order"],
  ["uc_register_receiving", "info_stock"],
  ["uc_search_item", "info_item"],
  ["uc_search_item", "info_stock"],
  ["uc_change_price", "info_item"],
  ["uc_record_disposal", "info_stock"],
  ["uc_record_disposal", "info_item"],
  ["uc_register_sale", "info_sale"],
  ["uc_register_sale", "info_item"],
  ["uc_register_sale", "info_stock"],
  ["uc_record_payment", "info_payment"],
  ["uc_record_payment", "info_sale"],
  ["uc_register_return", "info_sale"],
  ["uc_register_return", "info_stock"],
  ["uc_register_special", "info_order"],
  ["uc_register_special", "info_item"],
  ["uc_record_cash", "info_payment"],
  ["uc_issue_daily_report", "info_sale"],
  ["uc_issue_daily_report", "info_payment"],
  ["uc_send_report", "info_sale"],
  ["uc_record_deposit", "info_payment"],
  ["uc_record_stocktake", "info_stocktake"],
  ["uc_record_stocktake", "info_stock"],
  ["uc_adjust_stock", "info_stock"],
  ["uc_adjust_stock", "info_stocktake"],
  ["uc_register_receivable", "info_receivable"],
  ["uc_register_receivable", "info_sale"],
  ["uc_record_settlement", "info_settlement"],
  ["uc_clear_receivable", "info_receivable"],
  ["uc_clear_receivable", "info_settlement"],
  ["uc_view_pl", "info_pl"],
  ["uc_view_bs", "info_bs"],
  // usecaseCondition
  ["uc_register_order", "cond_low_stock"],
  ["uc_register_return", "cond_receipt"],
  ["uc_record_cash", "cond_difference"],
  // informationRelated (無向)
  ["info_item", "info_stock"],
  ["info_order", "info_item"],
  ["info_receiving", "info_order"],
  ["info_sale", "info_item"],
  ["info_payment", "info_sale"],
  ["info_stocktake", "info_stock"],
  ["info_receivable", "info_sale"],
  ["info_settlement", "info_receivable"],
  // 売上は PL の収益、売掛金は BS の資産
  ["info_pl", "info_sale"],
  ["info_bs", "info_receivable"],
  ["info_pl", "info_bs"],
  // systemInformation (システム → 情報: 取得元)
  ["sys_pos", "info_item"],
  ["sys_pos", "info_stock"],
  ["sys_pos", "info_sale"],
  ["sys_pos", "info_payment"],
  ["sys_ordering", "info_order"],
  ["sys_terminal", "info_payment"],
  ["sys_accounting", "info_receivable"],
  ["sys_accounting", "info_settlement"],
  ["sys_terminal", "info_settlement"],
  // 会計システムで PL と BS を見られる
  ["sys_accounting", "info_pl"],
  ["sys_accounting", "info_bs"],
  // informationSystem (情報 → システム: 保存先)
  ["info_item", "sys_pos"],
  ["info_stock", "sys_pos"],
  ["info_sale", "sys_pos"],
  ["info_sale", "sys_accounting"],
  ["info_order", "sys_ordering"],
  ["info_receiving", "ldg_receiving_slip"],
  ["info_payment", "ldg_closing_sheet"],
  ["info_stocktake", "ldg_stocktake_sheet"],
  ["info_receivable", "sys_accounting"],
  ["info_settlement", "sys_accounting"],
  // informationVariation
  ["info_payment", "var_payment_method"],
  ["info_item", "var_category"],
  ["info_order", "var_order_type"],
  // conditionVariation
  ["cond_low_stock", "var_category"],
  // conditionState
  ["cond_low_stock", "st_po_placed"],
  ["cond_receipt", "st_day_open"],
  ["cond_difference", "st_day_counted"],
  // stateUsecase
  ["st_po_placed", "uc_register_receiving"],
  ["st_po_received", "uc_change_price"],
  ["st_po_shortage", "uc_register_order"],
  ["st_day_open", "uc_register_sale"],
  ["st_day_open", "uc_record_payment"],
  ["st_day_open", "uc_register_return"],
  ["st_day_open", "uc_record_cash"],
  ["st_day_counted", "uc_issue_daily_report"],
  ["st_day_reconciled", "uc_send_report"],
  ["st_day_reported", "uc_record_deposit"],
  ["st_rec_open", "uc_clear_receivable"],
  ["st_rec_partial", "uc_clear_receivable"],
  // usecaseState
  ["uc_register_order", "st_po_placed"],
  ["uc_register_receiving", "st_po_received"],
  ["uc_register_receiving", "st_po_shortage"],
  ["uc_register_sale", "st_day_open"],
  ["uc_record_cash", "st_day_counted"],
  ["uc_issue_daily_report", "st_day_reconciled"],
  ["uc_send_report", "st_day_reported"],
  ["uc_record_deposit", "st_day_deposited"],
  ["uc_register_receivable", "st_rec_open"],
  ["uc_clear_receivable", "st_rec_partial"],
  ["uc_clear_receivable", "st_rec_cleared"],
];

const elements: Element[] = [
  ...actors,
  ...externalActors,
  ...systems,
  ...businesses,
  ...defaultBucs,
  ...bucs,
  ...activities,
  ...usecases,
  ...contexts,
  ...informations,
  ...states,
  ...variations,
  ...conditions,
  ...issues,
];

const kindOf = new Map(elements.map((e) => [e.id, e.kind]));

const relations: Relation[] = pairs.map(([sourceId, targetId]) => {
  const s = kindOf.get(sourceId);
  const t = kindOf.get(targetId);
  const kind = s && t ? relationKindFor(s, t) : null;
  if (!kind) throw new Error(`サンプルの関係が引けません: ${sourceId} -> ${targetId}`);
  return { id: `rel_${sourceId}__${targetId}`, kind, sourceId, targetId };
});

// ---------------------------------------------------------------- ボード

/** 縦に並べる */
function column(ids: string[], x: number, y0: number, dy: number): BoardNode[] {
  return ids.map((elementId, i) => ({ elementId, x, y: y0 + i * dy }));
}

// 「全体」: 業務の枠の中に、枠内の絶対座標でアクティビティを置く
const FRAME_Y = 40;
const FRAME_H = 460;
const ACT_STEP = 96;
// 横長になりすぎて文字が小さくならないよう、後半の業務は 2 段目に置く
const FRAME_Y2 = FRAME_Y + FRAME_H + 60;

function frameWithActivities(bizId: string, x: number, actIds: string[], y = FRAME_Y): BoardNode[] {
  return [
    { elementId: bizId, x, y, width: 260, height: FRAME_H },
    ...column(actIds, x + 40, y + 56, ACT_STEP),
  ];
}

// アクターは線ではなく枠・カードのラベルで見せるので、このボードには置かない
const overviewNodes: BoardNode[] = [
  ...frameWithActivities("biz_purchase", 40, ["act_decide_qty", "act_place_order", "act_receive", "act_record_receiving"]),
  ...frameWithActivities("biz_display", 340, ["act_display", "act_price", "act_check_shelf", "act_markdown"]),
  // レジ・接客: 活動の小枠 3 つ (活動のある業務の作業は、すべてどれかの活動に入れる)
  { elementId: "biz_register", x: 640, y: FRAME_Y, width: 520, height: FRAME_H },
  { elementId: "buc_checkout", x: 660, y: FRAME_Y + 56, width: 220, height: 260 },
  { elementId: "act_scan", x: 680, y: FRAME_Y + 112 },
  { elementId: "act_payment", x: 680, y: FRAME_Y + 208 },
  { elementId: "buc_return", x: 900, y: FRAME_Y + 56, width: 220, height: 160 },
  { elementId: "act_return", x: 920, y: FRAME_Y + 112 },
  { elementId: "buc_special", x: 900, y: FRAME_Y + 236, width: 220, height: 160 },
  { elementId: "act_special", x: 920, y: FRAME_Y + 292 },
  ...frameWithActivities("biz_closing", 40, ["act_count_cash", "act_reconcile", "act_report_sales", "act_deposit"], FRAME_Y2),
  ...frameWithActivities("biz_stocktake", 340, ["act_stocktake", "act_apply_count", "act_review_stock"], FRAME_Y2),
  ...frameWithActivities("biz_receivable", 640, ["act_book_receivable", "act_manage_settlement", "act_clear_receivable"], FRAME_Y2),
  ...frameWithActivities("biz_monthly", 940, ["act_review_pl", "act_review_bs"], FRAME_Y2),
];

const flowActivities = activities.map((e) => e.id);
const flowUsecases = usecases.map((e) => e.id);
const flowInfos = informations.map((e) => e.id);
const flowConditions = conditions.map((e) => e.id);

const flowNodes: BoardNode[] = [
  ...column(flowActivities, 40, 40, 110),
  ...column(flowUsecases, 340, 40, 90),
  ...column(flowInfos, 660, 40, 100),
  ...column(flowConditions, 960, 40, 100),
];

const stateUsecases = [
  "uc_register_order",
  "uc_register_receiving",
  "uc_change_price",
  "uc_register_sale",
  "uc_record_payment",
  "uc_register_return",
  "uc_record_cash",
  "uc_issue_daily_report",
  "uc_send_report",
  "uc_record_deposit",
  "uc_register_receivable",
  "uc_record_settlement",
  "uc_clear_receivable",
];

const stateNodes: BoardNode[] = [
  ...column(flowInfos, 40, 40, 100),
  ...column(variations.map((e) => e.id), 340, 40, 100),
  ...column(flowConditions, 340, 380, 100),
  ...column(states.filter((e) => e.id.startsWith("st_po_")).map((e) => e.id), 640, 40, 90),
  ...column(stateUsecases, 940, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_day_")).map((e) => e.id), 1240, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_rec_")).map((e) => e.id), 1240, 540, 90),
];

export const retailSample: UntieModel = {
  version: MODEL_VERSION,
  meta: {
    name: "店舗の業務 (サンプル)",
    description: "架空の日用品店の業務を題材にしたサンプル。実在の店・データではありません。",
  },
  elements,
  relations,
  boards: [
    { id: "board_overview", name: "全体", nodes: overviewNodes },
    { id: "board_flow", name: "発注からレジ締め・棚卸まで", nodes: flowNodes },
    { id: "board_state", name: "情報と状態", nodes: stateNodes },
  ],
};

/** 呼ぶたびに独立したコピーを返す (JSON の往復。core は DOM に依存しないので structuredClone を使わない) */
export function createRetailSample(): UntieModel {
  return JSON.parse(JSON.stringify(retailSample)) as UntieModel;
}
