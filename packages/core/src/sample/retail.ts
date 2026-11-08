// 架空の日用品店 (駅前の 1 店舗。本部が発注の基準を出す) のサンプルモデル。実在の店・データは使わない。
// 発注・入荷・陳列・レジ・レジ締め・棚卸の流れと、現場の困りごとを置く。
import { addDesignScreens, setDatabaseDesign, setDesignLayout, setDesignNavigation, setDesignScreenView, updateTransition } from "../model/commands";
import { DEFAULT_DATABASE_ID, DEFAULT_DATABASE_NAME } from "../model/design";
import { relationKindFor } from "../model/relations";
import { deriveTransitions, sitemapTree } from "../model/sitemap";
import { MODEL_VERSION, type BoardNode, type DesignScreen, type Element, type InformationAccess, type Relation, type UntieModel } from "../model/types";

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
];

const businessDefs: [id: string, name: string][] = [
  ["biz_purchase", "発注"],
  ["biz_receiving", "入荷"],
  ["biz_display", "陳列"],
  ["biz_inventory", "在庫管理"],
  ["biz_register", "レジ・接客"],
  ["biz_closing", "レジ締め"],
  ["biz_sales_report", "売上報告"],
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
  { id: "act_decide_qty", kind: "activity", name: "発注数を決める", bucId: dflt("biz_purchase"), hours: 0.5, triggerNote: "毎週の発注日" },
  { id: "act_place_order", kind: "activity", name: "発注する", bucId: dflt("biz_purchase") },
  { id: "act_receive", kind: "activity", name: "入荷を検品する", bucId: dflt("biz_receiving"), triggerNote: "仕入先からの納品" },
  { id: "act_record_receiving", kind: "activity", name: "検品の結果を記録する", bucId: dflt("biz_receiving") },
  { id: "act_display", kind: "activity", name: "商品を陳列する", bucId: dflt("biz_display") },
  { id: "act_price", kind: "activity", name: "売価・値札を直す", bucId: dflt("biz_display"), triggerNote: "本部からの価格変更の通知" },
  { id: "act_check_shelf", kind: "activity", name: "棚の在庫を確認する", bucId: dflt("biz_inventory"), triggerNote: "開店前・閉店後の巡回" },
  { id: "act_markdown", kind: "activity", name: "売れ残りを値引き・廃棄する", bucId: dflt("biz_inventory") },
  { id: "act_scan", kind: "activity", name: "商品を読み取る", bucId: "buc_checkout", triggerNote: "レジに商品が出されたとき" },
  { id: "act_payment", kind: "activity", name: "代金を受け取る", bucId: "buc_checkout" },
  { id: "act_return", kind: "activity", name: "返品・交換に応じる", bucId: "buc_return", triggerNote: "お客さまからの申し出" },
  { id: "act_special", kind: "activity", name: "お取り寄せを受ける", bucId: "buc_special", triggerNote: "お客さまからの注文" },
  { id: "act_count_cash", kind: "activity", name: "現金を数える", bucId: dflt("biz_closing"), hours: 0.2, triggerNote: "閉店" },
  { id: "act_reconcile", kind: "activity", name: "売上と現金を突き合わせる", bucId: dflt("biz_closing"), hours: 0.5 },
  {
    id: "act_report_sales",
    kind: "activity",
    name: "売上を本部へ報告する",
    bucId: dflt("biz_sales_report"),
    // 架空のマニュアル (example.com はリンクの例示用ドメイン)
    links: [
      { title: "日次報告の手順", url: "https://example.com/manual/daily-report" },
      { title: "報告の締め時間", url: "https://example.com/manual/report-deadline" },
    ],
  },
  { id: "act_deposit", kind: "activity", name: "売上金を保管・入金する", bucId: dflt("biz_closing") },
  { id: "act_stocktake", kind: "activity", name: "棚卸をする", bucId: dflt("biz_stocktake"), hours: 2, triggerNote: "月末" },
  { id: "act_apply_count", kind: "activity", name: "実在庫を帳簿に反映する", bucId: dflt("biz_stocktake") },
  { id: "act_review_stock", kind: "activity", name: "欠品・過剰在庫を確認する", bucId: dflt("biz_stocktake") },
  // 本部の会計システムが対象。クレジットカードや電子マネーの売上は、あとから決済会社がまとめて振り込む (その間は売掛金)。
  // 売掛金の計上は人の作業ではなく、「カード・電子マネーで支払われた」をきっかけにした自動の処理 (操作「売掛金を登録する」)
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

/** イベント (操作やシステムが発生させる出来事) */
const events: Element[] = [
  { id: "ev_card_paid", kind: "event", name: "カード・電子マネーで支払われた", contextId: "ctx_accounting" },
];

/** POSレジの画面 (設計モードのサイトマップの材料。ほかのシステムの画面は置かない) */
const screens: Element[] = [
  { id: "scr_pos_search", kind: "screen", name: "商品・在庫の検索", systemId: "sys_pos" },
  { id: "scr_pos_price", kind: "screen", name: "売価の変更", systemId: "sys_pos" },
  { id: "scr_pos_disposal", kind: "screen", name: "値引き・廃棄の入力", systemId: "sys_pos" },
  { id: "scr_pos_sale", kind: "screen", name: "レジ打ち", systemId: "sys_pos" },
  { id: "scr_pos_return", kind: "screen", name: "返品・交換の入力", systemId: "sys_pos" },
  { id: "scr_pos_cash", kind: "screen", name: "現金の確認", systemId: "sys_pos" },
  { id: "scr_pos_daily", kind: "screen", name: "日次売上", systemId: "sys_pos" },
  { id: "scr_pos_stocktake", kind: "screen", name: "棚卸の入力", systemId: "sys_pos" },
  { id: "scr_pos_adjust", kind: "screen", name: "在庫の調整", systemId: "sys_pos" },
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
      location: "レジ締めの「売上と現金を突き合わせる」。返品や値引きの訂正が、POSレジではなく紙のレシートの裏に書かれている。",
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

const pairs: [source: string, target: string, access?: InformationAccess][] = [
  // actorBusiness
  ["actor_manager", "biz_purchase"],
  ["actor_backyard", "biz_receiving"],
  ["actor_floor", "biz_display"],
  ["actor_floor", "biz_inventory"],
  ["actor_cashier", "biz_register"],
  ["actor_cashier", "biz_closing"],
  ["actor_manager", "biz_sales_report"],
  ["actor_floor", "biz_stocktake"],
  ["actor_manager", "biz_monthly"],
  ["actor_hq_accounting", "biz_receivable"],
  // actorActivity
  ["actor_manager", "act_decide_qty"],
  ["actor_hq_purchase", "act_decide_qty"],
  ["actor_manager", "act_place_order"],
  ["actor_backyard", "act_receive"],
  ["ext_supplier", "act_receive"],
  ["actor_backyard", "act_record_receiving"],
  ["actor_floor", "act_display"],
  ["actor_floor", "act_price"],
  ["actor_floor", "act_check_shelf"],
  ["actor_floor", "act_markdown"],
  ["actor_manager", "act_markdown"],
  ["actor_cashier", "act_scan"],
  ["ext_shopper", "act_scan"],
  ["actor_cashier", "act_payment"],
  ["ext_shopper", "act_payment"],
  ["actor_cashier", "act_return"],
  ["actor_manager", "act_return"],
  ["ext_shopper", "act_return"],
  ["actor_cashier", "act_special"],
  ["ext_shopper", "act_special"],
  ["actor_hq_purchase", "act_special"],
  ["actor_cashier", "act_count_cash"],
  ["actor_cashier", "act_reconcile"],
  ["actor_manager", "act_report_sales"],
  ["actor_hq_purchase", "act_report_sales"],
  ["actor_manager", "act_deposit"],
  ["actor_floor", "act_stocktake"],
  ["actor_backyard", "act_stocktake"],
  // システムが担当する作業 (自動で行う)
  ["actor_manager", "act_apply_count"],
  ["actor_manager", "act_review_stock"],
  ["actor_hq_accounting", "act_manage_settlement"],
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
  ["act_manage_settlement", "uc_record_settlement"],
  ["act_clear_receivable", "uc_clear_receivable"],
  ["act_review_pl", "uc_view_pl"],
  ["act_review_bs", "uc_view_bs"],
  // usecaseInformation (操作 → 情報: 扱う)。3 つ目は取得・保存の区別 (read: 取得だけ、write: 保存だけ、無ければ両方)。
  // 情報の置き場所 (取得元・保存先) と画面が扱う情報は、これと操作の対象から導く (0.4.0 から)
  ["uc_register_order", "info_order"],
  ["uc_register_order", "info_item", "read"],
  ["uc_register_receiving", "info_receiving"],
  ["uc_register_receiving", "info_order", "read"],
  ["uc_register_receiving", "info_stock", "read"],
  ["uc_search_item", "info_item", "read"],
  ["uc_search_item", "info_stock", "read"],
  ["uc_change_price", "info_item"],
  ["uc_record_disposal", "info_stock"],
  ["uc_record_disposal", "info_item", "read"],
  ["uc_register_sale", "info_sale"],
  ["uc_register_sale", "info_item", "read"],
  ["uc_register_sale", "info_stock"],
  ["uc_record_payment", "info_payment"],
  ["uc_record_payment", "info_sale", "read"],
  ["uc_register_return", "info_sale"],
  ["uc_register_return", "info_stock"],
  ["uc_register_special", "info_order"],
  ["uc_register_special", "info_item", "read"],
  ["uc_record_cash", "info_payment"],
  ["uc_issue_daily_report", "info_sale", "read"],
  ["uc_issue_daily_report", "info_payment", "read"],
  ["uc_send_report", "info_sale", "write"],
  ["uc_record_deposit", "info_payment"],
  ["uc_record_stocktake", "info_stocktake"],
  ["uc_record_stocktake", "info_stock", "read"],
  ["uc_adjust_stock", "info_stock"],
  ["uc_adjust_stock", "info_stocktake", "read"],
  ["uc_register_receivable", "info_receivable"],
  ["uc_register_receivable", "info_sale", "read"],
  ["uc_record_settlement", "info_settlement"],
  ["uc_clear_receivable", "info_receivable"],
  ["uc_clear_receivable", "info_settlement", "read"],
  ["uc_view_pl", "info_pl", "read"],
  ["uc_view_bs", "info_bs", "read"],
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
  // 作業に属さない自動の処理: カード・電子マネーの支払を記録すると、本部の会計システムが売掛金を登録する
  ["uc_record_payment", "ev_card_paid"],
  ["ev_card_paid", "uc_register_receivable"],
  ["uc_register_receivable", "sys_accounting"],
  // usecaseSystem (操作 → システム・帳票: 対象)。0.2.0 から、システムは作業の担当ではなく操作の対象にする。POSレジの操作は画面で結ぶ (下)
  ["uc_register_receiving", "ldg_receiving_slip"],
  ["uc_register_special", "sys_ordering"],
  ["uc_send_report", "sys_accounting"],
  ["uc_record_deposit", "ldg_closing_sheet"],
  ["uc_view_pl", "sys_accounting"],
  ["uc_view_bs", "sys_accounting"],
  ["uc_register_order", "sys_ordering"],
  ["uc_record_payment", "sys_terminal"],
  ["uc_record_settlement", "sys_accounting"],
  ["uc_clear_receivable", "sys_accounting"],
  // usecaseScreen (POSレジの画面。1 つの操作の対象は、システム・画面のどちらか 1 つだけ)。画面が扱う情報は、画面を使う操作が扱う情報から導く
  ["uc_search_item", "scr_pos_search"],
  ["uc_change_price", "scr_pos_price"],
  ["uc_record_disposal", "scr_pos_disposal"],
  ["uc_register_sale", "scr_pos_sale"],
  ["uc_register_return", "scr_pos_return"],
  ["uc_record_cash", "scr_pos_cash"],
  ["uc_issue_daily_report", "scr_pos_daily"],
  ["uc_record_stocktake", "scr_pos_stocktake"],
  ["uc_adjust_stock", "scr_pos_adjust"],
  // 作業が使う操作 (activityUsecase) と操作の順 (usecaseNext)。値引き・廃棄と棚卸は、商品を探してから記録する
  ["act_markdown", "uc_search_item"],
  ["act_stocktake", "uc_search_item"],
  ["uc_search_item", "uc_record_disposal"],
  ["uc_search_item", "uc_record_stocktake"],
  // activityTrigger / eventActivity (作業の起点)
  ["act_decide_qty", "act_place_order"],
  ["act_receive", "act_record_receiving"],
  ["act_record_receiving", "act_display"],
  ["act_check_shelf", "act_markdown"],
  ["act_scan", "act_payment"],
  ["act_count_cash", "act_reconcile"],
  ["act_reconcile", "act_report_sales"],
  ["act_report_sales", "act_deposit"],
  ["act_stocktake", "act_apply_count"],
  ["act_apply_count", "act_review_stock"],
  ["ev_card_paid", "act_manage_settlement"],
  ["act_manage_settlement", "act_clear_receivable"],
  ["act_review_pl", "act_review_bs"],
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
  ...events,
  ...screens,
  ...issues,
];

const kindOf = new Map(elements.map((e) => [e.id, e.kind]));

const relations: Relation[] = pairs.map(([sourceId, targetId, access]) => {
  const s = kindOf.get(sourceId);
  const t = kindOf.get(targetId);
  const kind = s && t ? relationKindFor(s, t) : null;
  if (!kind) throw new Error(`サンプルの関係が引けません: ${sourceId} -> ${targetId}`);
  return { id: `rel_${sourceId}__${targetId}`, kind, sourceId, targetId, ...(access ? { access } : {}) };
});

// ---------------------------------------------------------------- ボード

/** 縦に並べる */
function column(ids: string[], x: number, y0: number, dy: number): BoardNode[] {
  return ids.map((elementId, i) => ({ elementId, x, y: y0 + i * dy }));
}

// 「全体」: 業務の枠の中に、枠内の絶対座標でアクティビティを置く
const ACT_STEP = 96;
const FRAME_W = 260;
/** 作業を縦に並べる枠の高さ (作業の数に合わせる) */
const frameHeight = (n: number) => 56 + n * ACT_STEP + 24;
// 横長になりすぎて文字が小さくならないよう、3 段に分ける。1 段目: 発注から在庫管理まで、2 段目: レジ・接客から売上報告まで、3 段目: 棚卸以降
const ROW1_Y = 40;
const ROW2_Y = ROW1_Y + frameHeight(2) + 60;
const REGISTER_H = 460;
const ROW3_Y = ROW2_Y + REGISTER_H + 60;

function frameWithActivities(bizId: string, x: number, actIds: string[], y: number): BoardNode[] {
  return [
    { elementId: bizId, x, y, width: FRAME_W, height: frameHeight(actIds.length) },
    ...column(actIds, x + 40, y + 56, ACT_STEP),
  ];
}

// アクターは線ではなく枠・カードのラベルで見せるので、このボードには置かない
const overviewNodes: BoardNode[] = [
  ...frameWithActivities("biz_purchase", 40, ["act_decide_qty", "act_place_order"], ROW1_Y),
  ...frameWithActivities("biz_receiving", 340, ["act_receive", "act_record_receiving"], ROW1_Y),
  ...frameWithActivities("biz_display", 640, ["act_display", "act_price"], ROW1_Y),
  ...frameWithActivities("biz_inventory", 940, ["act_check_shelf", "act_markdown"], ROW1_Y),
  // レジ・接客: 活動の小枠 3 つ (活動のある業務の作業は、すべてどれかの活動に入れる)
  { elementId: "biz_register", x: 40, y: ROW2_Y, width: 520, height: REGISTER_H },
  { elementId: "buc_checkout", x: 60, y: ROW2_Y + 56, width: 220, height: 260 },
  { elementId: "act_scan", x: 80, y: ROW2_Y + 112 },
  { elementId: "act_payment", x: 80, y: ROW2_Y + 208 },
  { elementId: "buc_return", x: 300, y: ROW2_Y + 56, width: 220, height: 160 },
  { elementId: "act_return", x: 320, y: ROW2_Y + 112 },
  { elementId: "buc_special", x: 300, y: ROW2_Y + 236, width: 220, height: 160 },
  { elementId: "act_special", x: 320, y: ROW2_Y + 292 },
  ...frameWithActivities("biz_closing", 640, ["act_count_cash", "act_reconcile", "act_deposit"], ROW2_Y),
  ...frameWithActivities("biz_sales_report", 940, ["act_report_sales"], ROW2_Y),
  ...frameWithActivities("biz_stocktake", 40, ["act_stocktake", "act_apply_count", "act_review_stock"], ROW3_Y),
  ...frameWithActivities("biz_receivable", 340, ["act_manage_settlement", "act_clear_receivable"], ROW3_Y),
  ...frameWithActivities("biz_monthly", 640, ["act_review_pl", "act_review_bs"], ROW3_Y),
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

const baseModel: UntieModel = {
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
  designs: [],
  databases: [],
};


/** POSレジの画面が使う情報 (と POSレジが持つ情報) を表すデータベースの DSL (Prisma の一部) */
const POS_DSL = `// POSレジのデータベース (架空)
enum PaymentMethod {
  CASH
  CARD
  QR
}

enum SaleKind {
  SALE
  RETURN
}

model Category {
  id    String @id
  name  String @unique
  items Item[]
}

model Item {
  id         String      @id
  code       String      @unique
  name       String
  price      Int
  category   Category    @relation(fields: [categoryId], references: [id])
  categoryId String
  stock      StockLevel?
  lines      SaleLine[]
  @@map("items")
}

model StockLevel {
  itemId    String   @id
  item      Item     @relation(fields: [itemId], references: [id])
  quantity  Int      @default(0)
  updatedAt DateTime @updatedAt
}

model Sale {
  id       String     @id
  kind     SaleKind   @default(SALE)
  soldAt   DateTime   @default(now())
  total    Int
  lines    SaleLine[]
  payments Payment[]
}

model SaleLine {
  id       String @id
  sale     Sale   @relation(fields: [saleId], references: [id])
  saleId   String
  item     Item   @relation(fields: [itemId], references: [id])
  itemId   String
  quantity Int
  price    Int
}

model Payment {
  id     String        @id
  sale   Sale          @relation(fields: [saleId], references: [id])
  saleId String
  method PaymentMethod
  amount Int
  paidAt DateTime      @default(now())
}

model Stocktake {
  id         String   @id
  itemId     String
  countedQty Int
  countedAt  DateTime @default(now())
  note       String?
}
`;

/** POSレジの画面 UI (mokkun v2 の view) と、項目と列の対応。遷移先は設計の画面の id */
const POS_VIEWS: { id: string; view: Record<string, unknown>; bindings: { item: string; table: string; column: string }[] }[] = [
  {
    id: "ds_pos_search",
    view: {
      title: "商品・在庫の検索",
      goal: "商品と在庫数を調べ、値引きや廃棄が要る商品を見つける",
      sections: [
        {
          id: "condition",
          title: "検索条件",
          kind: "form",
          columns: 2,
          fields: [
            { item: "keyword", label: "商品名・コード", component: "text", example: "おにぎり" },
            {
              item: "categoryId",
              label: "カテゴリ",
              component: "select",
              options: [
                { value: "food", label: "食品" },
                { value: "drink", label: "飲料" },
                { value: "daily", label: "日用品" },
              ],
            },
          ],
        },
        {
          id: "results",
          title: "検索結果",
          kind: "list",
          list: {
            columns: [
              { id: "code", label: "商品コード", to: "ds_pos_disposal" },
              { id: "name", label: "商品名" },
              { id: "price", label: "売価", type: "number" },
              { id: "quantity", label: "在庫数", type: "number" },
            ],
            paging: { pageSize: 20 },
            selection: "none",
          },
        },
      ],
    },
    bindings: [
      { item: "keyword", table: "Item", column: "name" },
      { item: "categoryId", table: "Item", column: "categoryId" },
      { item: "results.code", table: "Item", column: "code" },
      { item: "results.name", table: "Item", column: "name" },
      { item: "results.price", table: "Item", column: "price" },
      { item: "results.quantity", table: "StockLevel", column: "quantity" },
    ],
  },
  {
    id: "ds_pos_sale",
    view: {
      title: "レジ打ち",
      goal: "商品を読み取って明細を作り、支払を受けて会計を終える",
      primaryAction: { id: "checkout", label: "会計する", kind: "submit", style: "primary" },
      sections: [
        {
          id: "lines",
          title: "明細",
          kind: "list",
          list: {
            columns: [
              { id: "item", label: "商品" },
              { id: "quantity", label: "数量", type: "number" },
              { id: "price", label: "単価", type: "number" },
            ],
            selection: "none",
          },
        },
        {
          id: "payment",
          title: "支払",
          kind: "form",
          columns: 2,
          fields: [
            {
              item: "method",
              label: "支払方法",
              component: "select",
              required: true,
              options: [
                { value: "CASH", label: "現金" },
                { value: "CARD", label: "カード" },
                { value: "QR", label: "QR コード" },
              ],
            },
            { item: "amount", label: "支払額", component: "number", required: true, unit: "円" },
          ],
        },
      ],
    },
    bindings: [
      { item: "lines.item", table: "SaleLine", column: "itemId" },
      { item: "lines.quantity", table: "SaleLine", column: "quantity" },
      { item: "lines.price", table: "SaleLine", column: "price" },
      { item: "method", table: "Payment", column: "method" },
      { item: "amount", table: "Payment", column: "amount" },
    ],
  },
  {
    id: "ds_pos_top",
    view: {
      title: "トップページ",
      goal: "店の今日の状況をひと目で確かめる",
      sections: [
        {
          id: "today",
          title: "今日の状況",
          kind: "summary",
          columns: 2,
          fields: [
            { item: "todaySales", label: "本日の売上", component: "text", readonly: true, example: "128,400 円" },
            { item: "lowStock", label: "在庫の少ない商品", component: "text", readonly: true, example: "3 点" },
          ],
        },
      ],
    },
    // 要約の値は計算した値なので、列には結ばない
    bindings: [],
  },
];

/**
 * POSレジの設計 (サイトマップ): サインイン・トップページと、POSレジの画面に届く作業をすべてチェックしたのと同じ内容。
 * 遷移は deriveTransitions で導き、いくつかにはきっかけ (via) を入れる
 */
function withPosDesign(model: UntieModel): UntieModel {
  const walk = (nodes: ReturnType<typeof sitemapTree>): string[] => nodes.flatMap((n) => [...n.screenIds, ...walk(n.children)]);
  const screenIds = [...new Set(walk(sitemapTree(model, "sys_pos")))];
  // 画面と遷移の id は固定にする (開くたびに変わらないように)
  const screens: DesignScreen[] = [
    { id: "ds_pos_signin", source: { kind: "builtin", builtin: "signIn" } },
    { id: "ds_pos_top", source: { kind: "builtin", builtin: "top" } },
    ...screenIds.map((screenId): DesignScreen => ({ id: `ds_${screenId.replace("scr_", "")}`, source: { kind: "screen", screenId } })),
  ];
  const transitions = deriveTransitions(model, "sys_pos", screens).map((t, i) => ({ id: `tr_pos_${i + 1}`, ...t }));
  const added = addDesignScreens(model, { systemId: "sys_pos", screens, transitions });
  if (!added.ok) throw new Error(`サンプルの設計が作れません: ${added.reason}`);
  let next = added.model;
  const via: [from: string, to: string, via: "button" | "row" | "nav", label?: string][] = [
    ["scr_pos_search", "scr_pos_disposal", "row"],
    ["scr_pos_search", "scr_pos_stocktake", "button"],
    ["scr_pos_cash", "scr_pos_daily", "button", "日次売上を見る"],
  ];
  for (const [from, to, v, label] of via) {
    const tr = transitions.find((t) => t.from === `ds_${from.replace("scr_", "")}` && t.to === `ds_${to.replace("scr_", "")}`);
    if (!tr) throw new Error(`サンプルの遷移が見つかりません: ${from} -> ${to}`);
    const r = updateTransition(next, { systemId: "sys_pos", id: tr.id, patch: { via: v, ...(label ? { label } : {}) } });
    if (!r.ok) throw new Error(`サンプルの遷移が直せません: ${r.reason}`);
    next = r.model;
  }
  // レイアウト (共通の枠つき。ヘッダーのシステム名は空で、対象システムの名前を出す) と、ナビゲーションメニュー。画面はすべてメニューから辿れる
  const layout = setDesignLayout(next, { systemId: "sys_pos", shell: "shell" });
  if (!layout.ok) throw new Error(`サンプルのレイアウトが作れません: ${layout.reason}`);
  const nav = setDesignNavigation(layout.model, {
    systemId: "sys_pos",
    navigation: [
      { id: "nav_pos_home", group: "ホーム", items: [{ screenId: "ds_pos_top" }] },
      { id: "nav_pos_register", group: "レジ", items: [{ screenId: "ds_pos_sale" }, { screenId: "ds_pos_return" }, { screenId: "ds_pos_cash" }] },
      {
        id: "nav_pos_stock",
        group: "商品・在庫",
        items: [{ screenId: "ds_pos_search" }, { screenId: "ds_pos_price" }, { screenId: "ds_pos_disposal" }, { screenId: "ds_pos_stocktake" }, { screenId: "ds_pos_adjust" }],
      },
      { id: "nav_pos_sales", group: "売上", items: [{ screenId: "ds_pos_daily", label: "売上（日次）" }] },
    ],
  });
  if (!nav.ok) throw new Error(`サンプルのナビゲーションが作れません: ${nav.reason}`);
  next = nav.model;
  // 既定のデータベースに、POSレジが使う情報を表す DSL と、テーブルが表す情報の対応を入れる
  next = { ...next, databases: [{ id: DEFAULT_DATABASE_ID, name: DEFAULT_DATABASE_NAME, dsl: "", tables: [] }] };
  const db = setDatabaseDesign(next, {
    id: DEFAULT_DATABASE_ID,
    dsl: POS_DSL,
    tables: [
      { table: "Item", informationIds: ["info_item"] },
      { table: "StockLevel", informationIds: ["info_stock"] },
      { table: "Sale", informationIds: ["info_sale"] },
      { table: "SaleLine", informationIds: ["info_sale"] },
      { table: "Payment", informationIds: ["info_payment"] },
      { table: "Stocktake", informationIds: ["info_stocktake"] },
    ],
  });
  if (!db.ok) throw new Error(`サンプルのデータベースが作れません: ${db.reason}`);
  // 画面 UI (3 画面) と、項目と既定のデータベースの列の対応
  next = db.model;
  for (const v of POS_VIEWS) {
    const r = setDesignScreenView(next, { systemId: "sys_pos", id: v.id, view: v.view, bindings: v.bindings.map((b) => ({ ...b, databaseId: DEFAULT_DATABASE_ID })) });
    if (!r.ok) throw new Error(`サンプルの画面 UI が作れません: ${r.reason}`);
    next = r.model;
  }
  return next;
}

export const retailSample: UntieModel = withPosDesign(baseModel);

/** 呼ぶたびに独立したコピーを返す (JSON の往復。core は DOM に依存しないので structuredClone を使わない) */
export function createRetailSample(): UntieModel {
  return JSON.parse(JSON.stringify(retailSample)) as UntieModel;
}
