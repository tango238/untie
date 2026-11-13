// 「プロンプトから作成」で AI に出してもらうモデルの下書き (名前で参照する形) と、それをモデルに組み立てる処理。
// AI には id を作らせず、名前で参照させる。組み立ては既存のコマンドで行い、整合性の検査もコマンドに任せる。
import { addElement, addRelation, DUPLICATE_RELATION_REASON, setPersona, setRelationAccess, setScreenUsecase, updateElement, type CommandResult, type ElementInit } from "@untie/core/model/commands";
import { DESCRIPTION_MAX_LENGTH, GROUP_MAX_LENGTH, NAME_MAX_LENGTH, TRIGGER_NOTE_MAX_LENGTH, truncateText, VALUE_MAX_LENGTH } from "@untie/core/model/limits";
import { isUndirected, relationKindFor } from "@untie/core/model/relations";
import { defaultBucOf } from "@untie/core/model/selectors";
import { ELEMENT_KIND_LABELS, emptyModel, isIssueTargetKind, isPersonaItSkill, issueScopeOfKind, type Element, type ElementKind, type UntieModel } from "@untie/core/model/types";
import { mergePersonaInput, PERSONA_TOOL_PROPERTIES, type ToolDef } from "./tools";

export interface SpecNamed {
  name: string;
  description?: string;
}

/** ペルソナ (アクター・外部アクターの人物像。すべて任意) */
export interface SpecPersona {
  handle?: string;
  attributes?: string;
  background?: string;
  goals?: string;
  it_skill?: string;
  notes?: string;
}

export interface SpecActor extends SpecNamed {
  persona?: SpecPersona;
}

export interface SpecUsecase extends SpecNamed {
  /** 扱う情報 (取得も保存もする) */
  informations?: string[];
  /** 取得だけする情報 */
  reads?: string[];
  /** 保存だけする情報 */
  writes?: string[];
  conditions?: string[];
  /** この操作を実行できる状態 */
  from_states?: string[];
  /** 実行後の状態 */
  to_states?: string[];
  /** 対象のシステム・帳票 */
  targets?: string[];
}

export interface SpecActivity extends SpecNamed {
  /** 担当 (アクター・外部アクターの名前。システムの名前が来たら、その作業の操作の対象にする) */
  performers?: string[];
  usecases?: SpecUsecase[];
  /** 起点となる作業の名前 (別の作業。モデルのどこにあってもよい) */
  trigger_activities?: string[];
  /** 起点となるイベントの名前 (events に定義したもの) */
  trigger_events?: string[];
  /** 起点のうち、作業・イベント以外 (「電話」など。1 行) */
  trigger_note?: string;
}

/** 画面 (分析の画面)。1 つの画面を使う操作は 1 つだけ */
export interface SpecScreen extends SpecNamed {
  /** 属するシステムの名前 (systems に定義したもの。システムが 1 つだけなら省いてよい) */
  system?: string;
  /** この画面を使う操作の名前。1 つだけ (操作の対象がこの画面になる)。同じ画面で済ませたい操作が複数あれば、操作ごとに画面を分ける */
  usecase?: string;
}

/** イベント。人が担当しない処理 (バッチ・通知の受信・自動の連鎖) は作業にせず、イベントをきっかけにした操作にする */
export interface SpecEvent extends SpecNamed {
  context?: string;
  /** このイベントを起こすもの: システムの名前か、操作の名前。必ず 1 つ以上 (無いと担い手まで辿れない) */
  raised_by?: string[];
  /** このイベントをきっかけに行う操作 (作業に属さない処理。ほかの場所で定義した操作の名前でもよい) */
  usecases?: SpecUsecase[];
}

export interface SpecBuc extends SpecNamed {
  activities?: SpecActivity[];
}

export interface SpecBusiness extends SpecNamed {
  main_actors?: string[];
  /** 活動 (BUC) に分けない作業 */
  activities?: SpecActivity[];
  bucs?: SpecBuc[];
}

export interface SpecInformation extends SpecNamed {
  context?: string;
  related?: string[];
  variations?: string[];
}

export interface ModelSpec {
  system_name: string;
  overview?: string;
  actors?: SpecActor[];
  external_actors?: SpecActor[];
  systems?: SpecNamed[];
  ledgers?: SpecNamed[];
  businesses: SpecBusiness[];
  screens?: SpecScreen[];
  events?: SpecEvent[];
  contexts?: SpecNamed[];
  informations?: SpecInformation[];
  conditions?: (SpecNamed & { context?: string; variations?: string[]; states?: string[] })[];
  variations?: (SpecNamed & { context?: string; values?: string[] })[];
  state_groups?: { name: string; context?: string; states: SpecNamed[] }[];
  issues?: { name: string; description?: string; severity?: number; targets?: string[] }[];
}

// ---------------------------------------------------------------- JSON Schema (AI に渡す)

const named = (extra: Record<string, unknown> = {}, required: string[] = ["name"]) => ({
  type: "object",
  properties: { name: { type: "string" }, description: { type: "string" }, ...extra },
  required,
  additionalProperties: false,
});
const names = (description: string) => ({ type: "array", items: { type: "string" }, description });
const list = (items: unknown, description: string) => ({ type: "array", items, description });

const actorSchema = named({
  persona: {
    type: "object",
    description: "ペルソナ (任意): この人物像。要望から読み取れる範囲で、分かるものだけを短く書く。無理に作らない",
    properties: PERSONA_TOOL_PROPERTIES,
    additionalProperties: false,
  },
});

const usecaseSchema = named({
  informations: names("取得も保存もする情報の名前 (informations に定義したもの)"),
  reads: names("取得 (読む) だけする情報の名前"),
  writes: names("保存 (書く) だけする情報の名前"),
  conditions: names("判断に使う条件の名前 (conditions に定義したもの)"),
  from_states: names("この操作を実行できる状態の名前"),
  to_states: names("実行後に移る状態の名前"),
  targets: names("操作の対象のシステム・帳票の名前 (systems / ledgers に定義したもの)。1 つだけ。情報の置き場所 (取得元・保存先) は、対象と扱う情報 (informations / reads / writes) から導く"),
});
const activitySchema = named({
  performers: names("担当する人の名前 (actors / external_actors に定義したもの)。必ず 1 つ以上。システムは担当にせず、操作の targets に書く"),
  usecases: list(usecaseSchema, "この作業で使う操作 (システム・帳票に対する 1 回の操作)。同じ名前の操作は同じものとして扱う"),
  trigger_activities: names("この作業が始まる起点になる別の作業の名前 (どこの業務の作業でもよい。モデルのほかの作業と同じ名前にする)。無ければ省く"),
  trigger_events: names("この作業が始まる起点になるイベントの名前 (events に定義したもの)。無ければ省く"),
  trigger_note: { type: "string", description: "起点のうち、作業以外の 1 行 (例: 電話、月初になったとき)。無ければ省く" },
});

export const SUBMIT_MODEL_TOOL: ToolDef = {
  name: "submit_model",
  description:
    "作成した業務モデル全体を提出する。要素どうしは名前で参照する (id は作らない)。参照する名前は、それぞれの一覧に定義したものと完全に一致させる。提出すると検査結果が返る。問題があれば直して提出し直す。",
  parameters: {
    type: "object",
    properties: {
      system_name: { type: "string", description: "モデル (システム) の名前" },
      overview: { type: "string", description: "概要" },
      actors: list(actorSchema, "社内の人の役割 (〇〇担当など)"),
      external_actors: list(actorSchema, "社外の人・組織 (顧客・取引先など)"),
      systems: list(named(), "情報システム (自社・社外を問わない)。操作の対象になる (作業の担当にはならない)。情報の置き場所は、対象にした操作が扱う情報から導く"),
      ledgers: list(named(), "紙の台帳・伝票。記入・参照する操作の対象になる"),
      businesses: list(
        named({
          main_actors: names("主担当のアクターの名前"),
          activities: list(activitySchema, "活動 (BUC) に分けない作業"),
          bucs: list(named({ activities: list(activitySchema, "この活動の作業 (順番どおり)") }), "活動 (BUC): 1 つの目的を果たす作業のまとまり"),
        }),
        "業務: 部門や担当で分かれる仕事の大きなまとまり",
      ),
      screens: list(
        named({
          system: { type: "string", description: "属するシステムの名前 (systems に定義したもの)。システムが 1 つだけなら省いてよい" },
          usecase: { type: "string", description: "この画面を使う操作の名前。1 つだけ。操作の対象はこの画面になる (その操作に別のシステム・帳票を対象にしない)。複数の操作が同じ画面を使うなら、操作ごとに画面を分ける" },
        }),
        "画面: 利用者が操作する画面。要望・資料から読み取れるものだけ書く",
      ),
      events: list(
        named({
          context: { type: "string", description: "所属するコンテキストの名前" },
          raised_by: names("このイベントを起こすシステム (systems に定義したもの) か操作の名前。必ず 1 つ以上"),
          usecases: list(usecaseSchema, "このイベントをきっかけに行う操作。人が担当しない処理 (バッチ・通知の受信・自動の連鎖) はこちらに書き、作業にはしない。同じ名前の操作は同じものとして扱う"),
        }),
        "イベント: システムや操作が起こす出来事。ほかの処理や作業のきっかけになる",
      ),
      contexts: list(named(), "コンテキスト: 役割の同じ情報をまとめる親カテゴリ"),
      informations: list(
        named({
          context: { type: "string", description: "所属するコンテキストの名前" },
          related: names("関連する情報の名前"),
          variations: names("種別にしているバリエーションの名前"),
        }),
        "情報: 業務で扱う記録や書類",
      ),
      conditions: list(
        named({
          context: { type: "string" },
          variations: names("区分に使うバリエーションの名前"),
          states: names("参照する状態の名前"),
        }),
        "条件: 判断に使うルール (はい・いいえで答えられる形)",
      ),
      variations: list(named({ context: { type: "string" }, values: names("値の一覧") }), "バリエーション: 種別と値の一覧"),
      state_groups: list(
        {
          type: "object",
          properties: { name: { type: "string" }, context: { type: "string" }, states: list(named(), "状態 (順番どおり)") },
          required: ["name", "states"],
          additionalProperties: false,
        },
        "状態グループ: 情報やモノがたどる段階",
      ),
      issues: list(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            severity: { type: "integer", minimum: 1, maximum: 5 },
            targets: names("対象の名前。登場人物 (アクター・外部アクター・システム・帳票) だけなら全体的な課題、業務・作業・操作だけなら具体的な課題。混ぜない"),
          },
          required: ["name"],
          additionalProperties: false,
        },
        "課題: 初期要望から読み取れる困りごと (あれば)",
      ),
    },
    required: ["system_name", "businesses"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------- 組み立て

/** 状態グループとバリエーションの値も上限に収める */
function clipInit(init: Record<string, unknown>): Record<string, unknown> {
  const out = { ...init };
  if (typeof out.group === "string") out.group = truncateText(out.group, GROUP_MAX_LENGTH);
  if (Array.isArray(out.values)) out.values = out.values.map((v) => (typeof v === "string" ? truncateText(v, VALUE_MAX_LENGTH) : v));
  return out;
}

/** AI の出力は長さが読めないので、スキーマの上限 (limits.ts) に収まるよう切り詰める (要素ごと作れなくなるより、末尾が欠ける方がよい) */
const nameOf = (text: string) => truncateText(text.trim(), NAME_MAX_LENGTH);

/**
 * 下書きの一覧ごとの上限。AI の出力 (特にソースコードから読んだ大きな下書き) が巨大でも、組み立てで画面が固まらないようにする。
 * 超えた分は先頭から使い、「先頭 N 件だけ使いました」と warnings に残す。activities・usecases は、業務・活動・イベントをまたいだ合計
 */
export const SPEC_LIMITS = {
  actors: 200,
  externalActors: 200,
  systems: 50,
  ledgers: 200,
  contexts: 100,
  variations: 300,
  /** 1 つのバリエーションの値・1 つの状態グループの状態 */
  valuesPerItem: 200,
  stateGroups: 100,
  informations: 500,
  conditions: 300,
  businesses: 50,
  /** 1 つの業務の活動 */
  bucsPerBusiness: 100,
  /** 作業の合計 */
  activities: 500,
  /** 操作の合計 (作業の下とイベントの下の合計) */
  usecases: 500,
  screens: 300,
  events: 150,
  issues: 200,
  /** 1 つの要素が名前で参照するものの数 (担当・情報・条件・状態・対象・起点など。種類ごと) */
  refsPerItem: 100,
} as const;

export interface BuildResult {
  model: UntieModel;
  /** 名前が見つからなかったなど、組み立てで気づいたこと */
  warnings: string[];
  counts: Partial<Record<ElementKind, number>>;
}

/** 下書きをモデルに組み立てる。参照先の名前が無ければ、その参照を飛ばして warnings に残す */
export function buildModelFromSpec(spec: ModelSpec): BuildResult {
  let model = emptyModel(nameOf(spec.system_name || "") || "新しいモデル");
  if (spec.overview) model = { ...model, meta: { ...model.meta, description: truncateText(spec.overview, DESCRIPTION_MAX_LENGTH) } };
  const warnings: string[] = [];
  /** 名前が無くて飛ばした要素の数 (種類ごと) */
  const nameless = new Map<ElementKind, number>();
  const L = SPEC_LIMITS;
  /** 一覧の先頭 max 件だけ使い、超えたら警告に残す (配列でなければ空) */
  const clip = <T,>(list: readonly T[] | undefined, max: number, what: string): T[] => {
    if (!Array.isArray(list)) return [];
    if (list.length > max) warnings.push(`${what}は先頭 ${max} 件だけ使いました (${list.length} 件ありました)`);
    return list.slice(0, max);
  };
  /** 合計の上限 (作業・操作)。超えた分は数えて、最後に 1 度だけ警告にする */
  const budget = (max: number, what: string) => {
    let used = 0;
    let over = 0;
    return {
      take: (): boolean => {
        if (used < max) {
          used++;
          return true;
        }
        over++;
        return false;
      },
      report: () => {
        if (over > 0) warnings.push(`${what}は先頭 ${max} 件だけ使いました (${over} 件を飛ばしました)`);
      },
    };
  };
  const activityBudget = budget(L.activities, "作業");
  const usecaseBudget = budget(L.usecases, "操作");
  // 種類ごとの名前 → id
  const ids = new Map<string, Map<string, string>>();
  const idOf = (group: string, name: string) => ids.get(group)?.get(nameOf(name));

  const apply = <T>(r: CommandResult<T>, what: string): (T & { model: UntieModel }) | null => {
    if (!r.ok) {
      warnings.push(`${what}: ${r.reason}`);
      return null;
    }
    model = r.model;
    return r as T & { model: UntieModel };
  };
  const add = (kind: ElementKind, group: string, item: SpecNamed, init: Record<string, unknown> = {}): string | null => {
    const name = typeof item.name === "string" ? nameOf(item.name) : "";
    if (!name) {
      nameless.set(kind, (nameless.get(kind) ?? 0) + 1);
      return null;
    }
    const existing = idOf(group, name);
    if (existing) return existing;
    const r = apply(
      addElement(model, { kind, name, init: { ...(item.description ? { description: truncateText(item.description, DESCRIPTION_MAX_LENGTH) } : {}), ...clipInit(init) } as ElementInit }),
      `${name} を作れません`,
    );
    if (!r) return null;
    if (!ids.has(group)) ids.set(group, new Map());
    ids.get(group)!.set(name, r.id);
    kindById.set(r.id, kind);
    return r.id;
  };
  /** 要素の id → 種類、関係の (種類・両端) → 関係の id。関係を作るたびに全部を調べ直さないための索引 (向きを持たない関係は、両端の順を無視する) */
  const kindById = new Map<string, ElementKind>();
  const relationByKey = new Map<string, string>();
  const relationKey = (kind: string, a: string, b: string) => (isUndirected(kind as never) && a > b ? `${kind}:${b}:${a}` : `${kind}:${a}:${b}`);
  const relate = (sourceId: string | null | undefined, targetId: string | null | undefined, access?: "read" | "write") => {
    if (!sourceId || !targetId) return;
    const sourceKind = kindById.get(sourceId);
    const targetKind = kindById.get(targetId);
    const kind = sourceKind && targetKind ? relationKindFor(sourceKind, targetKind) : null;
    const sameId = kind ? relationByKey.get(relationKey(kind, sourceId, targetId)) : undefined;
    if (kind && sameId) {
      // 操作が情報を取得と保存の両方に書かれたら、区別を外して取得も保存もする関係にする
      const same = kind === "usecaseInformation" ? model.relations.find((r) => r.id === sameId) : undefined;
      if (same && same.access !== undefined && same.access !== access) {
        const r = setRelationAccess(model, { id: same.id, access: null });
        if (r.ok) model = r.model;
      }
      return;
    }
    const r = addRelation(model, { sourceId, targetId, ...(access ? { access } : {}) });
    if (r.ok) {
      model = r.model;
      if (kind) relationByKey.set(relationKey(kind, sourceId, targetId), r.id);
    } else if (r.reason !== DUPLICATE_RELATION_REASON) /* AI が同じつながりを 2 か所に書いただけなので、警告にしない */ warnings.push(`関係を作れません: ${r.reason}`);
  };
  const ref = (groups: string[], name: string, what: string): string | null => {
    for (const g of groups) {
      const id = idOf(g, name);
      if (id) return id;
    }
    warnings.push(`${what}「${name}」が見つかりません`);
    return null;
  };

  // 担い手と置き場所
  /** ペルソナがあれば置く (上限を超える分は切り詰める。不正なら警告だけ) */
  const addActor = (kind: "actor" | "externalActor", a: SpecActor) => {
    const id = add(kind, "actor", a);
    if (!id || !a.persona || typeof a.persona !== "object") return;
    // 不正な習熟はその項目だけ外して警告する (ペルソナは捨てない)。項目が無いペルソナは黙って飛ばす
    const input = { ...(a.persona as Record<string, unknown>) };
    if (input.it_skill !== undefined && input.it_skill !== "" && !isPersonaItSkill(input.it_skill)) {
      warnings.push(`${a.name} のペルソナ: it_skill「${String(input.it_skill)}」は使えないので外しました`);
      delete input.it_skill;
    }
    const merged = mergePersonaInput(undefined, input);
    if ("error" in merged) return;
    const p = merged.persona;
    const clipped = {
      ...p,
      ...(p.handle !== undefined ? { handle: truncateText(p.handle, NAME_MAX_LENGTH) } : {}),
      ...(p.attributes !== undefined ? { attributes: truncateText(p.attributes, NAME_MAX_LENGTH) } : {}),
      ...(p.background !== undefined ? { background: truncateText(p.background, DESCRIPTION_MAX_LENGTH) } : {}),
      ...(p.goals !== undefined ? { goals: truncateText(p.goals, DESCRIPTION_MAX_LENGTH) } : {}),
      ...(p.notes !== undefined ? { notes: truncateText(p.notes, DESCRIPTION_MAX_LENGTH) } : {}),
    };
    apply(setPersona(model, { id, persona: clipped }), `${a.name} のペルソナを置けません`);
  };
  for (const a of clip(spec.actors, L.actors, "アクター")) addActor("actor", a);
  for (const a of clip(spec.external_actors, L.externalActors, "外部アクター")) addActor("externalActor", a);
  for (const a of clip(spec.systems, L.systems, "システム")) add("system", "actor", a);
  for (const a of clip(spec.ledgers, L.ledgers, "帳票")) add("ledger", "ledger", a);
  // 情報のまわり (操作から参照されるので先に作る)
  for (const c of clip(spec.contexts, L.contexts, "コンテキスト")) add("context", "context", c);
  const ctx = (name: string | undefined) => (name ? ref(["context"], name, "コンテキスト") : null);
  for (const v of clip(spec.variations, L.variations, "バリエーション")) {
    add("variation", "variation", v, { values: clip(v.values, L.valuesPerItem, `バリエーション「${v.name}」の値`), contextId: ctx(v.context) });
  }
  for (const g of clip(spec.state_groups, L.stateGroups, "状態グループ")) {
    for (const st of clip(g.states, L.valuesPerItem, `状態グループ「${g.name}」の状態`)) add("state", "state", st, { group: g.name, contextId: ctx(g.context) });
  }
  const informations = clip(spec.informations, L.informations, "情報");
  const conditions = clip(spec.conditions, L.conditions, "条件");
  for (const i of informations) add("information", "information", i, { contextId: ctx(i.context) });
  for (const c of conditions) add("condition", "condition", c, { contextId: ctx(c.context) });
  for (const i of informations) {
    const id = idOf("information", i.name);
    for (const n of clip(i.related, L.refsPerItem, `情報「${i.name}」の関連する情報`)) relate(id, ref(["information"], n, "関連する情報"));
    for (const n of clip(i.variations, L.refsPerItem, `情報「${i.name}」のバリエーション`)) relate(id, ref(["variation"], n, "バリエーション"));
  }
  for (const c of conditions) {
    const id = idOf("condition", c.name);
    for (const n of clip(c.variations, L.refsPerItem, `条件「${c.name}」のバリエーション`)) relate(id, ref(["variation"], n, "バリエーション"));
    for (const n of clip(c.states, L.refsPerItem, `条件「${c.name}」の状態`)) relate(id, ref(["state"], n, "状態"));
  }

  const nameOfId = (id: string) => model.elements.find((e) => e.id === id)?.name ?? id;
  /** 操作を作り、対象・情報・条件・状態を結ぶ (作業から使う操作も、イベントをきっかけにする操作も同じ) */
  const addUsecase = (u: SpecUsecase, systemTargets: string[] = []): string | null => {
    // すでにある操作 (同じ名前) は上限に数えない
    if (!(typeof u.name === "string" && idOf("usecase", u.name)) && !usecaseBudget.take()) return null;
    const ucId = add("usecase", "usecase", u);
    if (!ucId) return null;
    // 操作の対象は 1 つだけ (0.3.0)。担当に書かれたシステムか、targets の最初の 1 つを結ぶ
    const targets = [...systemTargets.map((id) => ({ id })), ...clip(u.targets, L.refsPerItem, `操作「${u.name}」の対象`).map((n) => ({ name: n }))];
    const [first, ...rest] = targets;
    if (first) {
      const targetId = "id" in first ? first.id : ref(["actor", "ledger"], first.name, "対象");
      const current = targetId ? model.relations.find((r) => r.kind === "usecaseSystem" && r.sourceId === ucId) : undefined;
      if (targetId && current && current.targetId !== targetId) {
        warnings.push(`操作「${nameOfId(ucId)}」の対象はすでに「${nameOfId(current.targetId)}」なので「${nameOfId(targetId)}」は結びませんでした`);
      } else relate(ucId, targetId);
    }
    if (rest.length > 0) warnings.push(`操作「${u.name}」の対象は 1 つだけなので、2 つ目からは結びませんでした`);
    for (const n of clip(u.informations, L.refsPerItem, `操作「${u.name}」の情報`)) relate(ucId, ref(["information"], n, "情報"));
    for (const n of clip(u.reads, L.refsPerItem, `操作「${u.name}」の取得する情報`)) relate(ucId, ref(["information"], n, "情報"), "read");
    for (const n of clip(u.writes, L.refsPerItem, `操作「${u.name}」の保存する情報`)) relate(ucId, ref(["information"], n, "情報"), "write");
    for (const n of clip(u.conditions, L.refsPerItem, `操作「${u.name}」の条件`)) relate(ucId, ref(["condition"], n, "条件"));
    for (const n of clip(u.from_states, L.refsPerItem, `操作「${u.name}」の実行できる状態`)) relate(ref(["state"], n, "状態"), ucId);
    for (const n of clip(u.to_states, L.refsPerItem, `操作「${u.name}」の実行後の状態`)) relate(ucId, ref(["state"], n, "状態"));
    return ucId;
  };

  // 業務 → 活動 → 作業 → 操作
  // 起点の作業は後ろの作業を指してもよいので、全部作ってから結ぶ
  const pendingTriggers: { id: string; spec: SpecActivity }[] = [];
  const addActivity = (a: SpecActivity, bucId: string) => {
    if (!(typeof a.name === "string" && idOf(`activity:${bucId}`, a.name)) && !activityBudget.take()) return;
    const id = add("activity", `activity:${bucId}`, a, { bucId });
    if (!id) return;
    if (a.trigger_activities?.length || a.trigger_events?.length || a.trigger_note?.trim()) pendingTriggers.push({ id, spec: a });
    // システムは作業の担当にならない (0.2.0)。担当に書かれたシステムは、その作業の操作の対象にする
    const systemTargets: string[] = [];
    for (const n of clip(a.performers, L.refsPerItem, `作業「${a.name}」の担当`)) {
      const performer = ref(["actor"], n, "担当");
      if (performer && model.elements.find((e) => e.id === performer)?.kind === "system") systemTargets.push(performer);
      else relate(performer, id);
    }
    for (const u of Array.isArray(a.usecases) ? a.usecases : []) {
      const ucId = addUsecase(u, systemTargets);
      relate(id, ucId);
    }
  };
  for (const b of clip(spec.businesses, L.businesses, "業務")) {
    const bizId = add("business", "business", b);
    if (!bizId) continue;
    for (const n of clip(b.main_actors, L.refsPerItem, `業務「${b.name}」の主担当`)) {
      const actorId = ref(["actor"], n, "主担当");
      if (actorId && model.elements.find((e) => e.id === actorId)?.kind === "actor") relate(actorId, bizId);
      else if (actorId) warnings.push(`主担当「${n}」はアクターではないので結べません`);
    }
    const def = defaultBucOf(model, bizId);
    if (def) for (const a of Array.isArray(b.activities) ? b.activities : []) addActivity(a, def.id);
    for (const buc of clip(b.bucs, L.bucsPerBusiness, `業務「${b.name}」の活動`)) {
      const bucId = add("buc", `buc:${bizId}`, buc, { businessId: bizId });
      if (bucId) for (const a of Array.isArray(buc.activities) ? buc.activities : []) addActivity(a, bucId);
    }
  }

  // イベント (作業のあとに作る。操作は作業から使われるものも、イベントをきっかけにするものもある)
  // 起こすもの (操作) はほかのイベントの下で定義されていてもよいので、全部作ってから結ぶ
  const pendingEvents: { id: string; spec: SpecEvent }[] = [];
  for (const ev of clip(spec.events, L.events, "イベント")) {
    const id = add("event", "event", ev, { contextId: ctx(ev.context) });
    if (!id) continue;
    pendingEvents.push({ id, spec: ev });
    for (const u of Array.isArray(ev.usecases) ? ev.usecases : []) relate(id, addUsecase(u));
  }
  // 名前 → 要素 (種類ごと。最初のもの)。要素を足し終えた段階で作り直す
  const indexOf = (kind: ElementKind): Map<string, Element> => {
    const m = new Map<string, Element>();
    for (const e of model.elements) if (e.kind === kind && !m.has(e.name)) m.set(e.name, e);
    return m;
  };
  const findByName = (kind: ElementKind, name: string) => model.elements.find((e) => e.kind === kind && e.name === nameOf(name));
  const systemIndex = indexOf("system");
  const usecaseIndex = indexOf("usecase");
  for (const { id, spec: ev } of pendingEvents) {
    let origins = 0;
    for (const n of clip(ev.raised_by, L.refsPerItem, `イベント「${ev.name}」を起こすもの`)) {
      const origin = systemIndex.get(nameOf(n)) ?? usecaseIndex.get(nameOf(n));
      if (!origin) warnings.push(`イベント「${ev.name}」を起こすもの「${n}」が見つかりません (システムか操作の名前にしてください)`);
      else {
        relate(origin.id, id);
        origins++;
      }
    }
    if (origins === 0) warnings.push(`イベント「${ev.name}」を起こすシステムか操作がありません`);
  }

  // 画面 (分析の画面)。1 つの画面を使う操作は 1 つだけ、1 つの操作の対象はシステム・帳票・画面のどれか 1 つ
  const systems = [...systemIndex.values()];
  /** 操作 → 今の対象 (システム・帳票)。画面を結ぶと対象は画面に替わるので、この段階の最初の状態を覚えておく */
  const targetOfUsecase = new Map<string, Element>();
  {
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    for (const r of model.relations) {
      if (r.kind !== "usecaseSystem") continue;
      const t = byId.get(r.targetId);
      if (t) targetOfUsecase.set(r.sourceId, t);
    }
  }
  /** 画面 (分析の要素の id) → 使う操作の id と、操作 → 画面。結んだものだけを覚える (画面はこの段階で初めて結ぶ) */
  const usecaseOfScreen = new Map<string, string>();
  const screenOfUsecase = new Map<string, string>();
  for (const sc of clip(spec.screens, L.screens, "画面")) {
    const name = typeof sc.name === "string" ? nameOf(sc.name) : "";
    if (!name) {
      nameless.set("screen", (nameless.get("screen") ?? 0) + 1);
      continue;
    }
    const usecase = sc.usecase ? usecaseIndex.get(nameOf(sc.usecase)) : undefined;
    if (sc.usecase && !usecase) warnings.push(`画面「${name}」を使う操作「${sc.usecase}」が見つかりません`);
    // 属するシステム: 書いてあればそれ、無ければシステムが 1 つだけのときのそのシステム
    let system = sc.system ? systemIndex.get(nameOf(sc.system)) : systems.length === 1 ? systems[0] : undefined;
    if (!system && sc.system) warnings.push(`画面「${name}」の属するシステム「${sc.system}」が見つかりません`);
    // 操作がシステムを対象にしていれば、そのシステムに合わせる (画面を使うと対象は画面に替わる)
    const target = usecase ? targetOfUsecase.get(usecase.id) : undefined;
    if (!system && target?.kind === "system") system = target;
    if (!system) {
      warnings.push(`画面「${name}」は属するシステムが決まらないので作りませんでした`);
      continue;
    }
    const screenId = add("screen", `screen:${system.id}`, sc, { systemId: system.id });
    if (!screenId || !usecase) continue;
    const userOfScreen = usecaseOfScreen.get(screenId);
    // すでに同じ組で結んでいれば、黙って飛ばす (同じ下書きを 2 回書かれても警告にしない)
    if (userOfScreen === usecase.id) continue;
    if (userOfScreen !== undefined) {
      warnings.push(`画面「${name}」はすでに別の操作が使っているので、操作「${usecase.name}」とは結びませんでした (1 つの画面を使う操作は 1 つだけ)`);
      continue;
    }
    if (screenOfUsecase.has(usecase.id)) {
      warnings.push(`操作「${usecase.name}」はすでに別の画面を使っているので、画面「${name}」とは結びませんでした (1 つの操作が使う画面は 1 つだけ)`);
      continue;
    }
    if (target?.kind === "ledger") {
      warnings.push(`操作「${usecase.name}」は帳票を対象にしているので、画面「${name}」とは結びませんでした (1 つの操作の対象は 1 つだけ)`);
      continue;
    }
    if (target?.kind === "system" && target.id !== system.id) {
      warnings.push(`操作「${usecase.name}」の対象はシステム「${target.name}」なので、システム「${system.name}」の画面「${name}」とは結びませんでした (画面の属するシステムを合わせてください)`);
      continue;
    }
    if (apply(setScreenUsecase(model, { screenId, usecaseId: usecase.id }), `画面「${name}」を操作「${usecase.name}」に結べません`)) {
      usecaseOfScreen.set(screenId, usecase.id);
      screenOfUsecase.set(usecase.id, screenId);
    }
  }

  // 作業の起点 (作業・イベント・その他)
  for (const { id, spec: a } of pendingTriggers) {
    for (const n of clip(a.trigger_activities, L.refsPerItem, `作業「${a.name}」の起点の作業`)) {
      const same = model.elements.filter((e) => e.kind === "activity" && e.name === nameOf(n));
      const others = same.filter((e) => e.id !== id);
      if (same.length === 0) warnings.push(`起点の作業「${n}」が見つかりません`);
      else if (others.length === 0) warnings.push(`作業「${a.name}」は自分自身を起点にできないので、起点「${n}」は結びませんでした`);
      else {
        if (others.length > 1) warnings.push(`起点の作業「${n}」と同じ名前の作業が ${others.length} つあるので、最初の 1 つを結びました`);
        relate(others[0]!.id, id);
      }
    }
    for (const n of clip(a.trigger_events, L.refsPerItem, `作業「${a.name}」の起点のイベント`)) {
      const ev = findByName("event", n);
      if (ev) relate(ev.id, id);
      else warnings.push(`起点のイベント「${n}」が見つかりません`);
    }
    const note = a.trigger_note?.trim();
    if (note) apply(updateElement(model, { id, patch: { triggerNote: truncateText(note, TRIGGER_NOTE_MAX_LENGTH) } }), `作業「${a.name}」の起点を書けません`);
  }

  // 課題
  for (const issue of clip(spec.issues, L.issues, "課題")) {
    const found = clip(issue.targets, L.refsPerItem, `課題「${issue.name}」の対象`)
      .map((n) => model.elements.find((e) => isIssueTargetKind(e.kind) && e.name === nameOf(n)))
      .filter((e): e is Element => !!e);
    // 全体的な課題 (登場人物) と具体的な課題 (業務・作業・操作) は混ぜられないので、最初の対象と同じ区分だけを残す
    const scope = found[0] && isIssueTargetKind(found[0].kind) ? issueScopeOfKind(found[0].kind) : null;
    const targets = found.filter((e) => isIssueTargetKind(e.kind) && issueScopeOfKind(e.kind) === scope).map((e) => e.id);
    apply(
      addElement(model, {
        kind: "issue",
        name: nameOf(issue.name),
        init: {
          severity: Math.min(5, Math.max(1, Math.round(issue.severity ?? 3))),
          targetIds: targets,
          ...(issue.description ? { description: truncateText(issue.description, DESCRIPTION_MAX_LENGTH) } : {}),
        },
      }),
      `課題「${issue.name}」を作れません`,
    );
  }

  activityBudget.report();
  usecaseBudget.report();
  for (const [kind, n] of nameless) warnings.push(`名前の無い${ELEMENT_KIND_LABELS[kind]}を ${n} 件飛ばしました`);

  const counts: BuildResult["counts"] = {};
  for (const e of model.elements) {
    if (e.kind === "buc" && e.isDefault) continue;
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return { model, warnings: [...new Set(warnings)], counts };
}
