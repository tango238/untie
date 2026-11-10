// 設計モードのドメインボード「AI で下書き」: 分析から導いた候補と気づきから、対象のシステムのドメインモデル
// (境界づけられたコンテキスト・集約と不変条件・コマンドとイベントの意図の名前と英語名・ポリシー・関係・用語) を一回きりで作らせる。
// AI は submit_domain_model で下書きを提出し、当てられないところ (無い id・英語名の抜けや重なり) があれば理由を返して出し直させる。
// 分析の要素には書かない (保存するのは domain だけ)。
import { CONTEXT_RELATION_KINDS, INTEGRATIONS, SUBDOMAINS } from "@untie/core/model/domain";
import { applyDomainDraft, draftScopeContextIds, type DomainDraft, type DomainDraftSummary } from "@untie/core/model/domainDraft";
import { resolveDomain } from "@untie/core/model/domainResolve";
import { emptyDomain, type UntieModel } from "@untie/core/model/types";
import { ChatError, createChatSession } from "./chat";
import { extractJson } from "./designData";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

const ENGLISH = { type: "string", description: "英語名 (コードでの名前)。英字で始まる英数字。PascalCase" } as const;

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    eventId: { type: "string", description: "分析のイベントを指すなら、その id。分析に無いあるべき姿のイベントなら省く" },
    name: { type: "string", description: "名前 (過去の形)。省くと分析のイベントの名前" },
    english: { ...ENGLISH, description: "英語名。過去分詞の PascalCase (例: OrderConfirmed)" },
    properties: { type: "array", items: { type: "string" }, description: "属性の名前" },
  },
  required: ["english"],
  additionalProperties: false,
} as const;

export const SUBMIT_DOMAIN_TOOL: ToolDef = {
  name: "submit_domain_model",
  description: "対象のシステムのドメインモデルの下書きを提出する。当てられないところ (無い id・英語名の抜けや重なり) があると理由が返るので、直して全体を出し直す。",
  parameters: {
    type: "object",
    properties: {
      contexts: {
        type: "array",
        description: "対象のシステムが実装する境界づけられたコンテキスト",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            english: ENGLISH,
            description: { type: "string", description: "責務 (1〜2 文)" },
            subdomain: { type: "string", enum: [...SUBDOMAINS], description: "core (競争力の源)・supporting (支える)・generic (どこでも同じ)" },
            team: { type: "string" },
            contextIds: { type: "array", items: { type: "string" }, description: "言語の範囲にする分析のコンテキストの id" },
            aggregates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "省くとルートの情報の名前" },
                  english: ENGLISH,
                  rootInformationId: { type: "string", description: "ルートにする情報の id" },
                  memberInformationIds: { type: "array", items: { type: "string" }, description: "同じトランザクションで整合させる情報の id (無ければ省く)" },
                  stateGroup: { type: "string", description: "ライフサイクルの状態グループの名前" },
                  invariants: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { text: { type: "string" }, conditionId: { type: "string", description: "もとにした分析の条件の id (あれば)" } },
                      required: ["text"],
                      additionalProperties: false,
                    },
                  },
                  commands: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        usecaseId: { type: "string", description: "分析の操作から採用するなら、その id。分析に無いあるべき姿のコマンドなら省く" },
                        activityId: { type: "string", description: "作業ごとに分けるときだけ、その作業の id" },
                        name: { type: "string", description: "意図の名前 (「〜を記録する」ではなく「〜する」)。省くと操作の名前" },
                        english: { ...ENGLISH, description: "英語名。動詞で始まる PascalCase (例: ConfirmOrder)" },
                        emits: { type: "array", items: { type: "string" }, description: "発生させるイベントの英語名" },
                      },
                      required: ["english"],
                      additionalProperties: false,
                    },
                  },
                  events: { type: "array", items: EVENT_SCHEMA },
                },
                required: ["english", "rootInformationId"],
                additionalProperties: false,
              },
            },
            events: { type: "array", items: EVENT_SCHEMA, description: "集約に属さない、このコンテキストのイベント" },
          },
          required: ["name", "english"],
          additionalProperties: false,
        },
      },
      policies: {
        type: "array",
        description: "分析に無い、あるべき姿のポリシー (イベントが起きたらコマンドを実行する)。分析から導けるものは書かない",
        items: {
          type: "object",
          properties: { event: { type: "string", description: "イベントの英語名" }, command: { type: "string", description: "コマンドの英語名" }, auto: { type: "boolean", description: "自動なら true、人の判断をはさむなら false" } },
          required: ["event", "command"],
          additionalProperties: false,
        },
      },
      relations: {
        type: "array",
        description: "コンテキスト間の関係。上流・下流は英語名で指す (残すコンテキストも指せる)",
        items: {
          type: "object",
          properties: {
            upstream: { type: "string" },
            downstream: { type: "string" },
            kind: { type: "string", enum: [...CONTEXT_RELATION_KINDS] },
            integration: { type: "string", enum: [...INTEGRATIONS] },
            note: { type: "string" },
          },
          required: ["upstream", "downstream", "kind"],
          additionalProperties: false,
        },
      },
      terms: {
        type: "array",
        description: "用語 (ユビキタス言語)。分析の要素の英語名と定義か、分析に無い語",
        items: {
          type: "object",
          properties: { elementId: { type: "string" }, term: { type: "string" }, english: { type: "string" }, definition: { type: "string" } },
          additionalProperties: false,
        },
      },
      excluded: { type: "array", items: { type: "string" }, description: "あるべき姿から外す候補のキー (usecase:<操作の id>、event:<イベントの id>)。現状の手順 (転記・紙への記入) を写しただけのもの" },
    },
    required: ["contexts"],
    additionalProperties: false,
  },
};

export function domainDesignSystemPrompt(): string {
  return `あなたはドメイン駆動設計 (DDD) に詳しい設計者です。業務分析 (RDRA) から導いた候補をもとに、対象のシステムのドメインモデルの下書きを作ります。
分析は現状 (as-is) の業務です。下書きは、これから作るシステムのあるべき姿 (to-be) にします。分析の要素は変えません。分析の要素は id で指します。

決めること:
- 境界づけられたコンテキスト: 言葉の意味がそろう範囲。分析のコンテキストを下敷きにするが、同じ語が別の意味で使われていれば分け、いつも一緒に変わるものはまとめる。サブドメインの分類 (core / supporting / generic) と責務を書く
- 集約: 1 つのトランザクションで整合を守る最小の単位。ルートの情報を 1 つ決め、同時に整合させる必要がある情報だけを中に入れる。迷ったら小さくする (ほかの集約は ID で参照する)。状態グループの持ち主は、その状態グループを stateGroup に書く
- 不変条件: 集約の中で常に守るルール。分析の条件・状態の遷移から読み取れるものを、業務の言葉で書く (もとの条件があれば conditionId)
- コマンド: 分析の操作を採用する (usecaseId)。名前は意図にする (「出荷を記録する」ではなく「出荷する」)。複数の作業が違う意図で使う操作は、作業ごとに分けてよい (activityId)。分析に無いが要るコマンドは usecaseId を省いて足す
- イベント: 過去の形の事実の名前にする (「〜が記録された」ではなく「〜した」「〜された」)。分析のイベントを採用する (eventId)。要るのに無いイベント (失敗の結果など) は足す。コマンドの emits にイベントの英語名を書く
- ポリシー: 分析に無いものだけ書く (分析のイベント → 操作のきっかけは、書かなくても導かれる)
- 外す候補 (excluded): 現状の手順を写しただけで、システムにすると要らなくなる操作・イベント (別のシステムへの転記、紙への記入、手での突き合わせ)
- 関係 (relations): コンテキストのあいだにつながり (イベントがきっかけになる・情報を読む) があれば、種類を決める。外部のサービスから自分のモデルを守るなら acl、相手に合わせるしかないなら conformist など
- 用語 (terms): 主な情報・状態の英語名と、1 文の定義

決まり:
- 英語名 (english) は、コンテキスト・集約・コマンド・イベントのすべてに必ず付ける。英字で始まる英数字だけ (PascalCase)。同じ英語名を 2 つに付けない
- 対象のシステムが書く情報は、必ずどれかの集約 (ルートか中の情報) に入れる。読むだけの情報は集約にしない (上流のものとして残す)
- 「気づき」の問いに、下書きで答えを出す (どの集約のものか・分けるか・イベントが要るか)。決め切れないものは、分析の候補のまま残してよい (書かなければ候補として残る)
- 「残すコンテキスト」は、ほかのシステムのものなので作り直さない。関係とポリシーでは英語名で指せる
- 結果は submit_domain_model で提出する。当てられないところがあると理由が返るので、直して全体を出し直す`;
}

const nameOf = (e: { name: string } | undefined | null) => e?.name || "(名前なし)";

/** 対象のシステムの候補・気づき・今のドメインモデルを渡す依頼の文章 */
export function domainDesignRequest(model: UntieModel, systemId: string): string {
  const system = model.elements.find((e) => e.id === systemId);
  // 候補は、保存した判断を重ねる前のもの (分析から導いたまま) を渡す
  const scope = resolveDomain({ ...model, domain: emptyDomain() }, systemId).scope;
  const contexts = scope.contexts.map((c) => ({
    id: c.context?.id ?? null,
    name: c.context ? nameOf(c.context) : "未分類",
    role: c.role === "own" ? "このシステムが書く" : "読むだけ",
    informations: c.aggregates.map((a) => {
      const info = a.candidate.information;
      return {
        id: info.id,
        name: nameOf(info),
        ...(info.description ? { description: info.description } : {}),
        written: a.writtenHere,
        ...(a.candidate.stateGroups.length > 0 ? { stateGroups: a.candidate.stateGroups, states: a.candidate.states.map((s) => s.name) } : {}),
        ...(a.candidate.related.length > 0 ? { related: a.candidate.related.map((i) => i.id) } : {}),
        ...(a.candidate.coWritten.length > 0 ? { writtenTogether: a.candidate.coWritten.map((i) => i.id) } : {}),
        ...(a.otherWriterSystems.length > 0 ? { alsoWrittenBy: a.otherWriterSystems.map(nameOf) } : {}),
      };
    }),
  }));
  const commands = scope.commands.map((c) => ({
    usecaseId: c.usecase.id,
    name: nameOf(c.usecase),
    ...(c.auto ? { auto: true, triggeredBy: c.triggeredBy.map((e) => e.id) } : { actors: c.actors.map(nameOf) }),
    ...(c.activities.length > 1 ? { activities: c.activities.map((a) => ({ id: a.id, name: nameOf(a) })) } : {}),
    writes: c.writes.map((i) => i.id),
    reads: c.reads.map((i) => i.id),
    ...(c.preStates.length + c.postStates.length > 0 ? { states: `${c.preStates.map((s) => s.name).join("・") || "—"} → ${c.postStates.map((s) => s.name).join("・") || "—"}` } : {}),
    ...(c.conditions.length > 0 ? { conditions: c.conditions.map((x) => ({ id: x.id, name: nameOf(x), ...(x.description ? { description: x.description } : {}) })) } : {}),
    ...(c.events.length > 0 ? { emits: c.events.map((e) => e.id) } : {}),
    ...(c.aggregate ? { aggregateCandidate: c.aggregate.id } : {}),
  }));
  const events = scope.events.map((e) => ({
    eventId: e.row.event.id,
    name: nameOf(e.row.event),
    origin: e.origin === "inside" ? "このシステムで発生" : `別のところで発生 (${e.sources.map(nameOf).join("・") || "発生元なし"})`,
    ...(e.row.consumers.usecases.length > 0 ? { triggers: e.row.consumers.usecases.map((u) => u.id) } : {}),
  }));
  const notices = scope.notices.filter((n) => n.level === "question").map((n) => n.message);
  const own = new Set(draftScopeContextIds(model, systemId));
  const kept = model.domain.contexts
    .filter((c) => !own.has(c.id))
    .map((c) => ({
      english: c.english ?? null,
      name: c.name,
      systems: c.systemIds.map((id) => nameOf(model.elements.find((e) => e.id === id))),
      events: model.domain.events.filter((e) => e.boundedContextId === c.id && e.english).map((e) => ({ english: e.english, name: e.name })),
    }));
  const current = model.domain.contexts
    .filter((c) => own.has(c.id))
    .map((c) => ({
      name: c.name,
      english: c.english ?? null,
      aggregates: model.domain.aggregates
        .filter((a) => a.boundedContextId === c.id)
        .map((a) => ({ name: a.name, english: a.english ?? null, rootInformationId: a.rootInformationId, memberInformationIds: a.memberInformationIds, invariants: a.invariants.map((i) => i.text) })),
    }));
  return `システム「${nameOf(system)}」のドメインモデルの下書きを作ってください。

<分析のコンテキストと情報>
${JSON.stringify(contexts, null, 1)}
</分析のコンテキストと情報>

<コマンドの候補 (このシステムを対象にした、情報を書く操作)>
${JSON.stringify(commands, null, 1)}
</コマンドの候補>

<問い合わせ (読むだけの操作。コマンドにしない)>
${JSON.stringify(scope.queries.map((q) => ({ usecaseId: q.usecase.id, name: nameOf(q.usecase), reads: q.reads.map((i) => i.id) })))}
</問い合わせ>

<イベントの候補>
${JSON.stringify(events, null, 1)}
</イベントの候補>

<気づき (分析から読み取れた、決めるべき問い)>
${notices.length > 0 ? notices.map((n) => `- ${n}`).join("\n") : "(なし)"}
</気づき>

<残すコンテキスト (ほかのシステムのもの。作り直さない。英語名で指せる)>
${JSON.stringify(kept)}
</残すコンテキスト>

<今のドメインモデル (このシステムだけが実装するコンテキスト。下書きで置き換える。良いところは引き継ぐ)>
${current.length > 0 ? JSON.stringify(current, null, 1) : "(まだ無い)"}
</今のドメインモデル>

下書きを submit_domain_model で提出してください。`;
}

/** 提出された内容 (または文章の中の JSON) を取り出す。形が違えば null */
export function readDomainDraft(raw: unknown): DomainDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { contexts?: unknown };
  if (!Array.isArray(r.contexts)) return null;
  return raw as DomainDraft;
}

export interface DomainDesignOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface DomainDesignResult {
  /** そのまま applyDomainDraft に渡せる下書き (提出の時点のモデルに当てられることを確かめてある) */
  draft: DomainDraft;
  summary: DomainDraftSummary;
}

/** 出し直しを含めて、下書きを受け取る回数の上限 */
export const DOMAIN_DRAFT_MAX_ATTEMPTS = 3;

/**
 * 対象のシステムのドメインモデルの下書きを作る。モデルには書かず、下書きを返す (呼ぶ側が applyDomainDraft を dispatch する)。
 * 当てられないところがあれば理由を返して出し直させ、上限まで直らなければ失敗にする (中途半端な下書きは置かない)
 */
export async function generateDomainDraft(model: UntieModel, systemId: string, o: DomainDesignOptions): Promise<DomainDesignResult> {
  const box: { value: DomainDesignResult | null; lastReason: string | null } = { value: null, lastReason: null };
  let attempts = 0;

  const evaluate = (draft: DomainDraft): string | null => {
    const r = applyDomainDraft(model, { systemId, draft });
    if (!r.ok) return r.reason;
    box.value = { draft, summary: r.summary };
    return null;
  };

  const runTool = (name: string, input: unknown): ToolOutcome => {
    if (name !== SUBMIT_DOMAIN_TOOL.name) return { ok: false, content: JSON.stringify({ error: `不明な道具です: ${name}` }), changed: false };
    const draft = readDomainDraft(input);
    if (!draft) return { ok: false, content: JSON.stringify({ error: "contexts (配列) が必要です" }), changed: false };
    attempts++;
    const reason = evaluate(draft);
    if (reason === null) return { ok: true, content: JSON.stringify({ result: "受け付けました" }), changed: false };
    box.lastReason = reason;
    const again = attempts < DOMAIN_DRAFT_MAX_ATTEMPTS ? "直して、全体を submit_domain_model で出し直してください" : "これ以上は受け付けません";
    return { ok: false, content: JSON.stringify({ error: `当てられないところがあります。${again}:\n${reason}` }), changed: false };
  };

  const session = createChatSession(o.provider, { apiKey: o.apiKey, model: o.model, system: domainDesignSystemPrompt(), tools: [SUBMIT_DOMAIN_TOOL], runTool });
  const text = await session.send(domainDesignRequest(model, systemId), {}, o.signal);
  if (!box.value && attempts === 0) {
    // 道具を呼ばずに文章で JSON を返したときは、それを読む
    const draft = readDomainDraft(extractJson(text));
    if (draft) {
      attempts++;
      box.lastReason = evaluate(draft);
    }
  }
  if (!box.value && attempts === 0) await session.send("submit_domain_model でドメインモデルの下書きを提出してください。", {}, o.signal);
  if (!box.value) {
    throw new ChatError(
      box.lastReason !== null
        ? `AI が作った下書きに、当てられないところが残ったため、保存しませんでした。もう一度試してください。\n${box.lastReason.split("\n").slice(0, 5).join("\n")}`
        : "AI がドメインモデルの下書きを提出しませんでした。もう一度試してください。",
    );
  }
  return box.value;
}
