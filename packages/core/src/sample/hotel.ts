// 架空の宿泊施設のサンプルモデル (設計書 7 章)。実在の施設・データは使わない。
import { relationKindFor } from "../model/relations";
import { emptyDomain, MODEL_VERSION, type BoardNode, type Element, type InformationAccess, type Relation, type UntieModel } from "../model/types";

// ---------------------------------------------------------------- 要素

const actors: Element[] = [
  { id: "actor_reservation", kind: "actor", name: "予約担当", persona: { handle: "山口さん (予約担当・34歳)", attributes: "勤続 7 年・正社員・日勤", background: "電話と予約サイトの予約を受け付け、部屋の空きを見ながら確定まで進める。転記の手間と二重予約を気にしている", goals: "予約の入力ミスをなくし、確認の電話を減らす", itSkill: "normal" } },
  { id: "actor_front", kind: "actor", name: "フロント担当", persona: { handle: "中村さん (フロント担当・29歳)", attributes: "勤続 5 年・正社員・早番と遅番の交代", background: "到着から精算までの接客を一人で回し、繁忙期のチェックインの列に追われる", goals: "お客様を待たせずに案内する", itSkill: "comfortable" } },
  { id: "actor_housekeeping", kind: "actor", name: "清掃担当", persona: { handle: "小林さん (清掃担当・58歳)", attributes: "勤続 12 年・パート (午前中心)", background: "客室の清掃と点検を任され、チェックアウト直後の部屋を急いで整える", goals: "部屋の状態を連絡の手間なく伝える", itSkill: "uncomfortable" } },
  { id: "actor_manager", kind: "actor", name: "支配人", persona: { handle: "加藤さん (支配人・50歳)", attributes: "支配人歴 6 年・正社員", background: "稼働と接客の質に責任を持ち、清掃の段取りと人の配置を決める", goals: "客室の稼働を保ちつつ残業を減らす", itSkill: "normal" } },
];

const externalActors: Element[] = [
  { id: "ext_guest", kind: "externalActor", name: "宿泊客", persona: { handle: "出張で来る会社員 (40 代)", attributes: "年に 10 回ほど・1 泊が中心", background: "朝が早く、チェックインとチェックアウトの待ち時間を嫌う", goals: "手続きを短く済ませて休む", itSkill: "normal" } },
  { id: "ext_travel_agency", kind: "externalActor", name: "旅行会社", persona: { handle: "団体旅行の手配担当 (40 代)", attributes: "月に数件・団体や記念旅行の予約", background: "電話とメールで部屋数や日程を調整し、変更や取消を直前に伝えることが多い", goals: "希望の日程で確実に部屋を押さえる", itSkill: "normal" } },
];

/** システム (自社・社外を問わない。作業の担当にも、情報の置き場所にもなる) と、紙の帳票 (情報の置き場所) */
const systems: Element[] = [
  { id: "sys_pms", kind: "system", name: "宿泊管理システム" },
  { id: "sys_accounting", kind: "system", name: "会計システム" },
  { id: "sys_booking_site", kind: "system", name: "予約サイト" },
  { id: "sys_payment", kind: "system", name: "決済サービス" },
  { id: "ldg_guest_register", kind: "ledger", name: "宿泊者名簿" },
  { id: "ldg_cleaning_sheet", kind: "ledger", name: "清掃チェック表" },
];

const businessDefs: [id: string, name: string][] = [
  ["biz_reservation", "予約受付"],
  ["biz_checkin", "チェックイン"],
  ["biz_stay", "滞在中の対応"],
  ["biz_checkout", "チェックアウト"],
  ["biz_cleaning", "清掃・準備"],
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
  { id: "buc_room_care", kind: "buc", name: "客室対応", businessId: "biz_stay", isDefault: false },
  { id: "buc_dining", kind: "buc", name: "飲食提供", businessId: "biz_stay", isDefault: false },
  { id: "buc_extra_charge", kind: "buc", name: "追加料金の対応", businessId: "biz_stay", isDefault: false },
];

const dflt = (bizId: string) => `buc_default_${bizId.replace("biz_", "")}`;

const activities: Element[] = [
  { id: "act_accept_reservation", kind: "activity", name: "予約を受け付ける", bucId: dflt("biz_reservation"), triggerNote: "電話・予約サイトからの申し込み" },
  { id: "act_confirm_reservation", kind: "activity", name: "予約内容を確認する", bucId: dflt("biz_reservation") },
  { id: "act_change_cancel", kind: "activity", name: "予約を変更・取消する", bucId: dflt("biz_reservation"), triggerNote: "宿泊客からの電話・メール" },
  { id: "act_confirm_arrival", kind: "activity", name: "到着を確認する", bucId: dflt("biz_checkin"), triggerNote: "宿泊客の来館" },
  { id: "act_verify_identity", kind: "activity", name: "本人確認をする", bucId: dflt("biz_checkin"), hours: 0.1 },
  { id: "act_assign_room", kind: "activity", name: "部屋を割り当てる", bucId: dflt("biz_checkin") },
  {
    id: "act_hand_key",
    kind: "activity",
    name: "鍵を渡す",
    bucId: dflt("biz_checkin"),
    // 架空のマニュアル (example.com はリンクの例示用ドメイン)
    links: [
      { title: "鍵の受け渡しマニュアル", url: "https://example.com/manual/key-handover" },
      { title: "鍵の保管ルール", url: "https://example.com/manual/key-storage" },
    ],
  },
  { id: "act_room_request", kind: "activity", name: "客室の要望に応える", bucId: "buc_room_care", triggerNote: "客室からの電話" },
  { id: "act_room_service", kind: "activity", name: "ルームサービスを提供する", bucId: "buc_dining" },
  { id: "act_record_extra", kind: "activity", name: "追加料金を記録する", bucId: "buc_extra_charge" },
  { id: "act_create_bill", kind: "activity", name: "請求を作成する", bucId: dflt("biz_checkout") },
  { id: "act_settle", kind: "activity", name: "精算する", bucId: dflt("biz_checkout") },
  { id: "act_collect_key", kind: "activity", name: "鍵を回収する", bucId: dflt("biz_checkout") },
  { id: "act_instruct_cleaning", kind: "activity", name: "清掃を指示する", bucId: dflt("biz_cleaning") },
  { id: "act_clean", kind: "activity", name: "清掃する", bucId: dflt("biz_cleaning"), hours: 0.5 },
  { id: "act_inspect_room", kind: "activity", name: "部屋を点検する", bucId: dflt("biz_cleaning") },
];

const usecases: Element[] = [
  { id: "uc_register_reservation", kind: "usecase", name: "予約を登録する" },
  { id: "uc_confirm_reservation", kind: "usecase", name: "予約を確定する" },
  { id: "uc_search_reservation", kind: "usecase", name: "予約を検索する", hours: 0.1 },
  { id: "uc_change_reservation", kind: "usecase", name: "予約を変更する" },
  { id: "uc_cancel_reservation", kind: "usecase", name: "予約を取り消す" },
  {
    id: "uc_record_checkin",
    kind: "usecase",
    name: "チェックインを記録する",
    hours: 0.2,
    links: [{ title: "宿泊管理システム操作手順 (チェックイン)", url: "https://example.com/manual/pms-checkin" }],
  },
  { id: "uc_fill_register", kind: "usecase", name: "宿泊者名簿に記入する" },
  { id: "uc_assign_room", kind: "usecase", name: "部屋の割り当てを記録する", hours: 0.1 },
  { id: "uc_calc_charge", kind: "usecase", name: "請求金額を計算する" },
  { id: "uc_register_extra", kind: "usecase", name: "追加料金を登録する" },
  { id: "uc_issue_invoice", kind: "usecase", name: "請求書を発行する" },
  { id: "uc_record_payment", kind: "usecase", name: "決済を記録する" },
  { id: "uc_record_sales", kind: "usecase", name: "売上を計上する" },
  { id: "uc_record_checkout", kind: "usecase", name: "チェックアウトを記録する" },
  { id: "uc_update_cleaning", kind: "usecase", name: "清掃状況を更新する" },
];

/** 社内のシステムの画面 (1 つの画面は 1 つの操作だけが使う) */
const screens: Element[] = [
  { id: "scr_reservation_confirm", kind: "screen", name: "予約の確定画面", description: "仮予約の内容を確かめ、予約を確定する画面。", systemId: "sys_pms" },
  { id: "scr_reservation_search", kind: "screen", name: "予約の検索画面", description: "名前や日付から予約を探す画面。", systemId: "sys_pms" },
  { id: "scr_reservation_change", kind: "screen", name: "予約の変更画面", description: "予約の日程や人数を変更する画面。", systemId: "sys_pms" },
  { id: "scr_reservation_cancel", kind: "screen", name: "予約の取消画面", description: "予約を取り消し、取消料を確認する画面。", systemId: "sys_pms" },
  { id: "scr_checkin", kind: "screen", name: "チェックインの画面", description: "到着した宿泊客のチェックインを記録する画面。", systemId: "sys_pms" },
  { id: "scr_room_assign", kind: "screen", name: "部屋の割り当て画面", description: "予約に部屋を割り当てる画面。", systemId: "sys_pms" },
  { id: "scr_extra_charge", kind: "screen", name: "追加料金の登録画面", description: "滞在中の追加料金を請求に登録する画面。", systemId: "sys_pms" },
  { id: "scr_invoice", kind: "screen", name: "請求書の発行画面", description: "請求書を作って発行する画面。", systemId: "sys_pms" },
  { id: "scr_checkout", kind: "screen", name: "チェックアウトの画面", description: "チェックアウトを記録し、部屋を清掃待ちにする画面。", systemId: "sys_pms" },
  { id: "scr_sales_record", kind: "screen", name: "売上の計上画面", description: "宿泊料金の売上を会計システムへ計上する画面。", systemId: "sys_accounting" },
];

/** 役割の同じ情報と、それに関係の深い状態・条件・バリエーションをまとめる親カテゴリ */
const contexts: Element[] = [
  { id: "ctx_reservation", kind: "context", name: "予約" },
  { id: "ctx_customer", kind: "context", name: "顧客" },
  { id: "ctx_room", kind: "context", name: "客室" },
  { id: "ctx_charge", kind: "context", name: "料金" },
];

const informations: Element[] = [
  { id: "info_reservation", kind: "information", name: "予約", contextId: "ctx_reservation" },
  { id: "info_guest", kind: "information", name: "宿泊客", contextId: "ctx_customer" },
  { id: "info_room", kind: "information", name: "部屋", contextId: "ctx_room" },
  { id: "info_plan", kind: "information", name: "料金プラン", contextId: "ctx_charge" },
  { id: "info_bill", kind: "information", name: "請求", contextId: "ctx_charge" },
  { id: "info_cleaning_record", kind: "information", name: "清掃記録", contextId: "ctx_room" },
];

const states: Element[] = [
  { id: "st_res_tentative", kind: "state", name: "仮予約", group: "予約の状態", contextId: "ctx_reservation" },
  { id: "st_res_confirmed", kind: "state", name: "確定", group: "予約の状態", contextId: "ctx_reservation" },
  { id: "st_res_checkedin", kind: "state", name: "チェックイン済", group: "予約の状態", contextId: "ctx_reservation" },
  { id: "st_res_checkedout", kind: "state", name: "チェックアウト済", group: "予約の状態", contextId: "ctx_reservation" },
  { id: "st_res_cancelled", kind: "state", name: "取消", group: "予約の状態", contextId: "ctx_reservation" },
  { id: "st_room_waiting", kind: "state", name: "清掃待ち", group: "部屋の状態", contextId: "ctx_room" },
  { id: "st_room_cleaning", kind: "state", name: "清掃中", group: "部屋の状態", contextId: "ctx_room" },
  { id: "st_room_ready", kind: "state", name: "準備完了", group: "部屋の状態", contextId: "ctx_room" },
  { id: "st_room_inuse", kind: "state", name: "使用中", group: "部屋の状態", contextId: "ctx_room" },
];

const variations: Element[] = [
  { id: "var_room_type", kind: "variation", name: "部屋タイプ", values: ["シングル", "ツイン", "スイート"], contextId: "ctx_room" },
  { id: "var_channel", kind: "variation", name: "予約経路", values: ["電話", "予約サイト", "直接来館"], contextId: "ctx_reservation" },
  { id: "var_payment_method", kind: "variation", name: "支払方法", values: ["現金", "クレジットカード", "事前決済"], contextId: "ctx_charge" },
];

const conditions: Element[] = [
  { id: "cond_cancel_fee", kind: "condition", name: "取消料が発生する", description: "宿泊日が近い取消は取消料がかかる。", contextId: "ctx_reservation" },
  { id: "cond_early_checkin", kind: "condition", name: "早めのチェックインができる", contextId: "ctx_room" },
  { id: "cond_full", kind: "condition", name: "満室である", contextId: "ctx_room" },
];

/** イベント (操作やシステムが発生させる出来事)。宿泊料金の計算は、人の作業ではなくイベントをきっかけにした自動の処理 */
const events: Element[] = [
  { id: "ev_checkout_day", kind: "event", name: "チェックアウトの日になった", contextId: "ctx_charge", timing: { type: "scheduled", every: "day", hour: 0, minute: 5, note: "日付が変わったら、その日にチェックアウトする予約をまとめて拾う" } },
  { id: "ev_charge_calculated", kind: "event", name: "請求金額が計算された", contextId: "ctx_charge" },
];

const issues: Element[] = [
  {
    id: "issue_manual_entry",
    kind: "issue",
    name: "予約サイトからの予約を手で転記している",
    description: "予約サイトの管理画面を見ながら、予約台帳へ手入力している。",
    severity: 5,
    targetIds: ["biz_reservation", "act_accept_reservation"],
    analysis: {
      phenomenon: "予約サイトに入った予約を、予約担当が 1 日 2 回まとめて宿泊管理システムに手入力している。繁忙期は 1 回 30 件を超える。",
      location: "予約受付の「予約を受け付ける」。予約サイトと宿泊管理システムがつながっていない。",
      cause: "予約サイトからは管理画面でしか予約を見られず、宿泊管理システムに取り込む手段が無い。",
      impact: "転記ミスで部屋の二重割り当てが月に数件起き、フロント担当がチェックイン時に対応している。",
    },
  },
  {
    id: "issue_checkin_queue",
    kind: "issue",
    name: "繁忙期にチェックインの列ができる",
    severity: 4,
    targetIds: ["biz_checkin", "act_verify_identity"],
  },
  {
    id: "issue_extra_missing",
    kind: "issue",
    name: "追加料金の記録漏れがある",
    severity: 4,
    targetIds: ["act_record_extra", "uc_register_extra"],
  },
  {
    id: "issue_cleaning_phone",
    kind: "issue",
    name: "清掃完了の連絡が電話頼みになっている",
    severity: 3,
    targetIds: ["act_instruct_cleaning", "act_clean"],
  },
  {
    id: "issue_cancel_explain",
    kind: "issue",
    name: "取消料の説明が担当者によって違う",
    severity: 2,
    targetIds: ["act_change_cancel", "uc_cancel_reservation"],
  },
];

// ---------------------------------------------------------------- 関係

const pairs: [source: string, target: string, access?: InformationAccess][] = [
  // actorBusiness
  ["actor_reservation", "biz_reservation"],
  ["actor_front", "biz_checkin"],
  ["actor_front", "biz_stay"],
  ["actor_front", "biz_checkout"],
  ["actor_housekeeping", "biz_cleaning"],
  // actorActivity
  ["actor_reservation", "act_accept_reservation"],
  ["ext_travel_agency", "act_accept_reservation"],
  ["actor_reservation", "act_confirm_reservation"],
  ["actor_reservation", "act_change_cancel"],
  ["ext_guest", "act_change_cancel"],
  ["actor_front", "act_confirm_arrival"],
  ["actor_front", "act_verify_identity"],
  ["ext_guest", "act_verify_identity"],
  ["actor_front", "act_assign_room"],
  ["actor_front", "act_hand_key"],
  ["actor_front", "act_room_request"],
  ["actor_front", "act_room_service"],
  ["actor_front", "act_record_extra"],
  ["actor_front", "act_create_bill"],
  ["actor_front", "act_settle"],
  ["actor_front", "act_collect_key"],
  ["actor_manager", "act_instruct_cleaning"],
  ["actor_housekeeping", "act_clean"],
  ["actor_housekeeping", "act_inspect_room"],
  // activityUsecase
  ["act_accept_reservation", "uc_register_reservation"],
  ["act_confirm_reservation", "uc_search_reservation"],
  ["act_confirm_reservation", "uc_confirm_reservation"],
  ["act_change_cancel", "uc_change_reservation"],
  ["act_change_cancel", "uc_cancel_reservation"],
  ["act_confirm_arrival", "uc_search_reservation"],
  ["act_verify_identity", "uc_record_checkin"],
  ["act_verify_identity", "uc_fill_register"],
  ["act_assign_room", "uc_assign_room"],
  ["act_record_extra", "uc_register_extra"],
  ["act_create_bill", "uc_issue_invoice"],
  ["act_settle", "uc_record_payment"],
  ["act_settle", "uc_record_sales"],
  ["act_collect_key", "uc_record_checkout"],
  ["act_instruct_cleaning", "uc_update_cleaning"],
  ["act_clean", "uc_update_cleaning"],
  ["act_inspect_room", "uc_update_cleaning"],
  // usecaseInformation (操作 → 情報: 扱う)。3 つ目は取得・保存の区別 (read: 取得だけ、write: 保存だけ、無ければ両方)。
  // 情報の置き場所 (取得元・保存先) と画面が扱う情報は、これと操作の対象から導く (0.4.0 から)
  ["uc_register_reservation", "info_reservation"],
  ["uc_register_reservation", "info_guest"],
  ["uc_search_reservation", "info_reservation", "read"],
  ["uc_confirm_reservation", "info_reservation"],
  ["uc_change_reservation", "info_reservation"],
  ["uc_cancel_reservation", "info_reservation"],
  ["uc_record_checkin", "info_reservation"],
  ["uc_record_checkin", "info_guest"],
  ["uc_fill_register", "info_guest", "write"],
  ["uc_assign_room", "info_room"],
  ["uc_assign_room", "info_reservation", "read"],
  ["uc_register_extra", "info_bill"],
  ["uc_calc_charge", "info_bill"],
  ["uc_calc_charge", "info_plan", "read"],
  ["uc_issue_invoice", "info_bill", "read"],
  ["uc_issue_invoice", "info_plan", "read"],
  ["uc_record_payment", "info_bill"],
  ["uc_record_sales", "info_bill", "write"],
  ["uc_record_checkout", "info_reservation"],
  ["uc_record_checkout", "info_room"],
  ["uc_update_cleaning", "info_cleaning_record"],
  ["uc_update_cleaning", "info_room", "read"],
  // usecaseCondition
  ["uc_register_reservation", "cond_full"],
  ["uc_assign_room", "cond_full"],
  ["uc_cancel_reservation", "cond_cancel_fee"],
  ["uc_record_checkin", "cond_early_checkin"],
  // informationRelated (無向)
  ["info_reservation", "info_guest"],
  ["info_reservation", "info_room"],
  ["info_reservation", "info_plan"],
  ["info_bill", "info_reservation"],
  ["info_cleaning_record", "info_room"],
  // informationVariation
  ["info_room", "var_room_type"],
  ["info_reservation", "var_channel"],
  ["info_bill", "var_payment_method"],
  // conditionVariation
  ["cond_full", "var_room_type"],
  // conditionState
  ["cond_cancel_fee", "st_res_confirmed"],
  ["cond_early_checkin", "st_room_ready"],
  ["cond_full", "st_room_inuse"],
  // stateUsecase
  ["st_res_tentative", "uc_confirm_reservation"],
  ["st_res_confirmed", "uc_change_reservation"],
  ["st_res_confirmed", "uc_cancel_reservation"],
  ["st_res_confirmed", "uc_record_checkin"],
  ["st_res_checkedin", "uc_register_extra"],
  ["st_res_checkedin", "uc_record_checkout"],
  ["st_room_ready", "uc_assign_room"],
  ["st_room_waiting", "uc_update_cleaning"],
  ["st_room_cleaning", "uc_update_cleaning"],
  // usecaseState
  ["uc_register_reservation", "st_res_tentative"],
  ["uc_confirm_reservation", "st_res_confirmed"],
  ["uc_change_reservation", "st_res_confirmed"],
  ["uc_cancel_reservation", "st_res_cancelled"],
  ["uc_record_checkin", "st_res_checkedin"],
  ["uc_assign_room", "st_room_inuse"],
  ["uc_record_checkout", "st_res_checkedout"],
  ["uc_record_checkout", "st_room_waiting"],
  ["uc_update_cleaning", "st_room_cleaning"],
  ["uc_update_cleaning", "st_room_ready"],
  // 作業に属さない自動の処理: 宿泊管理システムが「チェックアウトの日になった」を発生させ、請求金額を計算する。
  // 計算が済んだら「請求金額が計算された」を発生させ、フロント担当の請求書の発行のきっかけになる
  ["sys_pms", "ev_checkout_day"],
  ["ev_checkout_day", "uc_calc_charge"],
  ["uc_calc_charge", "sys_pms"],
  ["uc_calc_charge", "ev_charge_calculated"],
  ["ev_charge_calculated", "uc_issue_invoice"],
  // usecaseSystem (操作 → システム・帳票: 対象) と usecaseScreen (操作 → 画面)。0.2.0 から、システムは作業の担当ではなく操作の対象にする。
  // 社内のシステムを使う操作は、システムの画面を対象にする (1 つの操作の対象は、システム・帳票・画面のどれか 1 つだけ)
  ["uc_confirm_reservation", "scr_reservation_confirm"],
  ["uc_search_reservation", "scr_reservation_search"],
  ["uc_change_reservation", "scr_reservation_change"],
  ["uc_cancel_reservation", "scr_reservation_cancel"],
  ["uc_record_checkin", "scr_checkin"],
  ["uc_fill_register", "ldg_guest_register"],
  ["uc_assign_room", "scr_room_assign"],
  ["uc_register_extra", "scr_extra_charge"],
  ["uc_issue_invoice", "scr_invoice"],
  ["uc_record_sales", "scr_sales_record"],
  ["uc_record_checkout", "scr_checkout"],
  ["uc_update_cleaning", "ldg_cleaning_sheet"],
  ["uc_register_reservation", "sys_booking_site"],
  ["uc_record_payment", "sys_payment"],
  // activityTrigger / eventActivity (作業の起点)
  ["act_accept_reservation", "act_confirm_reservation"],
  ["act_confirm_arrival", "act_verify_identity"],
  ["act_verify_identity", "act_assign_room"],
  ["act_assign_room", "act_hand_key"],
  ["act_room_request", "act_room_service"],
  ["act_room_service", "act_record_extra"],
  ["ev_checkout_day", "act_create_bill"],
  ["act_create_bill", "act_settle"],
  ["act_settle", "act_collect_key"],
  ["act_collect_key", "act_instruct_cleaning"],
  ["act_instruct_cleaning", "act_clean"],
  ["act_clean", "act_inspect_room"],
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
  ...screens,
  ...contexts,
  ...informations,
  ...states,
  ...variations,
  ...conditions,
  ...events,
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
  ...frameWithActivities("biz_reservation", 40, ["act_accept_reservation", "act_confirm_reservation", "act_change_cancel"]),
  ...frameWithActivities("biz_checkin", 340, ["act_confirm_arrival", "act_verify_identity", "act_assign_room", "act_hand_key"]),
  // 滞在中の対応: 活動の小枠 3 つ (活動のある業務の作業は、すべてどれかの活動に入れる)
  { elementId: "biz_stay", x: 640, y: FRAME_Y, width: 520, height: FRAME_H },
  { elementId: "buc_room_care", x: 660, y: FRAME_Y + 56, width: 220, height: 200 },
  { elementId: "act_room_request", x: 680, y: FRAME_Y + 112 },
  { elementId: "buc_dining", x: 920, y: FRAME_Y + 56, width: 220, height: 200 },
  { elementId: "act_room_service", x: 940, y: FRAME_Y + 112 },
  { elementId: "buc_extra_charge", x: 660, y: FRAME_Y + 276, width: 480, height: 160 },
  { elementId: "act_record_extra", x: 680, y: FRAME_Y + 332 },
  ...frameWithActivities("biz_checkout", 40, ["act_create_bill", "act_settle", "act_collect_key"], FRAME_Y2),
  ...frameWithActivities("biz_cleaning", 340, ["act_instruct_cleaning", "act_clean", "act_inspect_room"], FRAME_Y2),
];

const flowActivities = [
  "act_accept_reservation",
  "act_confirm_reservation",
  "act_change_cancel",
  "act_confirm_arrival",
  "act_verify_identity",
  "act_assign_room",
  "act_hand_key",
  "act_record_extra",
  "act_create_bill",
  "act_settle",
  "act_collect_key",
  "act_instruct_cleaning",
  "act_clean",
  "act_inspect_room",
];
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
  "uc_register_reservation",
  "uc_confirm_reservation",
  "uc_change_reservation",
  "uc_cancel_reservation",
  "uc_record_checkin",
  "uc_assign_room",
  "uc_register_extra",
  "uc_record_checkout",
  "uc_update_cleaning",
];

const stateNodes: BoardNode[] = [
  ...column(flowInfos, 40, 40, 100),
  ...column(variations.map((e) => e.id), 340, 40, 100),
  ...column(flowConditions, 340, 380, 100),
  ...column(states.filter((e) => e.id.startsWith("st_res_")).map((e) => e.id), 640, 40, 90),
  ...column(stateUsecases, 940, 40, 90),
  ...column(states.filter((e) => e.id.startsWith("st_room_")).map((e) => e.id), 1240, 40, 90),
];

export const hotelSample: UntieModel = {
  version: MODEL_VERSION,
  meta: {
    name: "宿泊施設の業務 (サンプル)",
    description: "架空の宿泊施設の業務を題材にしたサンプル。実在の施設・データではありません。",
  },
  elements,
  relations,
  boards: [
    { id: "board_overview", name: "全体", nodes: overviewNodes },
    { id: "board_flow", name: "予約からチェックアウトまで", nodes: flowNodes },
    { id: "board_state", name: "情報と状態", nodes: stateNodes },
  ],
  designs: [],
  databases: [],
  domain: emptyDomain(),
};

/** 呼ぶたびに独立したコピーを返す (JSON の往復。core は DOM に依存しないので structuredClone を使わない) */
export function createHotelSample(): UntieModel {
  return JSON.parse(JSON.stringify(hotelSample)) as UntieModel;
}
