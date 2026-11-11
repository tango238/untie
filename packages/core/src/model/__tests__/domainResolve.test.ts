import { describe, expect, it } from "vitest";
import { createNetshopSample } from "../../sample";
import { adoptAggregateCandidate, adoptCommandCandidate, adoptEventCandidate, addPolicyBetween, splitCommandByActivity } from "../domainAdopt";
import { checkDomain } from "../domainCheck";
import { addDomainPolicy, excludeInformation, includeInformation, removeContextRelation, removeDomainCommand, setCandidateExcluded, updateDomainEvent } from "../domainCommands";
import { deriveContextMap } from "../domainMap";
import { adoptDomainCandidates, normalizeDomainSelection, resolveDomain } from "../domainResolve";
import { emptyDomain, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { okModel, sample, sampleWithDomain } from "./helpers";

const netshop = (): UntieModel => createNetshopSample();
const bare = (m: UntieModel): UntieModel => ({ ...m, domain: emptyDomain() });
const keys = (xs: { key: string | null }[]) => xs.map((x) => x.key);

describe("resolveDomain: 候補に保存した判断を重ねる", () => {
  it("保存が空なら、分析から導いた候補だけ (キーは分析の要素の id)", () => {
    const r = resolveDomain(sample(), "sys_pms");
    expect(r.contexts.map((c) => [c.key, c.role, !!c.saved])).toEqual([
      ["ctx_reservation", "own", false],
      ["ctx_customer", "own", false],
      ["ctx_room", "own", false],
      ["ctx_charge", "own", false],
    ]);
    expect(keys(r.aggregates)).toEqual(["info_reservation", "info_guest", "info_room", "info_plan", "info_bill"]);
    expect(r.commands.every((c) => !c.saved && c.candidate && c.key === c.candidate.usecase.id)).toBe(true);
    expect(r.commands.find((c) => c.key === "uc_calc_charge")).toMatchObject({ aggregateKey: "info_bill", eventKeys: ["ev_charge_calculated"], sourceKey: "usecase:uc_calc_charge" });
    expect(r.policies.map((p) => [p.eventKey, p.commandKey, p.auto])).toEqual([["ev_checkout_day", "uc_calc_charge", true]]);
    expect(r.excluded).toEqual([]);
    // 料金プランは書かないので、「候補から作る」の数に入らない
    expect(r.unadopted).toEqual({ contexts: 4, aggregates: 4 });
  });

  it("保存したコンテキスト・集約・コマンド・イベントで候補を置き換え、外した候補は出さず、あるべき姿のものを足す", () => {
    const r = resolveDomain(sampleWithDomain(), "sys_pms");
    // 予約 (予約と顧客の文脈)・請求は保存したもの。客室は候補のまま。決済は、あるべき姿のイベントの発生元として上流に出る
    expect(r.contexts.map((c) => [c.key, c.role])).toEqual([
      ["bc_res", "own"],
      ["bc_bill", "own"],
      ["ctx_room", "own"],
      ["bc_pay", "upstream"],
    ]);
    const res = r.aggregates.find((a) => a.key === "ag_res")!;
    expect(res).toMatchObject({ name: "予約", english: "Reservation", contextKey: "bc_res", writtenHere: true, stateGroups: ["予約の状態"] });
    expect(res.members.map((m) => m.id)).toEqual(["info_guest"]);
    // 宿泊客は予約の集約の中なので、候補としては出ない。料金プランは請求のコンテキストの候補
    expect(keys(r.aggregates)).toEqual(["ag_res", "ag_bill", "info_room", "info_plan"]);
    expect(r.aggregates.find((a) => a.key === "info_plan")).toMatchObject({ contextKey: "bc_bill", writtenHere: false });
    // 外した候補は一覧から消え、戻せるように別に出す
    expect(r.commands.some((c) => c.candidate?.usecase.id === "uc_cancel_reservation")).toBe(false);
    expect(r.excluded).toEqual([{ key: "usecase:uc_cancel_reservation", kind: "command", label: "予約を取り消す" }]);
    // 候補のコマンドは、保存した集約に付く。保存したイベントのキーは保存した id
    expect(r.commands.find((c) => c.key === "uc_calc_charge")).toMatchObject({ aggregateKey: "ag_bill", eventKeys: ["de_calc"] });
    // あるべき姿のコマンド (分析に無い) と、対象がこのシステムでない操作から採用したコマンド
    expect(r.commands.find((c) => c.key === "cm_settle")).toMatchObject({ candidate: null, sourceKey: null, aggregateKey: "ag_bill", eventKeys: ["de_calc"] });
    expect(r.commands.find((c) => c.key === "cm_register")).toMatchObject({ name: "予約を登録する", english: "RegisterReservation", aggregateKey: "ag_res" });
    // 上流のコンテキストのあるべき姿のイベントは、保存したポリシーでこのボードのコマンドを動かすので出る
    expect(r.events.find((e) => e.key === "de_paid")).toMatchObject({ origin: "outside", contextKey: "bc_pay", scoped: null });
    expect(r.policies.map((p) => [p.key, p.eventKey, p.commandKey])).toEqual([
      ["policy:rel_ev_checkout_day__uc_calc_charge", "ev_checkout_day", "uc_calc_charge"],
      ["po_settle", "de_paid", "cm_settle"],
    ]);
    expect(r.unadopted).toEqual({ contexts: 1, aggregates: 1 });
  });

  it("ほかのシステムのコンテキストは上流として出すが、そのコマンドと、関わりの無いイベントは出さない", () => {
    const r = resolveDomain(netshop(), "sys_accounting");
    expect(r.contexts.map((c) => [c.key, c.role])).toEqual([
      ["bc_accounting", "own"],
      ["bc_ordering", "upstream"],
      ["bc_shipping", "upstream"],
    ]);
    expect(keys(r.commands)).toEqual(["uc_register_receivable", "uc_record_payout", "uc_clear_receivable", "uc_report_month"]);
    // 出荷のコンテキストの「出荷した」は、売掛金を登録するきっかけ
    expect(r.events.find((e) => e.key === "de_shipped")).toMatchObject({ origin: "outside", contextKey: "bc_shipping", name: "出荷した", english: "OrderShipped" });
    expect(r.events.some((e) => e.key === "de_order_confirmed" || e.key === "de_payment_confirmed")).toBe(false);
  });

  it("分析から導ける組に保存したポリシーは、導いたものに重ねる (人の判断を挟む、と保存したら、そう出る)", () => {
    const before = resolveDomain(netshop(), "sys_oms").policies.filter((p) => p.eventKey === "de_order_confirmed" && p.commandKey === "cm_allocate_stock");
    expect(before.map((p) => [p.auto, p.saved, !!p.derived])).toEqual([[true, null, true]]);
    const m = okModel(addDomainPolicy(netshop(), { id: "po_allocate", eventId: "de_order_confirmed", commandId: "cm_allocate_stock", auto: false }));
    const after = resolveDomain(m, "sys_oms").policies.filter((p) => p.eventKey === "de_order_confirmed" && p.commandKey === "cm_allocate_stock");
    // 同じ組は 1 本のまま。保存した判断 (auto: false) が出て、プロパティ欄で直せる (saved がある)
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ key: before[0]!.key, auto: false, saved: { id: "po_allocate" } });
    expect(after[0]!.derived).not.toBeNull();
  });

  it("あるべき姿: 決済のイベントを受けて、販売管理システムが注文を入金済にする (保存したポリシー)", () => {
    const r = resolveDomain(netshop(), "sys_oms");
    expect(r.commands.find((c) => c.key === "cm_mark_paid")).toMatchObject({ candidate: null, aggregateKey: "ag_order", eventKeys: ["de_order_paid"] });
    expect(r.events.find((e) => e.key === "de_payment_confirmed")).toMatchObject({ origin: "outside", contextKey: "bc_payment" });
    expect(r.policies.filter((p) => p.eventKey === "de_payment_confirmed").map((p) => [p.commandKey, p.auto, !!p.saved])).toEqual([
      ["uc_issue_pick_list", false, false],
      ["cm_mark_paid", true, true],
    ]);
    // 顧客 (購入者・問い合わせ履歴) は、まだ決めていない候補のまま
    expect(r.contexts.find((c) => c.key === "ctx_customer")).toMatchObject({ saved: null, role: "own" });
    expect(r.unadopted).toEqual({ contexts: 1, aggregates: 2 });
  });

  it("候補を選んでいるあいだに保存されても、選択はもとの要素から探し直す", () => {
    const before = sample();
    const after = okModel(adoptAggregateCandidate(before, { systemId: "sys_pms", key: "info_reservation" }));
    const r = resolveDomain(after, "sys_pms");
    const aggregate = r.aggregates.find((a) => a.root.id === "info_reservation")!;
    expect(aggregate.saved).not.toBeNull();
    expect(normalizeDomainSelection(r, { kind: "aggregate", id: "info_reservation" })).toEqual({ kind: "aggregate", id: aggregate.key });
    expect(normalizeDomainSelection(r, { kind: "context", id: "ctx_reservation" })).toEqual({ kind: "context", id: aggregate.contextKey });
    expect(normalizeDomainSelection(r, { kind: "command", id: "uc_calc_charge" })).toEqual({ kind: "command", id: "uc_calc_charge" });
    expect(normalizeDomainSelection(r, { kind: "event", id: "ev_nope" })).toBeUndefined();
    expect(normalizeDomainSelection(r, undefined)).toBeUndefined();
  });
});

describe("候補を採用して保存する", () => {
  it("集約の候補を保存すると、コンテキストも一緒に保存し、状態グループを引き継ぐ", () => {
    const m = okModel(adoptAggregateCandidate(sample(), { systemId: "sys_pms", key: "info_reservation" }));
    expect(m.domain.contexts).toHaveLength(1);
    expect(m.domain.contexts[0]).toMatchObject({ name: "予約", contextIds: ["ctx_reservation"], systemIds: ["sys_pms"] });
    expect(m.domain.aggregates[0]).toMatchObject({ name: "予約", rootInformationId: "info_reservation", stateGroup: "予約の状態", boundedContextId: m.domain.contexts[0]!.id });
    expect(validateModel(m)).toMatchObject({ ok: true });
    // もう一度しても増えない
    const again = adoptAggregateCandidate(m, { systemId: "sys_pms", key: m.domain.aggregates[0]!.id });
    expect(again.ok && again.model).toBe(m);
  });

  it("コマンドの候補に名前・英語名を付けると、集約とコンテキストも一緒に保存する。保存をやめると候補に戻る", () => {
    const r = adoptCommandCandidate(sample(), { systemId: "sys_pms", key: "uc_calc_charge", patch: { name: "請求を計算する", english: "CalculateCharge" } });
    if (!r.ok) throw new Error(r.reason);
    const m = r.model;
    expect(m.domain.commands).toEqual([{ id: r.id, aggregateId: m.domain.aggregates[0]!.id, name: "請求を計算する", english: "CalculateCharge", source: { usecaseId: "uc_calc_charge" }, emits: [] }]);
    const resolved = resolveDomain(m, "sys_pms").commands.find((c) => c.key === r.id)!;
    expect(resolved).toMatchObject({ name: "請求を計算する", sourceKey: "usecase:uc_calc_charge", eventKeys: ["ev_charge_calculated"] });
    expect(resolved.candidate?.usecase.id).toBe("uc_calc_charge");
    const back = okModel(removeDomainCommand(m, { id: r.id }));
    expect(resolveDomain(back, "sys_pms").commands.find((c) => c.candidate?.usecase.id === "uc_calc_charge")).toMatchObject({ key: "uc_calc_charge", saved: null, name: "請求金額を計算する" });
  });

  it("イベントの候補を保存する。別のところで発生するイベントは、発生元のコンテキストを選ぶ", () => {
    const inside = adoptEventCandidate(sample(), { systemId: "sys_pms", key: "ev_charge_calculated", patch: { english: "ChargeCalculated" } });
    if (!inside.ok) throw new Error(inside.reason);
    expect(inside.model.domain.events[0]).toMatchObject({ name: "請求金額が計算された", english: "ChargeCalculated", eventId: "ev_charge_calculated", aggregateId: inside.model.domain.aggregates[0]!.id });
    // 会計システムにとって「出荷が記録された」は外のイベント。発生元のコンテキストを選ばないと保存できない
    const m = bare(netshop());
    const outside = adoptEventCandidate(m, { systemId: "sys_accounting", key: "ev_shipped" });
    expect(outside.ok).toBe(false);
    const withContext = okModel(adoptAggregateCandidate(m, { systemId: "sys_oms", key: "info_shipment" }));
    const bcId = withContext.domain.contexts[0]!.id;
    const saved = okModel(adoptEventCandidate(withContext, { systemId: "sys_accounting", key: "ev_shipped", boundedContextId: bcId }));
    expect(saved.domain.events[0]).toMatchObject({ boundedContextId: bcId, eventId: "ev_shipped" });
    expect(validateModel(saved)).toMatchObject({ ok: true });
  });

  it("ポリシーを足すと、イベントとコマンドがまだ候補なら一緒に保存する", () => {
    const r = addPolicyBetween(sample(), { systemId: "sys_pms", eventKey: "ev_charge_calculated", commandKey: "uc_record_checkout", auto: false });
    if (!r.ok) throw new Error(r.reason);
    const d = r.model.domain;
    expect(d.policies).toHaveLength(1);
    expect(d.events.find((e) => e.id === d.policies[0]!.eventId)).toMatchObject({ eventId: "ev_charge_calculated" });
    expect(d.commands.find((c) => c.id === d.policies[0]!.commandId)).toMatchObject({ source: { usecaseId: "uc_record_checkout" } });
    expect(d.policies[0]!.auto).toBe(false);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
    const resolved = resolveDomain(r.model, "sys_pms");
    expect(resolved.policies.some((p) => p.saved?.id === d.policies[0]!.id)).toBe(true);
  });

  it("複数の作業が使う操作を、作業ごとのコマンドに分ける。分けたあとは作業ごとに出て、1 つを外せる", () => {
    const m = netshop();
    const r = splitCommandByActivity(m, { systemId: "sys_oms", usecaseId: "uc_update_stock" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ids).toHaveLength(3);
    const added = r.model.domain.commands.filter((c) => r.ids.includes(c.id));
    expect(added.every((c) => c.aggregateId === "ag_stock" && c.source?.usecaseId === "uc_update_stock" && c.source.activityId !== undefined && c.name.startsWith("在庫数を更新する ("))).toBe(true);
    const resolved = resolveDomain(r.model, "sys_oms");
    expect(resolved.commands.filter((c) => c.candidate?.usecase.id === "uc_update_stock").map((c) => c.key)).toEqual(r.ids);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
    // 作業が 1 つの操作は分けられない
    expect(splitCommandByActivity(m, { systemId: "sys_oms", usecaseId: "uc_confirm_order" }).ok).toBe(false);
    // 分けたうちの 1 つを消して外すと、残りの 2 つだけが出る
    const first = added[0]!;
    let next = okModel(removeDomainCommand(r.model, { id: first.id }));
    next = okModel(setCandidateExcluded(next, { key: `usecase:uc_update_stock/activity:${first.source!.activityId!}`, excluded: true }));
    const after = resolveDomain(next, "sys_oms");
    expect(after.commands.filter((c) => c.candidate?.usecase.id === "uc_update_stock")).toHaveLength(2);
    expect(after.excluded.map((x) => x.kind)).toEqual(["command"]);
  });

  it("候補から作る: このシステムが書く情報のあるコンテキストと、1 情報 1 集約をまとめて保存する (2 度目は何も足さない)", () => {
    const r = adoptDomainCandidates(sample(), { systemId: "sys_pms" });
    if (!r.ok) throw new Error(r.reason);
    expect([r.contexts, r.aggregates]).toEqual([4, 4]);
    expect(r.model.domain.contexts.map((c) => c.name)).toEqual(["予約", "顧客", "客室", "料金"]);
    expect(r.model.domain.aggregates.map((a) => [a.name, a.stateGroup])).toEqual([["予約", "予約の状態"], ["宿泊客", undefined], ["部屋", "部屋の状態"], ["請求", undefined]]);
    expect(validateModel(r.model)).toMatchObject({ ok: true });
    const again = adoptDomainCandidates(r.model, { systemId: "sys_pms" });
    expect(again).toMatchObject({ ok: true, contexts: 0, aggregates: 0 });
    expect(adoptDomainCandidates(sample(), { systemId: "nope" }).ok).toBe(false);
  });

  it("情報を集約の中へ入れる: 同じコンテキストの集約のルートなら畳み、コマンド・イベント・不変条件を引き継ぐ。外すと候補に戻る", () => {
    let m = netshop();
    m = okModel(includeInformation(m, { aggregateId: "ag_order", informationId: "info_return" }));
    expect(m.domain.aggregates.some((a) => a.id === "ag_return")).toBe(false);
    const order = m.domain.aggregates.find((a) => a.id === "ag_order")!;
    expect(order.memberInformationIds).toEqual(["info_return"]);
    expect(order.invariants.map((i) => i.id)).toEqual(["inv_order_paid", "inv_order_cancel", "inv_return_period"]);
    expect(m.domain.commands.find((c) => c.id === "cm_accept_return")!.aggregateId).toBe("ag_order");
    expect(m.domain.events.find((e) => e.id === "de_return_accepted")!.aggregateId).toBe("ag_order");
    expect(validateModel(m)).toMatchObject({ ok: true });
    // ルートは外せない。中の情報は外せて、1 情報 1 集約の候補に戻る
    expect(excludeInformation(m, { aggregateId: "ag_order", informationId: "info_order" }).ok).toBe(false);
    m = okModel(excludeInformation(m, { aggregateId: "ag_order", informationId: "info_return" }));
    expect(resolveDomain(m, "sys_oms").aggregates.find((a) => a.root.id === "info_return")).toMatchObject({ key: "info_return", saved: null, contextKey: "bc_ordering" });
  });
});

describe("コンテキストマップの下敷き", () => {
  it("イベントがきっかけになる・情報を取得する つながりを導き、保存した関係を向きを見て付ける", () => {
    const map = deriveContextMap(netshop());
    const row = (up: string, down: string) => map.flows.find((f) => f.upstreamId === up && f.downstreamId === down)!;
    expect(row("bc_ordering", "bc_inventory")).toMatchObject({ events: ["注文が確定した"], relation: { id: "cr_ordering_inventory" }, reverseRelation: null });
    expect(row("bc_shipping", "bc_accounting")).toMatchObject({ events: ["出荷した"], reads: [], relation: { id: "cr_shipping_accounting" } });
    // 決済 → 受注 は、保存したポリシー (入金が確認された → 注文を入金済にする) と、導いたポリシーから
    expect(row("bc_payment", "bc_ordering")).toMatchObject({ events: ["入金が確認された"], relation: { id: "cr_payment_ordering" } });
    // 逆向き (決済サービスが注文を読む) には関係を決めていないので、逆向きの関係を添える
    expect(row("bc_ordering", "bc_payment")).toMatchObject({ relation: null, reverseRelation: { id: "cr_payment_ordering" } });
    expect(map.relationsWithoutFlow).toEqual([]);
    expect(map.flows.every((f) => f.relation || f.reverseRelation)).toBe(true);
  });

  it("関係を消すと未決になり、検証が知らせる。保存した判断が無ければ、つながりも無い", () => {
    const m = okModel(removeContextRelation(netshop(), { id: "cr_ordering_inventory" }));
    const flow = deriveContextMap(m).flows.find((f) => f.upstreamId === "bc_ordering" && f.downstreamId === "bc_inventory")!;
    expect(flow).toMatchObject({ relation: null, reverseRelation: null });
    expect(checkDomain(m).map((p) => [p.type, p.target])).toEqual([["flowWithoutRelation", { board: "contextmap" }]]);
    expect(deriveContextMap(bare(netshop()))).toEqual({ contexts: [], flows: [], relationsWithoutFlow: [] });
  });
});

describe("checkDomain: ドメインモデルの検証", () => {
  it("保存した判断が無ければ何も出さない。サンプルは、エラーも警告も無い", () => {
    expect(checkDomain(sample())).toEqual([]);
    expect(checkDomain(netshop())).toEqual([]);
  });

  it("候補から作っただけだと、まだ決めていないことを警告する", () => {
    const m = okModel(adoptDomainCandidates(sample(), { systemId: "sys_pms" }));
    const problems = checkDomain(m);
    expect(problems.every((p) => p.level === "warning")).toBe(true);
    expect([...new Set(problems.map((p) => p.type))].sort()).toEqual(["aggregateWithoutInvariant", "contextWithoutSubdomain", "flowWithoutRelation", "informationWithoutAggregate", "missingEnglish"]);
    // 行を押すと、その集約・コンテキストを選ぶ (実装するシステムの設計へ)
    const noInvariant = problems.find((p) => p.type === "aggregateWithoutInvariant")!;
    expect(noInvariant.target).toMatchObject({ board: "domain", systemId: "sys_pms", selection: { kind: "aggregate" } });
    // 集約に入っていない情報は、候補の集約 (情報の id) を選ぶ
    const cleaning = m.elements.find((e) => e.kind === "information" && e.name === "清掃記録")!;
    expect(problems.find((p) => p.type === "informationWithoutAggregate")!.target).toMatchObject({ board: "domain", selection: { kind: "aggregate", id: cleaning.id } });
  });

  it("同じコンテキストの 2 つの集約に同じ情報が入っていればエラー。実装するシステムの無いコンテキストは警告", () => {
    const m = sampleWithDomain();
    const overlap: UntieModel = {
      ...m,
      domain: {
        ...m.domain,
        contexts: m.domain.contexts.map((c) => (c.id === "bc_pay" ? { ...c, systemIds: [] } : c)),
        aggregates: [...m.domain.aggregates, { id: "ag_dup", boundedContextId: "bc_res", name: "宿泊客", rootInformationId: "info_guest", memberInformationIds: [], invariants: [] }],
      },
    };
    const problems = checkDomain(overlap);
    expect(problems.filter((p) => p.level === "error").map((p) => p.type)).toEqual(["aggregateOverlap"]);
    expect(problems.some((p) => p.type === "contextUnassigned" && p.message.includes("決済 (外部)"))).toBe(true);
  });
});

describe("レビューを受けた振る舞い (2a-2 以降)", () => {
  it("保存したイベントを、ほかのシステムのコンテキストへ移すと、このシステムにとっては外のイベントになる", () => {
    let m = netshop();
    expect(resolveDomain(m, "sys_oms").events.find((e) => e.key === "de_shipped")!.origin).toBe("inside");
    // 出荷した を、会計 (会計システム) のコンテキストへ移す
    m = okModel(updateDomainEvent(m, { id: "de_shipped", patch: { boundedContextId: "bc_accounting", aggregateId: null } }));
    expect(resolveDomain(m, "sys_oms").events.find((e) => e.key === "de_shipped")).toMatchObject({ origin: "outside", contextKey: "bc_accounting" });
  });

  it("名前の空な分析のコンテキスト・情報・操作があっても、採用できる (「(名前なし)」にする)。1 つ作れなくても、ほかは進める", () => {
    const base = sample();
    const m = { ...base, elements: base.elements.map((e) => (e.id === "ctx_room" || e.id === "info_reservation" || e.id === "uc_calc_charge" ? { ...e, name: "" } : e)) } as UntieModel;
    const r = adoptDomainCandidates(m, { systemId: "sys_pms" });
    if (!r.ok) throw new Error(r.reason);
    expect([r.contexts, r.aggregates]).toEqual([4, 4]);
    expect(r.model.domain.contexts.map((c) => c.name)).toContain("(名前なし)");
    expect(r.model.domain.aggregates.find((a) => a.rootInformationId === "info_reservation")!.name).toBe("(名前なし)");
    const cmd = adoptCommandCandidate(r.model, { systemId: "sys_pms", key: "uc_calc_charge", patch: { english: "CalculateCharge" } });
    if (!cmd.ok) throw new Error(cmd.reason);
    expect(cmd.model.domain.commands[0]!.name).toBe("(名前なし)");
    expect(validateModel(cmd.model)).toMatchObject({ ok: true });
    // 作業で分けた名前が長すぎても、切って保存する
    const long = netshop();
    const stretched = { ...long, elements: long.elements.map((e) => (e.id === "uc_update_stock" ? { ...e, name: "あ".repeat(200) } : e)) } as UntieModel;
    const split = splitCommandByActivity(stretched, { systemId: "sys_oms", usecaseId: "uc_update_stock" });
    if (!split.ok) throw new Error(split.reason);
    expect(split.model.domain.commands.filter((c) => split.ids.includes(c.id)).every((c) => c.name.length <= 200 && c.name.endsWith(")"))).toBe(true);
    expect(validateModel(split.model)).toMatchObject({ ok: true });
  });

  it("もとの操作・作業・イベント・関係が無いキーは、外した候補にできない (検証に通らないモデルを作らない)", () => {
    const m = netshop();
    for (const key of ["usecase:zz", "usecase:uc_update_stock/activity:zz", "event:zz", "policy:zz"]) {
      const r = setCandidateExcluded(m, { key, excluded: true });
      expect(r.ok, key).toBe(false);
    }
    const policy = m.relations.find((r) => r.kind === "eventUsecase")!;
    const ok = okModel(setCandidateExcluded(m, { key: `policy:${policy.id}`, excluded: true }));
    expect(validateModel(ok)).toMatchObject({ ok: true });
    // 戻すのは、もとの要素が無くなっていてもできる
    expect(setCandidateExcluded(ok, { key: `policy:${policy.id}`, excluded: false }).ok).toBe(true);
  });

  it("作業で分けた操作を、操作ごとまとめて外すと、コンテキストマップの根拠からも外れる", () => {
    const m = netshop();
    const before = deriveContextMap(m).flows.find((f) => f.upstreamId === "bc_ordering" && f.downstreamId === "bc_inventory")!;
    expect(before.events).toEqual(["注文が確定した"]);
    const excluded = okModel(setCandidateExcluded(okModel(removeDomainCommand(m, { id: "cm_allocate_stock" })), { key: "usecase:uc_allocate_stock", excluded: true }));
    const after = deriveContextMap(excluded).flows.find((f) => f.upstreamId === "bc_ordering" && f.downstreamId === "bc_inventory");
    expect(after?.events ?? []).toEqual([]);
  });
});
