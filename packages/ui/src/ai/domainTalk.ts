// ドメインモデルの対話: AI が、分析から導いた候補と気づきをもとに問いを出し、設計者と一緒に
// 境界づけられたコンテキスト・集約と不変条件・コマンドとイベントの名前と英語名・ポリシー・関係・用語を決めていく。
// 進め方は課題の深掘り (grill.ts) と同じで、前提の揃った問いをラウンドでまとめて出し、推奨を添え、了承を得てから道具で書く。
// 書くのはドメインモデル (domain) だけ。分析の誤りや抜けに気づいたら、分析を直さずに課題として残す (add_issue)。
import { addElement } from "@untie/core/model/commands";
import type { CommandResult } from "@untie/core/model/commands";
import { CONTEXT_RELATION_KINDS, CONTEXT_RELATION_LABELS, INTEGRATIONS, SUBDOMAINS, type ContextRelationKind, type Integration, type Subdomain } from "@untie/core/model/domain";
import { adoptAggregateCandidate, adoptCommandCandidate, adoptEventCandidate } from "@untie/core/model/domainAdopt";
import { checkDomain } from "@untie/core/model/domainCheck";
import {
  addAggregate,
  addBoundedContext,
  addContextRelation,
  addDomainCommand,
  addDomainEvent,
  addDomainPolicy,
  removeAggregate,
  removeBoundedContext,
  removeContextRelation,
  removeDomainCommand,
  removeDomainEvent,
  removeDomainPolicy,
  removeDomainTerm,
  setCandidateExcluded,
  setDomainTerm,
  updateAggregate,
  updateBoundedContext,
  updateContextRelation,
  updateDomainCommand,
  updateDomainEvent,
} from "@untie/core/model/domainCommands";
import { deriveContextMap } from "@untie/core/model/domainMap";
import { resolveDomain } from "@untie/core/model/domainResolve";
import { ISSUE_TARGET_KINDS, type Element, type UntieModel } from "@untie/core/model/types";
import { executeTool, MODEL_TOOLS, type ModelEditor, type ToolDef, type ToolOutcome } from "./tools";

/** 対話の指示 */
export function domainTalkSystemPrompt(): string {
  return `あなたは Untie の AI エージェントで、ドメイン駆動設計 (DDD) に詳しい設計者として、利用者 (設計者・開発者) と一緒に、対象のシステムのドメインモデルを決めます。
材料は、業務分析 (RDRA) から導いた候補 (コンテキスト・集約・コマンド・イベント・ポリシー) と、分析から読み取れた気づき (問い) です。分析は現状 (as-is) なので、これから作るシステムのあるべき姿 (to-be) を決めます。

決める順 (木の根から枝へ):
1. 気づきの問い (どの集約の状態を変えるのか・1 つの操作を分けるか・イベントが要るか・同じ語が別の意味か)。境界に効くものから
2. 境界づけられたコンテキストと、サブドメインの分類 (core / supporting / generic)・責務・実装するシステム
3. 集約 (ルートの情報と、同じトランザクションで整合させる中の情報。迷ったら小さく) と、不変条件
4. コマンドの意図の名前 (「〜を記録する」ではなく「〜する」)、イベントの名前 (過去の形の事実)、要るのに無いコマンド・イベント、現状の手順を写しただけで要らない候補 (外す)
5. コンテキスト間の関係の種類と統合の方式
6. 用語の定義と英語名 (コンテキスト・集約・コマンド・イベントの英語名は、書き出しに要るので必ず決める)

進め方:
- まず get_domain で、いまの候補・保存した判断・気づき・検証の結果を読む。分析の細部が要るときは get_model
- 質問はラウンドでまとめて出す。前提が揃っていて今すぐ聞ける問いをすべて (3〜4 問まで) 並べ、他の問いの答えに依る問いは次のラウンドに回す
- 問いには Q1、Q2 … と番号を振り、1 行の見出しと短い本文を付ける。各問いに、分析から読み取った見立てを「➡️ 推奨: …」として添え、その理由を 1 文で書く。「はい」と答えれば推奨を採ったことになるように、問いを言い切りの形で書く
- 分析から読み取れる事実 (どの操作がどの情報を書くか・状態の遷移) は利用者に聞かない。聞くのは判断 (境界・整合の単位・名前・チームの関係) だけ
- 利用者の答えを待ってから次のラウンドへ進む。答えが曖昧なら、その場で 1 つだけ聞き返す
- ラウンドごとに、決まったことを道具で保存する。利用者が了承した (「はい」や、推奨と違う答えを言った) ものだけを保存し、了承の無いものは保存しない。保存したら、何を決めたかを 1〜2 行で伝える (名前で書く。id は書かない)
- 書けるのはドメインモデルだけ。分析 (業務・作業・操作・情報・イベントなど) は変えない。分析の誤りや抜け (担当のいない操作、イベントの発生元が違う、状態の持ち主が食い違うなど) に気づいたら、利用者に伝えて、了承されたら add_issue で課題として残す
- 英語名は、英字で始まる英数字 (PascalCase)。コマンドは動詞で始め (ConfirmOrder)、イベントは過去分詞にする (OrderConfirmed)
- 開いた問いが無くなったら (または利用者が「もう十分」と言ったら)、決めたことと、まだ決めていないこと (get_domain の検証の結果) を短くまとめて終える

利用者が見るのは、設計モードのドメインボードとコンテキストマップです。`;
}

const STR = { type: "string" } as const;
const ID_OR_NEW = "既にあるものを変えるときは id。省くと新しく足す";

/** 対話で使う道具。モデルを読む道具は共通、書く道具はドメインモデルと課題の登録だけ */
export const DOMAIN_TALK_TOOLS: ToolDef[] = [
  MODEL_TOOLS.find((t) => t.name === "get_model")!,
  {
    name: "get_domain",
    description: "対象のシステムのドメインモデルを読む: 保存した判断と分析から導いた候補を重ねた一覧 (コンテキスト・集約・コマンド・イベント・ポリシー)、コンテキスト間のつながり、気づき (問い)、検証の結果 (まだ決めていないこと)。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_context",
    description: "境界づけられたコンテキストを足す・変える。足すときは、対象のシステムが実装するものになる。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: ID_OR_NEW },
        name: STR,
        english: { type: "string", description: "英語名 (PascalCase)" },
        description: { type: "string", description: "責務" },
        subdomain: { type: "string", enum: [...SUBDOMAINS] },
        team: STR,
        context_ids: { type: "array", items: STR, description: "言語の範囲にする分析のコンテキストの id (全体を置き換える)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_aggregate",
    description:
      "集約を足す・変える。足すときは root_information_id (ルートの情報) と context_id が要る (候補の情報を、そのコンテキストのまま採用するなら context_id を省ける)。invariants を渡すと、不変条件の全体を置き換える。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: ID_OR_NEW },
        root_information_id: STR,
        context_id: { type: "string", description: "境界づけられたコンテキストの id" },
        name: STR,
        english: STR,
        member_information_ids: { type: "array", items: STR, description: "中の情報の id (全体を置き換える)" },
        state_group: { type: "string", description: "状態グループの名前 (空文字で外す)" },
        invariants: {
          type: "array",
          items: { type: "object", properties: { text: STR, condition_id: STR }, required: ["text"], additionalProperties: false },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_command",
    description:
      "コマンドを足す・変える。分析の操作の候補を採用するなら usecase_id (作業ごとに分けるなら activity_id も)。分析に無いあるべき姿のコマンドは、aggregate_id と name で足す。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: ID_OR_NEW },
        usecase_id: STR,
        activity_id: STR,
        aggregate_id: STR,
        name: { type: "string", description: "意図の名前" },
        english: STR,
        emits: { type: "array", items: STR, description: "発生させるドメインイベントの id (保存したイベント。全体を置き換える)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_event",
    description:
      "ドメインイベントを足す・変える。分析のイベントの候補を採用するなら event_id。分析に無いあるべき姿のイベントは、aggregate_id (か context_id) と name で足す。別のところで発生するイベントは context_id で発生元のコンテキストを指す。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: ID_OR_NEW },
        event_id: { type: "string", description: "分析のイベントの id" },
        aggregate_id: STR,
        context_id: STR,
        name: { type: "string", description: "過去の形の名前" },
        english: STR,
        properties: { type: "array", items: STR, description: "属性の名前 (全体を置き換える)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_policy",
    description: "ポリシー (イベントが起きたらコマンドを実行する) を足す。どちらも保存したもの (ドメインイベントの id・コマンドの id) で指す。分析から導けるポリシーは足さなくてよい。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: { event_id: { type: "string", description: "ドメインイベントの id (de_...)" }, command_id: { type: "string", description: "コマンドの id (cm_...)" }, auto: { type: "boolean", description: "自動なら true (既定)" } },
      required: ["event_id", "command_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_relation",
    description: `コンテキスト間の関係を決める (同じ向きの関係があれば変える)。種類: ${CONTEXT_RELATION_KINDS.map((k) => `${k} = ${CONTEXT_RELATION_LABELS[k]}`).join("、")}。利用者が了承してから呼ぶこと。`,
    parameters: {
      type: "object",
      properties: {
        upstream_id: { type: "string", description: "上流のコンテキストの id" },
        downstream_id: { type: "string", description: "下流のコンテキストの id" },
        kind: { type: "string", enum: [...CONTEXT_RELATION_KINDS] },
        integration: { type: "string", enum: [...INTEGRATIONS] },
        note: STR,
      },
      required: ["upstream_id", "downstream_id", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "set_term",
    description: "用語の英語名と定義を決める。分析の要素の用語は element_id、分析に無い語は term で指す。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: { element_id: STR, term: STR, english: STR, definition: STR, context_id: { type: "string", description: "その語を使うコンテキストの id (省くと全体で共通)" } },
      additionalProperties: false,
    },
  },
  {
    name: "exclude_candidate",
    description: "分析から導いた候補を、あるべき姿から外す (excluded: false で戻す)。キーは usecase:<操作の id>、usecase:<操作の id>/activity:<作業の id>、event:<イベントの id>、policy:<関係の id>。利用者が了承してから呼ぶこと。",
    parameters: { type: "object", properties: { key: STR, excluded: { type: "boolean" } }, required: ["key"], additionalProperties: false },
  },
  {
    name: "remove_domain_part",
    description: "保存したコンテキスト・集約・コマンド・イベント・ポリシー・関係・用語を、id で消す (分析から導いた候補は消えない。コンテキストを消すと、その集約・コマンド・イベントも消える)。利用者が了承してから呼ぶこと。",
    parameters: { type: "object", properties: { id: STR }, required: ["id"], additionalProperties: false },
  },
  {
    name: "add_issue",
    description: "分析の誤りや抜けを、課題として残す (分析は直さない)。対象は、関わる業務・作業・操作の id。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "課題の名前 (短く)" }, description: STR, target_ids: { type: "array", items: STR } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const okJson = (data: unknown, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify(data), changed });
const fail = (reason: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: reason }), changed: false });
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const nameOf = (e: { name: string } | undefined | null) => e?.name || "(名前なし)";
/** 渡された項目だけの patch を作る */
const pick = (pairs: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(pairs).filter(([, v]) => v !== undefined));

/** get_domain の中身。AI が読む、対象のシステムのドメインモデル */
export function domainForAi(model: UntieModel, systemId: string): unknown {
  const r = resolveDomain(model, systemId);
  const ownIds = new Set(r.contexts.flatMap((c) => (c.saved ? [c.saved.id] : [])));
  const map = deriveContextMap(model);
  const contextName = new Map(model.domain.contexts.map((c) => [c.id, c.name]));
  return {
    system: nameOf(model.elements.find((e) => e.id === systemId)),
    note: "saved が true のものは保存した判断 (id は domain の id)。false は分析から導いた候補 (採用すると保存される。キーは分析の要素の id)",
    contexts: r.contexts.map((c) => ({
      id: c.key,
      saved: !!c.saved,
      name: c.name,
      role: c.role === "own" ? "このシステムが実装する" : "上流 (ほかのシステム)",
      ...(c.saved ? pick({ english: c.saved.english, subdomain: c.saved.subdomain, description: c.saved.description, team: c.saved.team, contextIds: c.saved.contextIds, unassigned: c.unassigned || undefined }) : {}),
    })),
    aggregates: r.aggregates.map((a) => ({
      id: a.key,
      saved: !!a.saved,
      name: a.name,
      ...pick({ english: a.english }),
      contextId: a.contextKey,
      rootInformationId: a.root.id,
      ...(a.members.length > 0 ? { members: a.members.map((m) => ({ id: m.id, name: m.name })) } : {}),
      writtenHere: a.writtenHere,
      ...(a.stateGroups.length > 0 ? { stateGroups: a.stateGroups, states: a.states.map((s) => s.name) } : {}),
      ...(a.saved ? { invariants: a.saved.invariants.map((i) => i.text) } : {}),
    })),
    commands: r.commands.map((c) => ({
      id: c.key,
      saved: !!c.saved,
      name: c.name,
      ...pick({ english: c.english }),
      aggregateId: c.aggregateKey,
      ...(c.candidate
        ? {
            usecaseId: c.candidate.usecase.id,
            ...(c.candidate.activity ? { activityId: c.candidate.activity.id } : {}),
            ...(c.candidate.activities.length > 1 ? { activities: c.candidate.activities.map((x) => ({ id: x.id, name: x.name })) } : {}),
            ...(c.candidate.auto ? { auto: true } : { actors: c.candidate.actors.map(nameOf) }),
            writes: c.candidate.writes.map((i) => i.name),
            ...(c.candidate.conditions.length > 0 ? { conditions: c.candidate.conditions.map((x) => ({ id: x.id, name: x.name })) } : {}),
          }
        : { toBe: true }),
      emits: c.eventKeys,
      ...(c.sourceKey && !c.saved ? { excludeKey: c.sourceKey } : {}),
    })),
    queries: r.scope.queries.map((q) => ({ usecaseId: q.usecase.id, name: nameOf(q.usecase) })),
    events: r.events.map((e) => ({
      id: e.key,
      saved: !!e.saved,
      name: e.name,
      ...pick({ english: e.english }),
      origin: e.origin === "inside" ? "このシステム" : "別のところ",
      contextId: e.contextKey,
      aggregateId: e.aggregateKey,
      ...(e.scoped ? { eventId: e.scoped.row.event.id } : { toBe: true }),
      ...(e.sourceKey && !e.saved ? { excludeKey: e.sourceKey } : {}),
    })),
    policies: r.policies.map((p) => ({ ...(p.saved ? { id: p.saved.id } : { excludeKey: p.key.split("@")[0] }), saved: !!p.saved, eventId: p.eventKey, commandId: p.commandKey, auto: p.auto })),
    excluded: r.excluded,
    contextFlows: map.flows
      .filter((f) => ownIds.has(f.upstreamId) || ownIds.has(f.downstreamId))
      .map((f) => ({
        upstreamId: f.upstreamId,
        upstream: contextName.get(f.upstreamId),
        downstreamId: f.downstreamId,
        downstream: contextName.get(f.downstreamId),
        ...(f.events.length > 0 ? { events: f.events } : {}),
        ...(f.reads.length > 0 ? { reads: f.reads } : {}),
        relation: f.relation ? pick({ kind: f.relation.kind, integration: f.relation.integration }) : f.reverseRelation ? { reverse: f.reverseRelation.kind } : null,
      })),
    terms: model.domain.terms.map((t) => pick({ id: t.id, term: t.term, english: t.english, definition: t.definition || undefined, elementId: t.elementId })),
    questions: r.scope.notices.filter((n) => n.level === "question").map((n) => n.message),
    undecided: checkDomain(model).map((p) => `${p.level === "error" ? "エラー" : "未決"}: ${p.message}`),
  };
}

/** 課題の対象にできる要素だけ (業務・作業・操作など) */
function issueTargets(model: UntieModel, ids: string[]): string[] | string {
  const byId = new Map<string, Element>(model.elements.map((e) => [e.id, e]));
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) return `対象の要素が存在しません: ${id}`;
    if (!(ISSUE_TARGET_KINDS as readonly string[]).includes(e.kind)) return `課題の対象にできない要素です: ${e.name || id}`;
  }
  return ids;
}

/** 対話の道具を 1 回実行する。書く道具は、ドメインモデルと課題の登録だけに効く */
export function executeDomainTalkTool(editor: ModelEditor, systemId: string, name: string, rawInput: unknown): ToolOutcome {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  /** コマンドを当てて、結果 (足したものの id など) を返す */
  const run = <T>(command: (m: UntieModel) => CommandResult<T>, data: (r: CommandResult<T> & { ok: true }) => unknown = () => ({ ok: true })): ToolOutcome => {
    const before = editor.getModel();
    const r = editor.apply(command);
    return r.ok ? okJson(data(r), r.model !== before) : fail(r.reason);
  };
  const id = str(input.id);
  const d = () => editor.getModel().domain;

  switch (name) {
    case "get_model":
      return executeTool(editor, name, input);

    case "get_domain":
      return okJson(domainForAi(editor.getModel(), systemId), false);

    case "save_context": {
      const patch = pick({
        name: str(input.name),
        english: str(input.english),
        description: str(input.description),
        subdomain: str(input.subdomain) as Subdomain | undefined,
        team: str(input.team),
        contextIds: strs(input.context_ids),
      });
      if (id !== undefined) return run((m) => updateBoundedContext(m, { id, patch }));
      if (!str(input.name)?.trim()) return fail("新しく足すときは name が必要です");
      return run((m) => addBoundedContext(m, { ...patch, name: str(input.name)!, systemIds: [systemId] }), (r) => ({ id: r.id }));
    }

    case "save_aggregate": {
      const invariants = Array.isArray(input.invariants)
        ? input.invariants.flatMap((i) => {
            const x = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
            const text = str(x.text)?.trim();
            return text ? [{ text, ...(str(x.condition_id) ? { conditionId: str(x.condition_id)! } : {}) }] : [];
          })
        : undefined;
      const fields = pick({ name: str(input.name), english: str(input.english), memberInformationIds: strs(input.member_information_ids), stateGroup: str(input.state_group) });
      const contextId = str(input.context_id);
      if (id !== undefined) {
        const saved = d().aggregates.find((a) => a.id === id);
        if (!saved) return fail(`集約が存在しません: ${id} (候補を採用するなら、id を省いて root_information_id を渡してください)`);
        // 不変条件は、同じ文のものの id を引き継いで置き換える
        // 同じ文のものは id と、もとの条件 (渡されなければ) を引き継ぐ
        const next = invariants?.map((i) => {
          const same = saved.invariants.find((x) => x.text === i.text);
          return same ? { ...(same.conditionId !== undefined ? { conditionId: same.conditionId } : {}), ...i, id: same.id } : i;
        });
        return run((m) => updateAggregate(m, { id, patch: { ...fields, ...(contextId ? { boundedContextId: contextId } : {}), ...(str(input.root_information_id) ? { rootInformationId: str(input.root_information_id)! } : {}), ...(next ? { invariants: next } : {}) } }));
      }
      const root = str(input.root_information_id);
      if (!root) return fail("新しく足すときは root_information_id が必要です");
      return run(
        (m) => {
          // コンテキストを指さなければ、候補の情報をそのコンテキストのまま採用する (コンテキストがまだ候補なら一緒に保存する)
          const added = contextId ? addAggregate(m, { boundedContextId: contextId, rootInformationId: root }) : adoptAggregateCandidate(m, { systemId, key: root });
          if (!added.ok) return added;
          const updated = updateAggregate(added.model, { id: added.id, patch: { ...fields, ...(invariants ? { invariants } : {}) } });
          return updated.ok ? { ...updated, id: added.id } : updated;
        },
        (r) => ({ id: r.id }),
      );
    }

    case "save_command": {
      const fields = pick({ name: str(input.name), english: str(input.english), emits: strs(input.emits) });
      const aggregateId = str(input.aggregate_id);
      if (id !== undefined) return run((m) => updateDomainCommand(m, { id, patch: { ...fields, ...(aggregateId ? { aggregateId } : {}) } }));
      const usecaseId = str(input.usecase_id);
      const activityId = str(input.activity_id);
      if (usecaseId) {
        return run(
          (m) => {
            const source = { usecaseId, ...(activityId ? { activityId } : {}) };
            let added: CommandResult<{ id: string }>;
            if (aggregateId) added = addDomainCommand(m, { aggregateId, source });
            else if (activityId) {
              // 作業ごとのコマンド: 操作の候補の集約 (まだ候補なら採用する) に、その作業の分として足す
              const candidate = resolveDomain(m, systemId).commands.find((c) => c.candidate?.usecase.id === usecaseId && c.aggregateKey !== null);
              if (!candidate) return { ok: false, reason: `操作 ${usecaseId} の候補が見つかりません (集約が決まらない操作なら、aggregate_id を渡してください)` };
              const aggregate = adoptAggregateCandidate(m, { systemId, key: candidate.aggregateKey! });
              added = aggregate.ok ? addDomainCommand(aggregate.model, { aggregateId: aggregate.id, source }) : aggregate;
            } else added = adoptCommandCandidate(m, { systemId, key: usecaseId });
            if (!added.ok) return added;
            if (Object.keys(fields).length === 0) return added;
            const updated = updateDomainCommand(added.model, { id: added.id, patch: fields });
            return updated.ok ? { ...updated, id: added.id } : updated;
          },
          (r) => ({ id: r.id }),
        );
      }
      if (!aggregateId || !str(input.name)?.trim()) return fail("分析に無いコマンドを足すときは、aggregate_id と name が必要です");
      return run((m) => addDomainCommand(m, { aggregateId, ...fields }), (r) => ({ id: r.id }));
    }

    case "save_event": {
      const properties = strs(input.properties)?.map((p) => ({ name: p }));
      const fields = pick({ name: str(input.name), english: str(input.english), properties });
      const aggregateId = str(input.aggregate_id);
      const contextId = str(input.context_id);
      const place = { ...(aggregateId ? { aggregateId } : {}), ...(contextId ? { boundedContextId: contextId } : {}) };
      if (id !== undefined) return run((m) => updateDomainEvent(m, { id, patch: { ...fields, ...place } }));
      const eventId = str(input.event_id);
      if (eventId) {
        return run(
          (m) => {
            const added = aggregateId ? addDomainEvent(m, { aggregateId, eventId }) : adoptEventCandidate(m, { systemId, key: eventId, ...(contextId ? { boundedContextId: contextId } : {}) });
            if (!added.ok) return added;
            if (Object.keys(fields).length === 0) return added;
            const updated = updateDomainEvent(added.model, { id: added.id, patch: fields });
            return updated.ok ? { ...updated, id: added.id } : updated;
          },
          (r) => ({ id: r.id }),
        );
      }
      if ((!aggregateId && !contextId) || !str(input.name)?.trim()) return fail("分析に無いイベントを足すときは、aggregate_id か context_id と、name が必要です");
      return run((m) => addDomainEvent(m, { ...place, ...fields }), (r) => ({ id: r.id }));
    }

    case "add_policy": {
      const eventId = str(input.event_id);
      const commandId = str(input.command_id);
      if (!eventId || !commandId) return fail("event_id と command_id が必要です");
      return run((m) => addDomainPolicy(m, { eventId, commandId, auto: input.auto !== false }), (r) => ({ id: r.id }));
    }

    case "set_relation": {
      const upstreamId = str(input.upstream_id);
      const downstreamId = str(input.downstream_id);
      const kind = str(input.kind) as ContextRelationKind | undefined;
      if (!upstreamId || !downstreamId || !kind) return fail("upstream_id・downstream_id・kind が必要です");
      const rest = pick({ integration: str(input.integration) as Integration | undefined, note: str(input.note) });
      const existing = d().relations.find((r) => r.upstreamId === upstreamId && r.downstreamId === downstreamId);
      if (existing) return run((m) => updateContextRelation(m, { id: existing.id, patch: { kind, ...rest } }), () => ({ id: existing.id }));
      return run((m) => addContextRelation(m, { upstreamId, downstreamId, kind, ...rest }), (r) => ({ id: r.id }));
    }

    case "set_term": {
      const elementId = str(input.element_id);
      const term = str(input.term)?.trim();
      if (!elementId && !term) return fail("element_id か term が必要です");
      const existing = elementId ? undefined : d().terms.find((t) => t.elementId === undefined && t.term === term);
      const contextId = str(input.context_id);
      return run(
        (m) =>
          setDomainTerm(m, {
            ...(existing ? { id: existing.id } : elementId ? { elementId } : { term: term! }),
            ...pick({ english: str(input.english), definition: str(input.definition) }),
            ...(contextId ? { boundedContextId: contextId } : {}),
          }),
        (r) => ({ id: r.id }),
      );
    }

    case "exclude_candidate": {
      const key = str(input.key);
      if (!key) return fail("key が必要です");
      return run((m) => setCandidateExcluded(m, { key, excluded: input.excluded !== false }));
    }

    case "remove_domain_part": {
      if (!id) return fail("id が必要です");
      const domain = d();
      if (domain.contexts.some((x) => x.id === id)) return run((m) => removeBoundedContext(m, { id }));
      if (domain.aggregates.some((x) => x.id === id)) return run((m) => removeAggregate(m, { id }));
      if (domain.commands.some((x) => x.id === id)) return run((m) => removeDomainCommand(m, { id }));
      if (domain.events.some((x) => x.id === id)) return run((m) => removeDomainEvent(m, { id }));
      if (domain.policies.some((x) => x.id === id)) return run((m) => removeDomainPolicy(m, { id }));
      if (domain.relations.some((x) => x.id === id)) return run((m) => removeContextRelation(m, { id }));
      if (domain.terms.some((x) => x.id === id)) return run((m) => removeDomainTerm(m, { id }));
      return fail(`保存したドメインモデルに、その id のものがありません: ${id} (分析から導いた候補は消せません。外すなら exclude_candidate)`);
    }

    case "add_issue": {
      const issueName = str(input.name)?.trim();
      if (!issueName) return fail("name が必要です");
      const targets = issueTargets(editor.getModel(), strs(input.target_ids) ?? []);
      if (typeof targets === "string") return fail(targets);
      const description = str(input.description)?.trim();
      return run((m) => addElement(m, { kind: "issue", name: issueName, init: { ...(description ? { description } : {}), ...(targets.length > 0 ? { targetIds: targets } : {}) } }), (r) => ({ id: r.id }));
    }

    default:
      return fail(`不明な道具です: ${name}`);
  }
}

/** 対話の最初の発言。対象のシステムを伝え、最初のラウンドを求める (中身は get_domain で読ませる) */
export function domainTalkOpening(model: UntieModel, systemId: string): string {
  const system = model.elements.find((e) => e.id === systemId);
  const r = resolveDomain(model, systemId);
  const questions = r.scope.notices.filter((n) => n.level === "question").length;
  return `システム「${nameOf(system)}」のドメインモデルを、一緒に決めていきます。
いまは、コンテキスト ${r.contexts.length} (保存 ${r.contexts.filter((c) => c.saved).length})・集約 ${r.aggregates.length} (保存 ${r.aggregates.filter((a) => a.saved).length})・コマンド ${r.commands.length} (保存 ${r.commands.filter((c) => c.saved).length})・イベント ${r.events.length} (保存 ${r.events.filter((e) => e.saved).length})、気づきの問いが ${questions} 件あります。

まず get_domain で中身を確かめてから、最初のラウンドの質問を出してください。`;
}
