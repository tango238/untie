// 架空のネットショップ (雑貨の通販) のサンプルモデル。実在の店・データは使わない。
// 自社サイトとモールで売り、倉庫から出荷する小さな店を想定する。入荷・受注・出荷・返品・問い合わせ対応の流れと、現場の困りごとを置く。
// 0.2.0 の書き方の見本: 操作とイベントを「きっかけ・発生・次に」でつなぎ、システムは操作の対象 (画面から決まる) にする。
// 人が担当しない処理 (在庫の引き当て・売掛金の計上) は作業にせず、イベントをきっかけにした自動の処理にする。
// 画面と非機能要件もシステムに持たせる。検証のエラーも警告も出ない形にする (サンプルのテストで確かめる)
import { relationKindFor } from "../model/relations";
import { MODEL_VERSION, type BoardNode, type DomainModel, type Element, type InformationAccess, type Relation, type UntieModel, type RelationAlternate } from "../model/types";

// ---------------------------------------------------------------- 要素

const actors: Element[] = [
  { id: "actor_order", kind: "actor", name: "受注担当" },
  { id: "actor_warehouse", kind: "actor", name: "倉庫担当" },
  { id: "actor_support", kind: "actor", name: "カスタマーサポート" },
  { id: "actor_manager", kind: "actor", name: "店長" },
  { id: "actor_accounting", kind: "actor", name: "経理担当" },
];

const externalActors: Element[] = [
  { id: "ext_customer", kind: "externalActor", name: "購入者" },
  { id: "ext_supplier", kind: "externalActor", name: "仕入先" },
  { id: "ext_carrier", kind: "externalActor", name: "配送業者" },
];

/** システム (自社・社外を問わない。作業の担当にも、情報の置き場所にもなる) と、紙の帳票 (情報の置き場所) */
const systems: Element[] = [
  { id: "sys_cart", kind: "system", name: "自社サイトのカート" },
  { id: "sys_mall", kind: "system", name: "モールの管理画面" },
  { id: "sys_oms", kind: "system", name: "販売管理システム" },
  { id: "sys_payment", kind: "system", name: "決済サービス" },
  { id: "sys_accounting", kind: "system", name: "会計システム" },
  { id: "ldg_receiving_sheet", kind: "ledger", name: "入荷検品表" },
  { id: "ldg_return_slip", kind: "ledger", name: "返品受付票" },
];

const businessDefs: [id: string, name: string][] = [
  ["biz_stock", "入荷・在庫管理"],
  ["biz_order", "受注処理"],
  ["biz_shipping", "出荷"],
  ["biz_return", "返品・交換"],
  ["biz_support", "問い合わせ対応"],
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
  { id: "buc_order_check", kind: "buc", name: "注文の確認", businessId: "biz_order", isDefault: false },
  { id: "buc_payment_check", kind: "buc", name: "入金の確認", businessId: "biz_order", isDefault: false },
];

const dflt = (bizId: string) => `buc_default_${bizId.replace("biz_", "")}`;

const activities: Element[] = [
  { id: "act_receive", kind: "activity", name: "入荷を検品する", bucId: dflt("biz_stock"), triggerNote: "仕入先からの荷物の到着" },
  { id: "act_shelve", kind: "activity", name: "商品を棚に収める", bucId: dflt("biz_stock") },
  { id: "act_update_stock", kind: "activity", name: "在庫数を更新する", bucId: dflt("biz_stock"), hours: 0.5 },
  { id: "act_count", kind: "activity", name: "棚卸をする", bucId: dflt("biz_stock"), triggerNote: "月末の棚卸日" },
  { id: "act_import_order", kind: "activity", name: "注文を取り込む", bucId: "buc_order_check", hours: 0.3, triggerNote: "モールの注文通知" },
  { id: "act_check_order", kind: "activity", name: "注文内容を確認する", bucId: "buc_order_check" },
  { id: "act_check_payment", kind: "activity", name: "入金を確認する", bucId: "buc_payment_check" },
  { id: "act_pick", kind: "activity", name: "ピッキングする", bucId: dflt("biz_shipping"), hours: 0.4 },
  { id: "act_pack", kind: "activity", name: "梱包する", bucId: dflt("biz_shipping") },
  {
    id: "act_issue_label",
    kind: "activity",
    name: "送り状を発行して荷物を渡す",
    bucId: dflt("biz_shipping"),
    // 架空のマニュアル (example.com はリンクの例示用ドメイン)
    links: [
      { title: "送り状の発行手順", url: "https://example.com/manual/shipping-label" },
      { title: "集荷の締め時間", url: "https://example.com/manual/pickup-time" },
    ],
  },
  { id: "act_notify_shipping", kind: "activity", name: "発送を連絡する", bucId: dflt("biz_shipping") },
  { id: "act_accept_return", kind: "activity", name: "返品を受け付ける", bucId: dflt("biz_return"), triggerNote: "お客さまからの返品の連絡" },
  { id: "act_inspect_return", kind: "activity", name: "返品を検品する", bucId: dflt("biz_return") },
  { id: "act_refund", kind: "activity", name: "返金・交換を手配する", bucId: dflt("biz_return") },
  { id: "act_restock", kind: "activity", name: "在庫に戻す", bucId: dflt("biz_return") },
  { id: "act_answer", kind: "activity", name: "問い合わせに答える", bucId: dflt("biz_support"), triggerNote: "お客さまからの問い合わせ" },
  { id: "act_track", kind: "activity", name: "配送状況を調べる", bucId: dflt("biz_support"), hours: 0.1 },
  { id: "act_record_inquiry", kind: "activity", name: "対応を記録する", bucId: dflt("biz_support") },
  // 会計システムが対象。モールからの入金は、販売手数料や送料を引いた額で、あとから数日おきにまとめて届く。
  // 売掛金の計上は人の作業ではなく、「出荷が記録された」をきっかけにした自動の処理 (操作「売掛金を登録する」)
  { id: "act_manage_payment", kind: "activity", name: "入金を管理する", bucId: dflt("biz_receivable"), triggerNote: "モールからの入金通知" },
  { id: "act_clear_receivable", kind: "activity", name: "入金を消し込む", bucId: dflt("biz_receivable"), hours: 0.4 },
  // 会計システムで、損益計算書 (PL) と貸借対照表 (BS) を見る
  { id: "act_review_pl", kind: "activity", name: "損益を確認する", bucId: dflt("biz_monthly") },
  { id: "act_review_bs", kind: "activity", name: "財務の状況を確認する", bucId: dflt("biz_monthly") },
];

const usecases: Element[] = [
  { id: "uc_fill_receiving_sheet", kind: "usecase", name: "入荷検品表に記入する" },
  { id: "uc_register_receiving", kind: "usecase", name: "入荷を登録する" },
  {
    id: "uc_update_stock",
    kind: "usecase",
    name: "在庫数を更新する",
    hours: 0.2,
    links: [{ title: "販売管理システム操作手順 (在庫の更新)", url: "https://example.com/manual/oms-stock" }],
  },
  { id: "uc_record_count", kind: "usecase", name: "棚卸の結果を記録する" },
  { id: "uc_check_mall_order", kind: "usecase", name: "モールの注文を確認する" },
  { id: "uc_register_order", kind: "usecase", name: "注文を登録する", hours: 0.1 },
  { id: "uc_search_order", kind: "usecase", name: "注文を検索する", hours: 0.1 },
  { id: "uc_confirm_order", kind: "usecase", name: "注文を確定する" },
  { id: "uc_cancel_order", kind: "usecase", name: "注文を取り消す" },
  { id: "uc_allocate_stock", kind: "usecase", name: "在庫を引き当てる" },
  { id: "uc_record_payment", kind: "usecase", name: "入金を記録する" },
  { id: "uc_issue_pick_list", kind: "usecase", name: "ピッキングリストを出す" },
  { id: "uc_issue_label", kind: "usecase", name: "送り状を発行する" },
  { id: "uc_record_shipment", kind: "usecase", name: "出荷を記録する" },
  { id: "uc_fill_return_slip", kind: "usecase", name: "返品受付票に記入する" },
  { id: "uc_register_return", kind: "usecase", name: "返品を登録する" },
  { id: "uc_record_inspection", kind: "usecase", name: "返品の検品結果を記録する" },
  { id: "uc_record_refund", kind: "usecase", name: "返金を記録する" },
  { id: "uc_record_inquiry", kind: "usecase", name: "問い合わせを記録する" },
  { id: "uc_register_receivable", kind: "usecase", name: "売掛金を登録する" },
  { id: "uc_record_payout", kind: "usecase", name: "入金を登録する" },
  { id: "uc_clear_receivable", kind: "usecase", name: "売掛金を消し込む" },
  { id: "uc_view_pl", kind: "usecase", name: "損益計算書を見る" },
  { id: "uc_view_bs", kind: "usecase", name: "貸借対照表を見る" },
  { id: "uc_report_month", kind: "usecase", name: "月次の数字を報告する" },
];

/** 役割の同じ情報と、それに関係の深い状態・条件・バリエーションをまとめる親カテゴリ */
const contexts: Element[] = [
  { id: "ctx_order", kind: "context", name: "注文" },
  { id: "ctx_item", kind: "context", name: "商品・在庫" },
  { id: "ctx_customer", kind: "context", name: "顧客" },
  { id: "ctx_shipping", kind: "context", name: "出荷" },
  { id: "ctx_accounting", kind: "context", name: "会計" },
];

const informations: Element[] = [
  { id: "info_order", kind: "information", name: "注文", contextId: "ctx_order" },
  { id: "info_return", kind: "information", name: "返品", contextId: "ctx_order" },
  { id: "info_customer", kind: "information", name: "購入者", contextId: "ctx_customer" },
  { id: "info_inquiry", kind: "information", name: "問い合わせ履歴", contextId: "ctx_customer" },
  { id: "info_product", kind: "information", name: "商品", contextId: "ctx_item" },
  { id: "info_stock", kind: "information", name: "在庫", contextId: "ctx_item" },
  { id: "info_shipment", kind: "information", name: "出荷", contextId: "ctx_shipping" },
  { id: "info_receivable", kind: "information", name: "売掛金", contextId: "ctx_accounting" },
  { id: "info_payout", kind: "information", name: "入金", contextId: "ctx_accounting" },
  { id: "info_pl", kind: "information", name: "損益計算書 (PL)", contextId: "ctx_accounting" },
  { id: "info_bs", kind: "information", name: "貸借対照表 (BS)", contextId: "ctx_accounting" },
];

const states: Element[] = [
  { id: "st_ord_received", kind: "state", name: "受付済", group: "注文の状態", contextId: "ctx_order" },
  { id: "st_ord_confirmed", kind: "state", name: "確定", group: "注文の状態", contextId: "ctx_order" },
  { id: "st_ord_paid", kind: "state", name: "入金済", group: "注文の状態", contextId: "ctx_order" },
  { id: "st_ord_shipped", kind: "state", name: "出荷済", group: "注文の状態", contextId: "ctx_order" },
  { id: "st_ord_cancelled", kind: "state", name: "取消", group: "注文の状態", contextId: "ctx_order" },
  { id: "st_ret_accepted", kind: "state", name: "返品受付", group: "返品の状態", contextId: "ctx_order" },
  { id: "st_ret_inspected", kind: "state", name: "検品済", group: "返品の状態", contextId: "ctx_order" },
  { id: "st_ret_refunded", kind: "state", name: "返金済", group: "返品の状態", contextId: "ctx_order" },
  { id: "st_rec_open", kind: "state", name: "未入金", group: "売掛金の状態", contextId: "ctx_accounting" },
  { id: "st_rec_partial", kind: "state", name: "一部入金", group: "売掛金の状態", contextId: "ctx_accounting" },
  { id: "st_rec_cleared", kind: "state", name: "消込済", group: "売掛金の状態", contextId: "ctx_accounting" },
];

const variations: Element[] = [
  { id: "var_channel", kind: "variation", name: "販売チャネル", values: ["自社サイト", "モールA", "モールB"], contextId: "ctx_order" },
  { id: "var_payment_method", kind: "variation", name: "支払方法", values: ["クレジットカード", "代金引換", "コンビニ払い"], contextId: "ctx_order" },
  { id: "var_delivery", kind: "variation", name: "配送方法", values: ["宅配便", "メール便", "店頭受取"], contextId: "ctx_shipping" },
];

const conditions: Element[] = [
  { id: "cond_out_of_stock", kind: "condition", name: "在庫が足りない", description: "引き当てる数が、棚にある数を超えている。", contextId: "ctx_item" },
  { id: "cond_return_period", kind: "condition", name: "返品の期間内である", description: "商品が届いてから 8 日以内の申し出だけ受ける。", contextId: "ctx_order" },
  { id: "cond_gift", kind: "condition", name: "ギフト包装の指定がある", contextId: "ctx_order" },
];

/** イベント (操作やシステムが発生させる出来事。人の動きは含めない) */
const events: Element[] = [
  { id: "ev_received", kind: "event", name: "入荷が登録された", contextId: "ctx_item" },
  { id: "ev_stock_changed", kind: "event", name: "在庫数が変わった", contextId: "ctx_item" },
  { id: "ev_counted", kind: "event", name: "棚卸の数が記録された", contextId: "ctx_item" },
  { id: "ev_order_received", kind: "event", name: "注文を受け付けた", contextId: "ctx_order" },
  { id: "ev_order_confirmed", kind: "event", name: "注文が確定した", contextId: "ctx_order" },
  { id: "ev_order_cancelled", kind: "event", name: "注文が取り消された", contextId: "ctx_order" },
  { id: "ev_stock_allocated", kind: "event", name: "在庫が引き当てられた", contextId: "ctx_item" },
  { id: "ev_payment_confirmed", kind: "event", name: "入金が確認された", contextId: "ctx_order", timing: { type: "adhoc", note: "決済サービスから入金の通知 (Webhook) を受けたとき" } },
  { id: "ev_pick_listed", kind: "event", name: "ピッキングの指示が出た", contextId: "ctx_order" },
  { id: "ev_label_issued", kind: "event", name: "送り状が発行された", contextId: "ctx_shipping" },
  { id: "ev_shipped", kind: "event", name: "出荷が記録された", contextId: "ctx_shipping" },
  { id: "ev_return_accepted", kind: "event", name: "返品を受け付けた", contextId: "ctx_order" },
  { id: "ev_return_inspected", kind: "event", name: "返品の検品が済んだ", contextId: "ctx_order" },
  { id: "ev_refunded", kind: "event", name: "返金が記録された", contextId: "ctx_order" },
  { id: "ev_inquiry_recorded", kind: "event", name: "問い合わせの対応が記録された", contextId: "ctx_customer" },
  { id: "ev_receivable_booked", kind: "event", name: "売掛金が計上された", contextId: "ctx_accounting" },
  { id: "ev_payout_recorded", kind: "event", name: "モールからの入金が登録された", contextId: "ctx_accounting" },
  { id: "ev_receivable_cleared", kind: "event", name: "売掛金が消し込まれた", contextId: "ctx_accounting" },
  { id: "ev_month_closed", kind: "event", name: "月次の締めが済んだ", contextId: "ctx_accounting" },
  { id: "ev_month_reported", kind: "event", name: "月次の数字が報告された", contextId: "ctx_accounting" },
];

/** 画面 (システムに属する) */
const screens: Element[] = [
  // 1 つの画面は 1 つの操作だけが使う。同じ画面で済ませていた操作は、操作ごとの画面に分ける
  { id: "scr_order_entry", kind: "screen", name: "受注入力画面", systemId: "sys_oms" },
  { id: "scr_order_list", kind: "screen", name: "受注一覧", systemId: "sys_oms" },
  { id: "scr_order_confirm", kind: "screen", name: "注文の確定画面", systemId: "sys_oms" },
  { id: "scr_order_cancel", kind: "screen", name: "注文の取消画面", systemId: "sys_oms" },
  { id: "scr_stock", kind: "screen", name: "在庫一覧", systemId: "sys_oms" },
  { id: "scr_receiving", kind: "screen", name: "入荷の登録画面", systemId: "sys_oms" },
  { id: "scr_stock_count", kind: "screen", name: "棚卸の入力画面", systemId: "sys_oms" },
  { id: "scr_shipping", kind: "screen", name: "出荷指示画面", systemId: "sys_oms" },
  { id: "scr_label", kind: "screen", name: "送り状の発行画面", systemId: "sys_oms" },
  { id: "scr_shipment_record", kind: "screen", name: "出荷の記録画面", systemId: "sys_oms" },
  { id: "scr_return", kind: "screen", name: "返品登録画面", systemId: "sys_oms" },
  { id: "scr_return_inspection", kind: "screen", name: "返品の検品画面", systemId: "sys_oms" },
  { id: "scr_inquiry", kind: "screen", name: "問い合わせ履歴", systemId: "sys_oms" },
  { id: "scr_mall_orders", kind: "screen", name: "モールの注文一覧", systemId: "sys_mall" },
  { id: "scr_payment_admin", kind: "screen", name: "決済の管理画面", systemId: "sys_payment" },
  { id: "scr_refund", kind: "screen", name: "返金の管理画面", systemId: "sys_payment" },
  { id: "scr_payout", kind: "screen", name: "入金の登録画面", systemId: "sys_accounting" },
  { id: "scr_receivable", kind: "screen", name: "売掛金の消込画面", systemId: "sys_accounting" },
  { id: "scr_monthly_report", kind: "screen", name: "月次レポート", systemId: "sys_accounting" },
  { id: "scr_pl", kind: "screen", name: "損益計算書の画面", systemId: "sys_accounting" },
  { id: "scr_balance_sheet", kind: "screen", name: "貸借対照表の画面", systemId: "sys_accounting" },
];

/** 非機能要件 (システムに属する) */
const nfrs: Element[] = [
  {
    id: "nfr_sale_peak",
    kind: "nfr",
    name: "セールの日に 1 時間 1,000 件の注文を受けても止まらない",
    systemId: "sys_oms",
    category: "performance",
    verification: "セール前に、1 時間 1,000 件の注文を流す負荷試験をして、受注一覧が 3 秒以内に開くことを確かめる。",
  },
  {
    id: "nfr_backup",
    kind: "nfr",
    name: "注文と在庫のデータは毎日控えを取り、7 日前まで戻せる",
    systemId: "sys_oms",
    category: "availability",
    verification: "月に 1 回、控えから前日の状態に戻す手順を試す。",
  },
  {
    id: "nfr_card_data",
    kind: "nfr",
    name: "カード番号を自社では保存しない",
    systemId: "sys_payment",
    category: "security",
    description: "カード番号は決済サービスの画面で入力してもらい、自社のシステムには受け取らない。",
    verification: "販売管理システムとカートのデータに、カード番号の項目が無いことを確かめる。",
  },
  {
    id: "nfr_accounting_access",
    kind: "nfr",
    name: "会計の画面は経理担当と店長だけが開ける",
    systemId: "sys_accounting",
    category: "security",
    verification: "会計システムの画面をほかの担当の ID で開けないことを確かめる。",
  },
];

const issues: Element[] = [
  {
    id: "issue_stock_sync",
    kind: "issue",
    name: "自社サイトとモールの在庫を別々に更新している",
    description: "販売管理システムの在庫を、倉庫担当が自社サイトとモールの管理画面へ手で写している。",
    severity: 5,
    targetIds: ["biz_stock", "act_update_stock"],
    analysis: {
      phenomenon: "倉庫担当が、1 日 2 回、販売管理システムの在庫を見ながら、自社サイトとモール 2 つの在庫数を手で書き換えている。セールの日は更新が追いつかない。",
      location: "入荷・在庫管理の「在庫数を更新する」。販売管理システムとモールの管理画面がつながっていない。",
      cause: "モールの管理画面には在庫を取り込む仕組みが無く、書き換えは画面での手入力しかない。更新の時刻も人によってばらつく。",
      impact: "在庫が無い商品が売れてしまう売り越しが、セールの日には 1 日に十数件起きる。受注担当が購入者へお詫びと取消の連絡をしている。",
    },
  },
  {
    id: "issue_order_entry",
    kind: "issue",
    name: "モールの注文を販売管理システムへ手で移している",
    description: "モールの注文は CSV を見ながら入力するので、注文番号が抜けることがある。",
    severity: 4,
    targetIds: ["biz_order", "act_import_order"],
  },
  {
    id: "issue_return_restock",
    kind: "issue",
    name: "返品が棚に戻るまで何日もかかる",
    severity: 4,
    targetIds: ["act_inspect_return", "act_restock"],
  },
  {
    id: "issue_shipping_delay",
    kind: "issue",
    name: "セールの翌日は出荷が遅れる",
    severity: 3,
    targetIds: ["biz_shipping", "act_pick"],
  },
  {
    id: "issue_tracking_inquiry",
    kind: "issue",
    name: "配送状況の問い合わせが多く、調べるのに手間がかかる",
    severity: 2,
    targetIds: ["act_track", "uc_search_order"],
  },
];

// ---------------------------------------------------------------- 関係

const pairs: [source: string, target: string, access?: InformationAccess][] = [
  // actorBusiness
  ["actor_warehouse", "biz_stock"],
  ["actor_order", "biz_order"],
  ["actor_warehouse", "biz_shipping"],
  ["actor_support", "biz_return"],
  ["actor_support", "biz_support"],
  ["actor_accounting", "biz_receivable"],
  ["actor_accounting", "biz_monthly"],
  // actorActivity
  ["actor_warehouse", "act_receive"],
  ["ext_supplier", "act_receive"],
  ["actor_warehouse", "act_shelve"],
  ["actor_warehouse", "act_update_stock"],
  ["actor_warehouse", "act_count"],
  ["actor_manager", "act_count"],
  ["actor_order", "act_import_order"],
  ["ext_customer", "act_import_order"],
  ["actor_order", "act_check_order"],
  ["actor_order", "act_check_payment"],
  ["actor_warehouse", "act_pick"],
  ["actor_warehouse", "act_pack"],
  ["actor_warehouse", "act_issue_label"],
  ["ext_carrier", "act_issue_label"],
  ["actor_order", "act_notify_shipping"],
  ["ext_customer", "act_notify_shipping"],
  ["actor_support", "act_accept_return"],
  ["ext_customer", "act_accept_return"],
  ["actor_warehouse", "act_inspect_return"],
  ["actor_support", "act_refund"],
  ["actor_manager", "act_refund"],
  ["actor_warehouse", "act_restock"],
  ["actor_support", "act_answer"],
  ["ext_customer", "act_answer"],
  ["actor_support", "act_track"],
  ["ext_carrier", "act_track"],
  ["actor_support", "act_record_inquiry"],
  ["actor_accounting", "act_manage_payment"],
  ["actor_accounting", "act_clear_receivable"],
  ["actor_manager", "act_review_pl"],
  ["actor_accounting", "act_review_pl"],
  ["actor_manager", "act_review_bs"],
  ["actor_accounting", "act_review_bs"],
  // activityUsecase
  ["act_receive", "uc_fill_receiving_sheet"],
  ["act_receive", "uc_register_receiving"],
  ["act_shelve", "uc_update_stock"],
  ["act_update_stock", "uc_update_stock"],
  ["act_count", "uc_record_count"],
  ["act_import_order", "uc_check_mall_order"],
  ["act_import_order", "uc_register_order"],
  ["act_check_order", "uc_search_order"],
  ["act_check_order", "uc_confirm_order"],
  ["act_check_order", "uc_cancel_order"],
  ["act_check_payment", "uc_record_payment"],
  ["act_pick", "uc_issue_pick_list"],
  ["act_issue_label", "uc_issue_label"],
  ["act_notify_shipping", "uc_record_shipment"],
  ["act_accept_return", "uc_register_return"],
  ["act_accept_return", "uc_search_order"],
  ["act_accept_return", "uc_fill_return_slip"],
  ["act_inspect_return", "uc_record_inspection"],
  ["act_refund", "uc_record_refund"],
  ["act_restock", "uc_update_stock"],
  ["act_answer", "uc_search_order"],
  ["act_answer", "uc_record_inquiry"],
  ["act_track", "uc_search_order"],
  ["act_track", "uc_record_inquiry"],
  ["act_record_inquiry", "uc_record_inquiry"],
  ["act_manage_payment", "uc_record_payout"],
  ["act_clear_receivable", "uc_clear_receivable"],
  ["act_review_pl", "uc_view_pl"],
  ["act_review_pl", "uc_report_month"],
  ["act_review_bs", "uc_view_bs"],
  ["act_review_bs", "uc_report_month"],
  // usecaseInformation (操作 → 情報: 扱う)。3 つ目は取得・保存の区別 (read: 取得だけ、write: 保存だけ、無ければ両方)。
  // 情報の置き場所 (取得元・保存先) と画面が扱う情報は、これと操作の対象から導く (0.4.0 から)
  ["uc_fill_receiving_sheet", "info_stock", "write"],
  ["uc_register_receiving", "info_product", "read"],
  ["uc_register_receiving", "info_stock"],
  ["uc_update_stock", "info_stock"],
  ["uc_record_count", "info_stock"],
  ["uc_check_mall_order", "info_order", "read"],
  ["uc_register_order", "info_order"],
  ["uc_register_order", "info_customer"],
  ["uc_search_order", "info_order", "read"],
  ["uc_search_order", "info_shipment", "read"],
  ["uc_confirm_order", "info_order"],
  ["uc_cancel_order", "info_order"],
  ["uc_allocate_stock", "info_stock"],
  ["uc_allocate_stock", "info_order", "read"],
  ["uc_record_payment", "info_order", "read"],
  ["uc_issue_pick_list", "info_order", "read"],
  ["uc_issue_pick_list", "info_product", "read"],
  ["uc_issue_label", "info_shipment"],
  ["uc_issue_label", "info_order", "read"],
  ["uc_record_shipment", "info_shipment"],
  ["uc_fill_return_slip", "info_return", "write"],
  ["uc_register_return", "info_return"],
  ["uc_register_return", "info_order", "read"],
  ["uc_record_inspection", "info_return"],
  ["uc_record_refund", "info_return", "read"],
  ["uc_record_inquiry", "info_inquiry"],
  ["uc_record_inquiry", "info_customer", "read"],
  ["uc_register_receivable", "info_receivable"],
  ["uc_register_receivable", "info_order", "read"],
  ["uc_record_payout", "info_payout"],
  ["uc_clear_receivable", "info_receivable"],
  ["uc_clear_receivable", "info_payout", "read"],
  ["uc_view_pl", "info_pl", "read"],
  ["uc_view_bs", "info_bs", "read"],
  ["uc_report_month", "info_pl", "read"],
  ["uc_report_month", "info_bs", "read"],
  // usecaseCondition
  ["uc_allocate_stock", "cond_out_of_stock"],
  ["uc_register_return", "cond_return_period"],
  ["uc_issue_pick_list", "cond_gift"],
  // informationRelated (無向)
  ["info_order", "info_customer"],
  ["info_order", "info_product"],
  ["info_order", "info_shipment"],
  ["info_return", "info_order"],
  ["info_stock", "info_product"],
  ["info_inquiry", "info_customer"],
  ["info_receivable", "info_order"],
  ["info_payout", "info_receivable"],
  // 売上は PL の収益、売掛金は BS の資産
  ["info_pl", "info_order"],
  ["info_bs", "info_receivable"],
  ["info_pl", "info_bs"],
  // informationVariation
  ["info_order", "var_channel"],
  ["info_order", "var_payment_method"],
  ["info_shipment", "var_delivery"],
  // conditionVariation
  ["cond_out_of_stock", "var_channel"],
  // conditionState
  ["cond_out_of_stock", "st_ord_confirmed"],
  ["cond_return_period", "st_ord_shipped"],
  ["cond_gift", "st_ord_paid"],
  // stateUsecase
  ["st_ord_received", "uc_confirm_order"],
  ["st_ord_received", "uc_cancel_order"],
  ["st_ord_confirmed", "uc_allocate_stock"],
  ["st_ord_confirmed", "uc_record_payment"],
  ["st_ord_paid", "uc_issue_label"],
  ["st_ord_paid", "uc_record_shipment"],
  ["st_ord_shipped", "uc_register_return"],
  ["st_ret_accepted", "uc_record_inspection"],
  ["st_ret_inspected", "uc_record_refund"],
  ["st_rec_open", "uc_clear_receivable"],
  ["st_rec_partial", "uc_clear_receivable"],
  // usecaseState
  ["uc_register_order", "st_ord_received"],
  ["uc_confirm_order", "st_ord_confirmed"],
  ["uc_cancel_order", "st_ord_cancelled"],
  ["uc_record_payment", "st_ord_paid"],
  ["uc_record_shipment", "st_ord_shipped"],
  ["uc_register_return", "st_ret_accepted"],
  ["uc_record_inspection", "st_ret_inspected"],
  ["uc_record_refund", "st_ret_refunded"],
  ["uc_register_receivable", "st_rec_open"],
  ["uc_clear_receivable", "st_rec_partial"],
  ["uc_clear_receivable", "st_rec_cleared"],
  // ---- 0.2.0 の関係 ----
  // usecaseNext (操作 → 操作: 次に)。作業の中の操作の順番
  // 注文を取り込む: モールの注文一覧で確かめてから、販売管理システムの受注入力画面に入れる (課題「モールの注文を手で移している」の所在)
  ["uc_check_mall_order", "uc_register_order"],
  // 紙に書いてからシステムに入れる
  ["uc_fill_receiving_sheet", "uc_register_receiving"],
  ["uc_fill_return_slip", "uc_register_return"],
  ["uc_search_order", "uc_confirm_order"],
  ["uc_search_order", "uc_cancel_order"],
  ["uc_search_order", "uc_register_return"],
  ["uc_search_order", "uc_record_inquiry"],
  ["uc_view_pl", "uc_report_month"],
  ["uc_view_bs", "uc_report_month"],
  // usecaseEvent (操作 → イベント: 発生)。作業の中の操作の並びは、最後にイベントを発生させて終わる
  ["uc_register_receiving", "ev_received"],
  ["uc_update_stock", "ev_stock_changed"],
  ["uc_record_count", "ev_counted"],
  ["uc_register_order", "ev_order_received"],
  ["uc_confirm_order", "ev_order_confirmed"],
  ["uc_cancel_order", "ev_order_cancelled"],
  ["uc_allocate_stock", "ev_stock_allocated"],
  ["uc_record_payment", "ev_payment_confirmed"],
  ["uc_issue_pick_list", "ev_pick_listed"],
  ["uc_issue_label", "ev_label_issued"],
  ["uc_record_shipment", "ev_shipped"],
  ["uc_register_return", "ev_return_accepted"],
  ["uc_record_inspection", "ev_return_inspected"],
  ["uc_record_refund", "ev_refunded"],
  ["uc_record_inquiry", "ev_inquiry_recorded"],
  ["uc_register_receivable", "ev_receivable_booked"],
  ["uc_record_payout", "ev_payout_recorded"],
  ["uc_clear_receivable", "ev_receivable_cleared"],
  ["uc_report_month", "ev_month_reported"],
  // systemEvent (システム → イベント: 発生)
  ["sys_cart", "ev_order_received"],
  ["sys_accounting", "ev_month_closed"],
  // eventUsecase (イベント → 操作: きっかけ)
  // 作業に属さない自動の処理: 注文が確定したら在庫を引き当て、出荷が記録されたら売掛金を登録する
  ["ev_order_confirmed", "uc_allocate_stock"],
  ["ev_shipped", "uc_register_receivable"],
  // 人の作業も、イベントをきっかけに始まるものがある
  ["ev_payment_confirmed", "uc_issue_pick_list"],
  ["ev_return_accepted", "uc_record_inspection"],
  ["ev_return_inspected", "uc_record_refund"],
  ["ev_payout_recorded", "uc_clear_receivable"],
  ["ev_month_closed", "uc_view_pl"],
  // usecaseSystem (操作 → システム・帳票: 対象)。紙の帳票への記入と、画面の無い自動の処理だけ直接結ぶ (画面のある操作は画面のシステムが対象)。対象は操作ごとに 1 つだけ
  ["uc_fill_receiving_sheet", "ldg_receiving_sheet"],
  ["uc_fill_return_slip", "ldg_return_slip"],
  ["uc_allocate_stock", "sys_oms"],
  ["uc_register_receivable", "sys_accounting"],
  // usecaseScreen (操作 → 画面。1 つの画面を使う操作は 1 つだけ)
  ["uc_check_mall_order", "scr_mall_orders"],
  ["uc_register_order", "scr_order_entry"],
  ["uc_search_order", "scr_order_list"],
  ["uc_confirm_order", "scr_order_confirm"],
  ["uc_cancel_order", "scr_order_cancel"],
  ["uc_register_receiving", "scr_receiving"],
  ["uc_update_stock", "scr_stock"],
  ["uc_record_count", "scr_stock_count"],
  ["uc_record_payment", "scr_payment_admin"],
  ["uc_issue_pick_list", "scr_shipping"],
  ["uc_issue_label", "scr_label"],
  ["uc_record_shipment", "scr_shipment_record"],
  ["uc_register_return", "scr_return"],
  ["uc_record_inspection", "scr_return_inspection"],
  ["uc_record_refund", "scr_refund"],
  ["uc_record_inquiry", "scr_inquiry"],
  ["uc_record_payout", "scr_payout"],
  ["uc_clear_receivable", "scr_receivable"],
  ["uc_view_pl", "scr_pl"],
  ["uc_view_bs", "scr_balance_sheet"],
  ["uc_report_month", "scr_monthly_report"],
  // actorNfr (アクター・外部アクター → 非機能要件: 求める)
  ["actor_order", "nfr_sale_peak"],
  ["ext_customer", "nfr_sale_peak"],
  ["actor_manager", "nfr_backup"],
  ["ext_customer", "nfr_card_data"],
  ["actor_manager", "nfr_accounting_access"],
  // activityTrigger / eventActivity (作業の起点)
  ["ev_received", "act_shelve"],
  ["act_shelve", "act_update_stock"],
  ["act_import_order", "act_check_order"],
  ["act_check_order", "act_check_payment"],
  ["ev_pick_listed", "act_pick"],
  ["act_pick", "act_pack"],
  ["act_pack", "act_issue_label"],
  ["ev_shipped", "act_notify_shipping"],
  ["ev_return_accepted", "act_inspect_return"],
  ["act_inspect_return", "act_refund"],
  ["act_inspect_return", "act_restock"],
  ["act_answer", "act_track"],
  ["act_answer", "act_record_inquiry"],
  ["act_manage_payment", "act_clear_receivable"],
  ["ev_month_closed", "act_review_pl"],
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
  ...nfrs,
  ...issues,
];

const kindOf = new Map(elements.map((e) => [e.id, e.kind]));

// 代替パターン (0.6.1): 操作が条件を判断した結果、ふだんと違う流れになるときにどうなるか (設計モードのシーケンス図の分岐)
const alternates: Record<string, RelationAlternate> = {
  "rel_uc_allocate_stock__cond_out_of_stock": { when: "met", then: "引き当てずに、入荷を待つ注文として残す。" },
  "rel_uc_register_return__cond_return_period": { when: "unmet", then: "返品を受け付けず、理由を購入者に伝える。" },
  "rel_uc_issue_pick_list__cond_gift": { when: "met", then: "ピッキングリストに、ギフト包装の指示を載せる。" },
};

const relations: Relation[] = pairs.map(([sourceId, targetId, access]) => {
  const s = kindOf.get(sourceId);
  const t = kindOf.get(targetId);
  const kind = s && t ? relationKindFor(s, t) : null;
  if (!kind) throw new Error(`サンプルの関係が引けません: ${sourceId} -> ${targetId}`);
  const id = `rel_${sourceId}__${targetId}`;
  return { id, kind, sourceId, targetId, ...(access ? { access } : {}), ...(alternates[id] ? { alternate: alternates[id] } : {}) };
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
  ...frameWithActivities("biz_stock", 40, ["act_receive", "act_shelve", "act_update_stock", "act_count"]),
  // 受注処理: 活動の小枠 3 つ (活動のある業務の作業は、すべてどれかの活動に入れる)
  { elementId: "biz_order", x: 340, y: FRAME_Y, width: 520, height: FRAME_H },
  { elementId: "buc_order_check", x: 360, y: FRAME_Y + 56, width: 220, height: 260 },
  { elementId: "act_import_order", x: 380, y: FRAME_Y + 112 },
  { elementId: "act_check_order", x: 380, y: FRAME_Y + 208 },
  { elementId: "buc_payment_check", x: 600, y: FRAME_Y + 56, width: 220, height: 160 },
  { elementId: "act_check_payment", x: 620, y: FRAME_Y + 112 },
  ...frameWithActivities("biz_shipping", 900, ["act_pick", "act_pack", "act_issue_label", "act_notify_shipping"]),
  ...frameWithActivities("biz_return", 40, ["act_accept_return", "act_inspect_return", "act_refund", "act_restock"], FRAME_Y2),
  ...frameWithActivities("biz_support", 340, ["act_answer", "act_track", "act_record_inquiry"], FRAME_Y2),
  ...frameWithActivities("biz_receivable", 640, ["act_manage_payment", "act_clear_receivable"], FRAME_Y2),
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
  ...column(events.map((e) => e.id), 1260, 40, 90),
  ...column(screens.map((e) => e.id), 1560, 40, 90),
];

const stateUsecases = [
  "uc_register_order",
  "uc_confirm_order",
  "uc_cancel_order",
  "uc_allocate_stock",
  "uc_record_payment",
  "uc_issue_label",
  "uc_record_shipment",
  "uc_register_return",
  "uc_record_inspection",
  "uc_record_refund",
  "uc_register_receivable",
  "uc_record_payout",
  "uc_clear_receivable",
];

const stateNodes: BoardNode[] = [
  ...column(flowInfos, 40, 40, 100),
  ...column(variations.map((e) => e.id), 340, 40, 100),
  ...column(flowConditions, 340, 380, 100),
  ...column(states.filter((e) => e.id.startsWith("st_ord_")).map((e) => e.id), 640, 40, 90),
  ...column(stateUsecases, 940, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_ret_")).map((e) => e.id), 1240, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_rec_")).map((e) => e.id), 1240, 360, 90),
];

// ドメインモデル (設計モードのドメインボード・コンテキストマップ。4.6)。分析から導ける候補は持たず、人が決めたことだけを置く:
// 境界づけられたコンテキスト (受注・在庫・出荷は販売管理システム、決済と会計は別のシステム)、集約と不変条件、意図の名前と英語名、
// 分析に無いあるべき姿 (決済サービスの「入金が確認された」を受けて、販売管理システムが自分で注文を入金済にする)、コンテキスト間の関係、用語。
// 顧客 (購入者・問い合わせ履歴) と、在庫の一部の操作・会計のコマンドは、まだ決めていない候補のまま残している。
const domain: DomainModel = {
  contexts: [
    { id: "bc_ordering", name: "受注", english: "Ordering", description: "注文を受け付けてから出荷を頼むまでと、返品を受け持つ。", subdomain: "core", team: "EC 運営", contextIds: ["ctx_order"], systemIds: ["sys_oms"] },
    { id: "bc_inventory", name: "在庫", english: "Inventory", description: "売れる数を正しく保つ (入荷・引き当て・棚卸)。", subdomain: "supporting", team: "倉庫", contextIds: ["ctx_item"], systemIds: ["sys_oms"] },
    { id: "bc_shipping", name: "出荷", english: "Shipping", description: "送り状を発行し、荷物を出す。", subdomain: "supporting", team: "倉庫", contextIds: ["ctx_shipping"], systemIds: ["sys_oms"] },
    { id: "bc_payment", name: "決済", english: "Payment", description: "外部の決済サービス。入金の結果だけを受け取る。", subdomain: "generic", contextIds: [], systemIds: ["sys_payment"] },
    { id: "bc_accounting", name: "会計", english: "Accounting", description: "売掛金と入金を管理し、月次の数字を出す。", subdomain: "generic", team: "経理", contextIds: ["ctx_accounting"], systemIds: ["sys_accounting"] },
  ],
  aggregates: [
    {
      id: "ag_order",
      boundedContextId: "bc_ordering",
      name: "注文",
      english: "Order",
      rootInformationId: "info_order",
      memberInformationIds: [],
      stateGroup: "注文の状態",
      invariants: [
        { id: "inv_order_paid", text: "入金済にできるのは、確定した注文だけ。" },
        { id: "inv_order_cancel", text: "出荷済の注文は取り消せない。" },
      ],
    },
    {
      id: "ag_return",
      boundedContextId: "bc_ordering",
      name: "返品",
      english: "ReturnRequest",
      rootInformationId: "info_return",
      memberInformationIds: [],
      stateGroup: "返品の状態",
      invariants: [{ id: "inv_return_period", text: "返品を受け付けるのは、返品の期間内の注文だけ。", conditionId: "cond_return_period" }],
    },
    {
      id: "ag_stock",
      boundedContextId: "bc_inventory",
      name: "在庫",
      english: "Stock",
      rootInformationId: "info_stock",
      memberInformationIds: [],
      invariants: [{ id: "inv_stock_enough", text: "引き当てる数は、引き当てていない在庫の数を超えない。", conditionId: "cond_out_of_stock" }],
    },
    {
      id: "ag_shipment",
      boundedContextId: "bc_shipping",
      name: "出荷",
      english: "Shipment",
      rootInformationId: "info_shipment",
      memberInformationIds: [],
      invariants: [{ id: "inv_shipment_label", text: "送り状を発行していない出荷は、出荷済にできない。" }],
    },
    {
      id: "ag_receivable",
      boundedContextId: "bc_accounting",
      name: "売掛金",
      english: "Receivable",
      rootInformationId: "info_receivable",
      memberInformationIds: [],
      stateGroup: "売掛金の状態",
      invariants: [{ id: "inv_receivable_clear", text: "消し込む金額の合計は、売掛金の金額を超えない。" }],
    },
    {
      id: "ag_payout",
      boundedContextId: "bc_accounting",
      name: "入金",
      english: "Payout",
      rootInformationId: "info_payout",
      memberInformationIds: [],
      invariants: [{ id: "inv_payout_once", text: "1 件の入金を、同じ売掛金へ 2 度消し込まない。" }],
    },
  ],
  commands: [
    // 分析の操作から採用したもの (記録の名前を、意図の名前に直している)
    { id: "cm_place_order", aggregateId: "ag_order", name: "注文を受け付ける", english: "PlaceOrder", source: { usecaseId: "uc_register_order" }, emits: [] },
    { id: "cm_confirm_order", aggregateId: "ag_order", name: "注文を確定する", english: "ConfirmOrder", source: { usecaseId: "uc_confirm_order" }, emits: [] },
    { id: "cm_cancel_order", aggregateId: "ag_order", name: "注文を取り消す", english: "CancelOrder", source: { usecaseId: "uc_cancel_order" }, emits: [] },
    { id: "cm_accept_return", aggregateId: "ag_return", name: "返品を受け付ける", english: "AcceptReturn", source: { usecaseId: "uc_register_return" }, emits: [] },
    { id: "cm_inspect_return", aggregateId: "ag_return", name: "返品を検品する", english: "InspectReturn", source: { usecaseId: "uc_record_inspection" }, emits: [] },
    { id: "cm_receive_stock", aggregateId: "ag_stock", name: "入荷を受け入れる", english: "ReceiveStock", source: { usecaseId: "uc_register_receiving" }, emits: [] },
    { id: "cm_allocate_stock", aggregateId: "ag_stock", name: "在庫を引き当てる", english: "AllocateStock", source: { usecaseId: "uc_allocate_stock" }, emits: [] },
    { id: "cm_issue_label", aggregateId: "ag_shipment", name: "送り状を発行する", english: "IssueShippingLabel", source: { usecaseId: "uc_issue_label" }, emits: [] },
    { id: "cm_ship", aggregateId: "ag_shipment", name: "出荷する", english: "ShipOrder", source: { usecaseId: "uc_record_shipment" }, emits: [] },
    // あるべき姿: 分析では決済サービスの操作が注文の状態を変えているが、注文を入金済にするのは受注の責務にする
    { id: "cm_mark_paid", aggregateId: "ag_order", name: "注文を入金済にする", english: "MarkOrderPaid", emits: ["de_order_paid"] },
  ],
  events: [
    { id: "de_order_placed", boundedContextId: "bc_ordering", aggregateId: "ag_order", name: "注文を受け付けた", english: "OrderPlaced", eventId: "ev_order_received" },
    { id: "de_order_confirmed", boundedContextId: "bc_ordering", aggregateId: "ag_order", name: "注文が確定した", english: "OrderConfirmed", eventId: "ev_order_confirmed" },
    { id: "de_order_cancelled", boundedContextId: "bc_ordering", aggregateId: "ag_order", name: "注文が取り消された", english: "OrderCancelled", eventId: "ev_order_cancelled" },
    { id: "de_order_paid", boundedContextId: "bc_ordering", aggregateId: "ag_order", name: "注文が入金済になった", english: "OrderPaid" },
    { id: "de_return_accepted", boundedContextId: "bc_ordering", aggregateId: "ag_return", name: "返品を受け付けた", english: "ReturnAccepted", eventId: "ev_return_accepted" },
    { id: "de_return_inspected", boundedContextId: "bc_ordering", aggregateId: "ag_return", name: "返品の検品が済んだ", english: "ReturnInspected", eventId: "ev_return_inspected" },
    { id: "de_stock_received", boundedContextId: "bc_inventory", aggregateId: "ag_stock", name: "入荷を受け入れた", english: "StockReceived", eventId: "ev_received" },
    { id: "de_stock_allocated", boundedContextId: "bc_inventory", aggregateId: "ag_stock", name: "在庫が引き当てられた", english: "StockAllocated", eventId: "ev_stock_allocated" },
    { id: "de_label_issued", boundedContextId: "bc_shipping", aggregateId: "ag_shipment", name: "送り状が発行された", english: "ShippingLabelIssued", eventId: "ev_label_issued" },
    {
      id: "de_shipped",
      boundedContextId: "bc_shipping",
      aggregateId: "ag_shipment",
      name: "出荷した",
      english: "OrderShipped",
      eventId: "ev_shipped",
      properties: [{ name: "出荷", informationId: "info_shipment" }, { name: "出荷日" }],
    },
    // 決済サービス (外部) で起きる。販売管理システムはこれを受けて、注文を入金済にする
    { id: "de_payment_confirmed", boundedContextId: "bc_payment", name: "入金が確認された", english: "PaymentConfirmed", eventId: "ev_payment_confirmed" },
  ],
  policies: [{ id: "po_mark_paid", eventId: "de_payment_confirmed", commandId: "cm_mark_paid", auto: true }],
  excluded: [],
  relations: [
    { id: "cr_ordering_inventory", upstreamId: "bc_ordering", downstreamId: "bc_inventory", kind: "customerSupplier", integration: "messaging", note: "注文が確定したら、在庫を引き当てる。" },
    { id: "cr_payment_ordering", upstreamId: "bc_payment", downstreamId: "bc_ordering", kind: "acl", integration: "messaging", note: "決済サービスの通知 (Webhook) を、受注の言葉 (入金済) に訳す。" },
    { id: "cr_ordering_shipping", upstreamId: "bc_ordering", downstreamId: "bc_shipping", kind: "customerSupplier", integration: "rpc", note: "出荷は、注文の届け先を読む。" },
    { id: "cr_shipping_accounting", upstreamId: "bc_shipping", downstreamId: "bc_accounting", kind: "publishedLanguage", integration: "messaging", note: "出荷したら、会計が売掛金を計上する。" },
    { id: "cr_ordering_accounting", upstreamId: "bc_ordering", downstreamId: "bc_accounting", kind: "conformist", integration: "file", note: "会計は、注文のデータをそのままの形で取り込む。" },
  ],
  terms: [
    { id: "tm_order", term: "注文", english: "Order", definition: "購入者からの 1 回の申し込み。受け付けから出荷か取り消しまでを 1 件として扱う。", boundedContextId: "bc_ordering", elementId: "info_order" },
    { id: "tm_stock", term: "在庫", english: "Stock", definition: "商品ごとの、倉庫にある数と引き当て済みの数。", boundedContextId: "bc_inventory", elementId: "info_stock" },
    { id: "tm_allocation", term: "引き当て", english: "Allocation", definition: "注文の分の在庫を、ほかの注文に使われないよう取り置くこと。", boundedContextId: "bc_inventory" },
  ],
};

export const netshopSample: UntieModel = {
  version: MODEL_VERSION,
  meta: {
    name: "ネットショップの業務 (サンプル)",
    description: "架空の雑貨のネットショップの業務を題材にしたサンプル。実在の店・データではありません。",
  },
  elements,
  relations,
  boards: [
    { id: "board_overview", name: "全体", nodes: overviewNodes },
    { id: "board_flow", name: "入荷から返品・問い合わせまで", nodes: flowNodes },
    { id: "board_state", name: "情報と状態", nodes: stateNodes },
  ],
  designs: [],
  databases: [],
  domain,
};

/** 呼ぶたびに独立したコピーを返す (JSON の往復。core は DOM に依存しないので structuredClone を使わない) */
export function createNetshopSample(): UntieModel {
  return JSON.parse(JSON.stringify(netshopSample)) as UntieModel;
}
