// 架空の中小企業 (従業員 50 人ほど) の経理部門のサンプルモデル。実在の会社・データは使わない。
// 請求・入金・支払・経費精算・記帳・月次決算・年次決算の流れと、現場の困りごとを置く。
// 1 つの業務の主担当は 1 人にする (業務に複数のアクターを結ぶと検証が警告を出す)。ほかの人は作業の担当にする。
import { relationKindFor } from "../model/relations";
import { MODEL_VERSION, type BoardNode, type Element, type Relation, type UntieModel } from "../model/types";

// ---------------------------------------------------------------- 要素

const actors: Element[] = [
  { id: "actor_billing", kind: "actor", name: "請求担当" },
  { id: "actor_payable", kind: "actor", name: "支払担当" },
  { id: "actor_expense", kind: "actor", name: "経費担当" },
  { id: "actor_bookkeeper", kind: "actor", name: "記帳担当" },
  { id: "actor_lead", kind: "actor", name: "経理責任者" },
  { id: "actor_executive", kind: "actor", name: "経営者" },
];

const externalActors: Element[] = [
  { id: "ext_customer", kind: "externalActor", name: "得意先" },
  { id: "ext_vendor", kind: "externalActor", name: "仕入先" },
  { id: "ext_employee", kind: "externalActor", name: "従業員" },
  { id: "ext_bank", kind: "externalActor", name: "銀行" },
  { id: "ext_tax_accountant", kind: "externalActor", name: "税理士" },
];

/** システム (自社・社外を問わない。作業の担当にも、情報の置き場所にもなる) と、紙の帳票 (情報の置き場所) */
const systems: Element[] = [
  { id: "sys_accounting", kind: "system", name: "会計システム" },
  { id: "sys_sales", kind: "system", name: "販売管理システム" },
  { id: "sys_banking", kind: "system", name: "インターネットバンキング" },
  { id: "ldg_received_invoice", kind: "ledger", name: "受領した請求書 (紙)" },
  { id: "ldg_expense_form", kind: "ledger", name: "経費精算書 (紙)" },
  { id: "ldg_petty_cash", kind: "ledger", name: "小口現金出納帳" },
];

const businessDefs: [id: string, name: string][] = [
  ["biz_billing", "請求・売掛金管理"],
  ["biz_payable", "支払・買掛金管理"],
  ["biz_expense", "経費精算"],
  ["biz_booking", "仕訳・記帳"],
  ["biz_monthly", "月次決算"],
  ["biz_annual", "年次決算・税務"],
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
  { id: "buc_invoice", kind: "buc", name: "請求", businessId: "biz_billing", isDefault: false },
  { id: "buc_receipt", kind: "buc", name: "入金の管理", businessId: "biz_billing", isDefault: false },
  { id: "buc_clearing", kind: "buc", name: "消し込み", businessId: "biz_billing", isDefault: false },
];

const dflt = (bizId: string) => `buc_default_${bizId.replace("biz_", "")}`;

const activities: Element[] = [
  { id: "act_issue_invoice", kind: "activity", name: "請求書を発行する", bucId: "buc_invoice", triggerNote: "月末の締め" },
  { id: "act_send_invoice", kind: "activity", name: "請求書を送る", bucId: "buc_invoice" },
  { id: "act_manage_receipt", kind: "activity", name: "入金を管理する", bucId: "buc_receipt" },
  { id: "act_clear_receivable", kind: "activity", name: "入金を消し込む", bucId: "buc_clearing", hours: 0.5 },
  { id: "act_receive_vendor_invoice", kind: "activity", name: "請求書を受け取る", bucId: dflt("biz_payable"), triggerNote: "取引先からの請求書の到着" },
  { id: "act_check_vendor_invoice", kind: "activity", name: "請求書の内容を確認する", bucId: dflt("biz_payable"), hours: 0.2 },
  { id: "act_approve_payment", kind: "activity", name: "支払を承認する", bucId: dflt("biz_payable") },
  { id: "act_pay", kind: "activity", name: "支払を実行する", bucId: dflt("biz_payable") },
  { id: "act_accept_expense", kind: "activity", name: "経費の申請を受け付ける", bucId: dflt("biz_expense"), triggerNote: "社員からの申請" },
  { id: "act_check_expense", kind: "activity", name: "領収書と内容を確認する", bucId: dflt("biz_expense"), hours: 0.2 },
  { id: "act_pay_expense", kind: "activity", name: "精算金を支払う", bucId: dflt("biz_expense") },
  { id: "act_journal", kind: "activity", name: "取引を仕訳する", bucId: dflt("biz_booking"), hours: 0.1, triggerNote: "取引が発生したとき" },
  {
    id: "act_keep_evidence",
    kind: "activity",
    name: "証憑を保管する",
    bucId: dflt("biz_booking"),
    // 架空のマニュアル (example.com はリンクの例示用ドメイン)
    links: [
      { title: "証憑の保管ルール", url: "https://example.com/manual/evidence-storage" },
      { title: "電子帳簿保存法への対応", url: "https://example.com/manual/e-bookkeeping" },
    ],
  },
  { id: "act_petty_cash", kind: "activity", name: "小口現金を管理する", bucId: dflt("biz_booking"), triggerNote: "小口現金の出し入れ" },
  { id: "act_check_balance", kind: "activity", name: "預金残高を確認する", bucId: dflt("biz_booking") },
  { id: "act_adjust_month", kind: "activity", name: "月末の調整仕訳を入れる", bucId: dflt("biz_monthly") },
  { id: "act_make_trial", kind: "activity", name: "試算表を作る", bucId: dflt("biz_monthly") },
  // 会計システムで、損益計算書 (PL) と貸借対照表 (BS) を見る
  { id: "act_review_pl", kind: "activity", name: "損益を確認する", bucId: dflt("biz_monthly") },
  { id: "act_review_bs", kind: "activity", name: "財務の状況を確認する", bucId: dflt("biz_monthly") },
  { id: "act_year_adjust", kind: "activity", name: "決算整理をする", bucId: dflt("biz_annual"), triggerNote: "決算月の終了" },
  { id: "act_make_statements", kind: "activity", name: "決算書を作る", bucId: dflt("biz_annual") },
  { id: "act_tax_filing", kind: "activity", name: "申告の資料を税理士とそろえる", bucId: dflt("biz_annual") },
];

const usecases: Element[] = [
  { id: "uc_issue_invoice", kind: "usecase", name: "請求書を発行する" },
  { id: "uc_record_receipt", kind: "usecase", name: "入金を登録する" },
  { id: "uc_clear_receivable", kind: "usecase", name: "売掛金を消し込む" },
  { id: "uc_register_vendor_invoice", kind: "usecase", name: "受領した請求書を登録する", hours: 0.1 },
  { id: "uc_search_voucher", kind: "usecase", name: "取引の記録を検索する", hours: 0.1 },
  { id: "uc_approve_payment", kind: "usecase", name: "支払を承認する" },
  {
    id: "uc_issue_transfer",
    kind: "usecase",
    name: "振込データを作る",
    links: [{ title: "インターネットバンキングの総合振込の手順", url: "https://example.com/manual/bank-transfer" }],
  },
  { id: "uc_register_expense", kind: "usecase", name: "経費を登録する" },
  { id: "uc_record_journal", kind: "usecase", name: "仕訳を登録する" },
  { id: "uc_record_petty_cash", kind: "usecase", name: "小口現金を記録する" },
  { id: "uc_match_balance", kind: "usecase", name: "預金残高を照合する" },
  { id: "uc_adjust_entry", kind: "usecase", name: "調整仕訳を登録する" },
  { id: "uc_issue_trial", kind: "usecase", name: "試算表を出力する" },
  { id: "uc_close_month", kind: "usecase", name: "月次決算を確定する" },
  { id: "uc_view_pl", kind: "usecase", name: "損益計算書を見る" },
  { id: "uc_view_bs", kind: "usecase", name: "貸借対照表を見る" },
  { id: "uc_issue_statements", kind: "usecase", name: "決算書を出力する" },
];

/** 役割の同じ情報と、それに関係の深い状態・条件・バリエーションをまとめる親カテゴリ */
const contexts: Element[] = [
  { id: "ctx_sales", kind: "context", name: "売上・売掛" },
  { id: "ctx_purchase", kind: "context", name: "仕入・支払" },
  { id: "ctx_expense", kind: "context", name: "経費" },
  { id: "ctx_books", kind: "context", name: "帳簿・決算" },
];

const informations: Element[] = [
  { id: "info_invoice", kind: "information", name: "請求書", contextId: "ctx_sales" },
  { id: "info_receivable", kind: "information", name: "売掛金", contextId: "ctx_sales" },
  { id: "info_receipt", kind: "information", name: "入金", contextId: "ctx_sales" },
  { id: "info_vendor_invoice", kind: "information", name: "仕入先の請求書", contextId: "ctx_purchase" },
  { id: "info_payable", kind: "information", name: "買掛金", contextId: "ctx_purchase" },
  { id: "info_payment", kind: "information", name: "支払", contextId: "ctx_purchase" },
  { id: "info_expense", kind: "information", name: "経費の申請", contextId: "ctx_expense" },
  { id: "info_journal", kind: "information", name: "仕訳", contextId: "ctx_books" },
  { id: "info_petty_cash", kind: "information", name: "小口現金", contextId: "ctx_books" },
  { id: "info_trial", kind: "information", name: "試算表", contextId: "ctx_books" },
  { id: "info_pl", kind: "information", name: "損益計算書 (PL)", contextId: "ctx_books" },
  { id: "info_bs", kind: "information", name: "貸借対照表 (BS)", contextId: "ctx_books" },
];

const states: Element[] = [
  { id: "st_rec_open", kind: "state", name: "未入金", group: "売掛金の状態", contextId: "ctx_sales" },
  { id: "st_rec_partial", kind: "state", name: "一部入金", group: "売掛金の状態", contextId: "ctx_sales" },
  { id: "st_rec_cleared", kind: "state", name: "消込済", group: "売掛金の状態", contextId: "ctx_sales" },
  { id: "st_pay_received", kind: "state", name: "受領済", group: "支払の状態", contextId: "ctx_purchase" },
  { id: "st_pay_approved", kind: "state", name: "承認済", group: "支払の状態", contextId: "ctx_purchase" },
  { id: "st_pay_paid", kind: "state", name: "支払済", group: "支払の状態", contextId: "ctx_purchase" },
  { id: "st_month_open", kind: "state", name: "調整中", group: "月次決算の状態", contextId: "ctx_books" },
  { id: "st_month_trial", kind: "state", name: "試算表作成済", group: "月次決算の状態", contextId: "ctx_books" },
  { id: "st_month_closed", kind: "state", name: "確定", group: "月次決算の状態", contextId: "ctx_books" },
];

const variations: Element[] = [
  { id: "var_receipt_method", kind: "variation", name: "入金の方法", values: ["銀行振込", "口座振替", "クレジットカード"], contextId: "ctx_sales" },
  { id: "var_expense_type", kind: "variation", name: "経費の区分", values: ["交通費", "交際費", "消耗品費"], contextId: "ctx_expense" },
  { id: "var_tax", kind: "variation", name: "税区分", values: ["課税 10%", "軽減税率 8%", "非課税"], contextId: "ctx_purchase" },
];

const conditions: Element[] = [
  { id: "cond_diff", kind: "condition", name: "入金額が請求額と違う", description: "振込手数料の差し引きや、複数の請求書のまとめ払いで差が出る。", contextId: "ctx_sales" },
  { id: "cond_approval_limit", kind: "condition", name: "支払が承認の上限を超えている", description: "10 万円を超える支払は、経営者の承認が要る。", contextId: "ctx_purchase" },
  { id: "cond_invoice_no", kind: "condition", name: "適格請求書の登録番号がある", contextId: "ctx_purchase" },
];

const issues: Element[] = [
  {
    id: "issue_clearing_peak",
    kind: "issue",
    name: "月末月初に入金の消し込みが集中し、月次決算が遅れる",
    description: "入金データの名義が請求先の名前と一致せず、目で突き合わせている。",
    severity: 5,
    targetIds: ["biz_billing", "act_clear_receivable"],
    analysis: {
      phenomenon: "請求担当が、月末月初に 1 か月分の入金 (数百件) をまとめて消し込んでいる。銀行の入金データと請求書を、画面を見ながら 1 件ずつ合わせている。",
      location: "請求・売掛金管理の「入金を消し込む」。インターネットバンキングの入金データと、会計システムの売掛金がつながっていない。",
      cause: "振込の名義が、請求先の会社名と違う書き方 (略称・カナ) で届く。振込手数料の差し引きや、複数の請求書のまとめ払いで金額も合わない。",
      impact: "消し込みが終わるまで売掛金が確定せず、月次決算が毎月 5 営業日ほど遅れる。未入金の督促も遅れる。",
    },
  },
  {
    id: "issue_paper_invoice",
    kind: "issue",
    name: "紙の請求書を会計システムへ手で入力している",
    description: "桁違いや表記ゆれのミスが、支払の直前まで見つからないことがある。",
    severity: 4,
    targetIds: ["biz_payable", "act_check_vendor_invoice"],
  },
  {
    id: "issue_paper_expense",
    kind: "issue",
    name: "経費精算が紙で、確認と差し戻しに時間がかかる",
    severity: 4,
    targetIds: ["biz_expense", "act_check_expense"],
  },
  {
    id: "issue_pl_revised",
    kind: "issue",
    name: "月次の損益があとから直され、経営者の見る数字が変わる",
    severity: 3,
    targetIds: ["act_adjust_month", "act_review_pl"],
  },
  {
    id: "issue_person_dependent",
    kind: "issue",
    name: "仕訳の手順が担当者ごとに違い、担当者が休むと止まる",
    severity: 2,
    targetIds: ["biz_booking", "act_journal"],
  },
];

// ---------------------------------------------------------------- 関係

const pairs: [source: string, target: string][] = [
  // actorBusiness (1 つの業務の主担当は 1 人)
  ["actor_billing", "biz_billing"],
  ["actor_payable", "biz_payable"],
  ["actor_expense", "biz_expense"],
  ["actor_bookkeeper", "biz_booking"],
  ["actor_lead", "biz_monthly"],
  ["actor_lead", "biz_annual"],
  // actorActivity
  ["actor_billing", "act_issue_invoice"],
  ["actor_billing", "act_send_invoice"],
  ["ext_customer", "act_send_invoice"],
  ["actor_billing", "act_manage_receipt"],
  ["ext_bank", "act_manage_receipt"],
  // 会計システムが担当する作業 (売掛金と入金の管理、消し込み)
  ["actor_billing", "act_clear_receivable"],
  ["actor_payable", "act_receive_vendor_invoice"],
  ["ext_vendor", "act_receive_vendor_invoice"],
  ["actor_payable", "act_check_vendor_invoice"],
  ["actor_lead", "act_approve_payment"],
  ["actor_executive", "act_approve_payment"],
  ["actor_payable", "act_pay"],
  ["ext_bank", "act_pay"],
  ["actor_expense", "act_accept_expense"],
  ["ext_employee", "act_accept_expense"],
  ["actor_expense", "act_check_expense"],
  ["actor_expense", "act_pay_expense"],
  ["actor_bookkeeper", "act_journal"],
  ["actor_bookkeeper", "act_keep_evidence"],
  ["actor_bookkeeper", "act_petty_cash"],
  ["actor_bookkeeper", "act_check_balance"],
  ["ext_bank", "act_check_balance"],
  ["actor_lead", "act_adjust_month"],
  ["actor_lead", "act_make_trial"],
  ["actor_lead", "act_review_pl"],
  ["actor_executive", "act_review_pl"],
  ["actor_lead", "act_review_bs"],
  ["actor_executive", "act_review_bs"],
  ["actor_lead", "act_year_adjust"],
  ["actor_lead", "act_make_statements"],
  ["actor_lead", "act_tax_filing"],
  ["ext_tax_accountant", "act_tax_filing"],
  // activityUsecase
  ["act_issue_invoice", "uc_issue_invoice"],
  ["act_manage_receipt", "uc_record_receipt"],
  ["act_clear_receivable", "uc_clear_receivable"],
  ["act_receive_vendor_invoice", "uc_register_vendor_invoice"],
  ["act_check_vendor_invoice", "uc_search_voucher"],
  ["act_approve_payment", "uc_approve_payment"],
  ["act_pay", "uc_issue_transfer"],
  ["act_accept_expense", "uc_register_expense"],
  ["act_check_expense", "uc_search_voucher"],
  ["act_pay_expense", "uc_issue_transfer"],
  ["act_journal", "uc_record_journal"],
  ["act_petty_cash", "uc_record_petty_cash"],
  ["act_check_balance", "uc_match_balance"],
  ["act_adjust_month", "uc_adjust_entry"],
  ["act_make_trial", "uc_issue_trial"],
  ["act_make_trial", "uc_close_month"],
  ["act_review_pl", "uc_view_pl"],
  ["act_review_bs", "uc_view_bs"],
  ["act_year_adjust", "uc_adjust_entry"],
  ["act_make_statements", "uc_issue_statements"],
  // usecaseInformation
  ["uc_issue_invoice", "info_invoice"],
  ["uc_issue_invoice", "info_receivable"],
  ["uc_record_receipt", "info_receipt"],
  ["uc_clear_receivable", "info_receivable"],
  ["uc_clear_receivable", "info_receipt"],
  ["uc_register_vendor_invoice", "info_vendor_invoice"],
  ["uc_register_vendor_invoice", "info_payable"],
  ["uc_search_voucher", "info_vendor_invoice"],
  ["uc_search_voucher", "info_expense"],
  ["uc_approve_payment", "info_payable"],
  ["uc_issue_transfer", "info_payment"],
  ["uc_issue_transfer", "info_payable"],
  ["uc_issue_transfer", "info_expense"],
  ["uc_register_expense", "info_expense"],
  ["uc_record_journal", "info_journal"],
  ["uc_record_petty_cash", "info_petty_cash"],
  ["uc_record_petty_cash", "info_journal"],
  ["uc_match_balance", "info_journal"],
  ["uc_match_balance", "info_receipt"],
  ["uc_adjust_entry", "info_journal"],
  ["uc_issue_trial", "info_trial"],
  ["uc_issue_trial", "info_journal"],
  ["uc_close_month", "info_trial"],
  ["uc_view_pl", "info_pl"],
  ["uc_view_bs", "info_bs"],
  ["uc_issue_statements", "info_pl"],
  ["uc_issue_statements", "info_bs"],
  // usecaseCondition
  ["uc_clear_receivable", "cond_diff"],
  ["uc_approve_payment", "cond_approval_limit"],
  ["uc_register_vendor_invoice", "cond_invoice_no"],
  // informationRelated (無向)
  ["info_invoice", "info_receivable"],
  ["info_receipt", "info_receivable"],
  ["info_vendor_invoice", "info_payable"],
  ["info_payment", "info_payable"],
  ["info_expense", "info_journal"],
  ["info_journal", "info_trial"],
  ["info_trial", "info_pl"],
  ["info_trial", "info_bs"],
  ["info_pl", "info_bs"],
  // 売上は PL の収益、売掛金・買掛金は BS の資産・負債
  ["info_pl", "info_invoice"],
  ["info_bs", "info_receivable"],
  ["info_bs", "info_payable"],
  // systemInformation (システム → 情報: 取得元)
  ["sys_accounting", "info_receivable"],
  ["sys_accounting", "info_receipt"],
  ["sys_accounting", "info_payable"],
  ["sys_accounting", "info_journal"],
  ["sys_accounting", "info_trial"],
  // 会計システムで PL と BS を見られる
  ["sys_accounting", "info_pl"],
  ["sys_accounting", "info_bs"],
  ["sys_sales", "info_invoice"],
  ["sys_banking", "info_receipt"],
  ["sys_banking", "info_payment"],
  // informationSystem (情報 → システム: 保存先)
  ["info_invoice", "sys_sales"],
  ["info_receivable", "sys_accounting"],
  ["info_receipt", "sys_accounting"],
  ["info_payable", "sys_accounting"],
  ["info_journal", "sys_accounting"],
  ["info_trial", "sys_accounting"],
  ["info_payment", "sys_banking"],
  ["info_vendor_invoice", "ldg_received_invoice"],
  ["info_expense", "ldg_expense_form"],
  ["info_petty_cash", "ldg_petty_cash"],
  // informationVariation
  ["info_receipt", "var_receipt_method"],
  ["info_expense", "var_expense_type"],
  ["info_vendor_invoice", "var_tax"],
  // conditionVariation
  ["cond_invoice_no", "var_tax"],
  // conditionState
  ["cond_diff", "st_rec_open"],
  ["cond_approval_limit", "st_pay_received"],
  ["cond_invoice_no", "st_pay_received"],
  // stateUsecase
  ["st_rec_open", "uc_clear_receivable"],
  ["st_rec_partial", "uc_clear_receivable"],
  ["st_pay_received", "uc_approve_payment"],
  ["st_pay_approved", "uc_issue_transfer"],
  ["st_month_open", "uc_adjust_entry"],
  ["st_month_open", "uc_issue_trial"],
  ["st_month_trial", "uc_close_month"],
  ["st_month_trial", "uc_view_pl"],
  ["st_month_trial", "uc_view_bs"],
  // usecaseState
  ["uc_issue_invoice", "st_rec_open"],
  ["uc_clear_receivable", "st_rec_partial"],
  ["uc_clear_receivable", "st_rec_cleared"],
  ["uc_register_vendor_invoice", "st_pay_received"],
  ["uc_approve_payment", "st_pay_approved"],
  ["uc_issue_transfer", "st_pay_paid"],
  ["uc_adjust_entry", "st_month_open"],
  ["uc_issue_trial", "st_month_trial"],
  ["uc_close_month", "st_month_closed"],
  // usecaseSystem (操作 → システム・帳票: 対象)。0.2.0 から、システムは作業の担当ではなく操作の対象にする
  ["uc_issue_invoice", "sys_sales"],
  ["uc_record_receipt", "sys_accounting"],
  ["uc_clear_receivable", "sys_accounting"],
  ["uc_issue_transfer", "sys_banking"],
  ["uc_record_journal", "sys_accounting"],
  ["uc_adjust_entry", "sys_accounting"],
  ["uc_issue_trial", "sys_accounting"],
  ["uc_close_month", "sys_accounting"],
  ["uc_issue_statements", "sys_accounting"],
  // activityTrigger / eventActivity (作業の起点)
  ["act_issue_invoice", "act_send_invoice"],
  ["act_send_invoice", "act_manage_receipt"],
  ["act_manage_receipt", "act_clear_receivable"],
  ["act_receive_vendor_invoice", "act_check_vendor_invoice"],
  ["act_check_vendor_invoice", "act_approve_payment"],
  ["act_approve_payment", "act_pay"],
  ["act_accept_expense", "act_check_expense"],
  ["act_check_expense", "act_pay_expense"],
  ["act_journal", "act_keep_evidence"],
  ["act_journal", "act_check_balance"],
  ["act_adjust_month", "act_make_trial"],
  ["act_make_trial", "act_review_pl"],
  ["act_review_pl", "act_review_bs"],
  ["act_year_adjust", "act_make_statements"],
  ["act_make_statements", "act_tax_filing"],
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
  // 請求・売掛金管理: 活動の小枠 3 つ (活動のある業務の作業は、すべてどれかの活動に入れる)
  { elementId: "biz_billing", x: 40, y: FRAME_Y, width: 520, height: FRAME_H },
  { elementId: "buc_invoice", x: 60, y: FRAME_Y + 56, width: 220, height: 260 },
  { elementId: "act_issue_invoice", x: 80, y: FRAME_Y + 112 },
  { elementId: "act_send_invoice", x: 80, y: FRAME_Y + 208 },
  { elementId: "buc_receipt", x: 300, y: FRAME_Y + 56, width: 220, height: 160 },
  { elementId: "act_manage_receipt", x: 320, y: FRAME_Y + 112 },
  { elementId: "buc_clearing", x: 300, y: FRAME_Y + 236, width: 220, height: 160 },
  { elementId: "act_clear_receivable", x: 320, y: FRAME_Y + 292 },
  ...frameWithActivities("biz_payable", 600, ["act_receive_vendor_invoice", "act_check_vendor_invoice", "act_approve_payment", "act_pay"]),
  ...frameWithActivities("biz_expense", 900, ["act_accept_expense", "act_check_expense", "act_pay_expense"]),
  ...frameWithActivities("biz_booking", 40, ["act_journal", "act_keep_evidence", "act_petty_cash", "act_check_balance"], FRAME_Y2),
  ...frameWithActivities("biz_monthly", 340, ["act_adjust_month", "act_make_trial", "act_review_pl", "act_review_bs"], FRAME_Y2),
  ...frameWithActivities("biz_annual", 640, ["act_year_adjust", "act_make_statements", "act_tax_filing"], FRAME_Y2),
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
  "uc_issue_invoice",
  "uc_clear_receivable",
  "uc_register_vendor_invoice",
  "uc_approve_payment",
  "uc_issue_transfer",
  "uc_adjust_entry",
  "uc_issue_trial",
  "uc_close_month",
  "uc_view_pl",
  "uc_view_bs",
];

const stateNodes: BoardNode[] = [
  ...column(flowInfos, 40, 40, 100),
  ...column(variations.map((e) => e.id), 340, 40, 100),
  ...column(flowConditions, 340, 380, 100),
  ...column(states.filter((e) => e.id.startsWith("st_rec_")).map((e) => e.id), 640, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_pay_")).map((e) => e.id), 640, 360, 90),
  ...column(stateUsecases, 940, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_month_")).map((e) => e.id), 1240, 40, 90),
];

export const accountingSample: UntieModel = {
  version: MODEL_VERSION,
  meta: {
    name: "経理業務 (サンプル)",
    description: "架空の中小企業の経理部門の業務を題材にしたサンプル。実在の会社・データではありません。",
  },
  elements,
  relations,
  boards: [
    { id: "board_overview", name: "全体", nodes: overviewNodes },
    { id: "board_flow", name: "請求・支払から決算まで", nodes: flowNodes },
    { id: "board_state", name: "情報と状態", nodes: stateNodes },
  ],
};

/** 呼ぶたびに独立したコピーを返す (JSON の往復。core は DOM に依存しないので structuredClone を使わない) */
export function createAccountingSample(): UntieModel {
  return JSON.parse(JSON.stringify(accountingSample)) as UntieModel;
}
