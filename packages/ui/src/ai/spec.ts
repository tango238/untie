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
  targets: names("操作の対象のシステム・帳票・画面の名前 (systems / ledgers / screens に定義したもの)。1 つだけ。画面を通す操作は、画面の名前を書いてもよい (screens の usecase に操作を書くのと同じ意味)。情報の置き場所 (取得元・保存先) は、対象と扱う情報 (informations / reads / writes) から導く"),
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
          usecase: { type: "string", description: "この画面を使う操作の名前。1 つだけ。操作の対象はこの画面になる (その操作に別のシステム・帳票を対象にしない)。操作の targets に画面の名前を書いても同じ意味になる。複数の操作が同じ画面を使うなら、操作ごとに画面を分ける" },
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
 * 名前の突き合わせの鍵: NFKC (全角の英数字・カナ・空白を半角へ)・小文字・空白 (全角・半角) の削除。「ＥＣ サイト」と「EC サイト」、「注文 一覧」と「注文一覧」が同じ鍵になる。
 * 突き合わせにだけ使い、表示と保存はもとの名前のまま (土台の名前を書き換えない)
 */
export const nameKey = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

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
  /** できあがったモデルにある要素の数 (土台があれば、土台の分も含む) */
  counts: Partial<Record<ElementKind, number>>;
  /** このとき新しく足した要素の数 (土台が無ければ counts と同じ) */
  added: Partial<Record<ElementKind, number>>;
}

export interface BuildOptions {
  /**
   * 土台のモデル。あれば、空のモデルからではなく、これに足す (「ソースコードから作成」の業務の段階)。
   * 下書きの名前が土台の要素 (同じ種類・同じ名前。画面は同じシステムの同じ名前、作業は同じ活動の同じ名前、活動は同じ業務の同じ名前) を指すなら、
   * 作り直さずにそれを使い、無いものだけ足す。土台の要素の名前・説明・ペルソナ・起点の書き込み・主担当は書き換えない。
   * モデルの名前と、課題の同じ名前 (すでにあるもの) も変えない
   */
  base?: UntieModel;
}

/** 下書きをモデルに組み立てる。参照先の名前が無ければ、その参照を飛ばして warnings に残す。options.base があれば、それに足す */
export function buildModelFromSpec(spec: ModelSpec, options: BuildOptions = {}): BuildResult {
  const base = options.base;
  let model = base ?? emptyModel(nameOf(spec.system_name || "") || "新しいモデル");
  if (spec.overview && (!base || !base.meta.description?.trim())) model = { ...model, meta: { ...model.meta, description: truncateText(spec.overview, DESCRIPTION_MAX_LENGTH) } };
  /** 土台にあった要素の id (土台が無ければ空) */
  const baseIds = new Set<string>(base ? base.elements.map((e) => e.id) : []);
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
  const idOf = (group: string, name: string) => ids.get(group)?.get(nameKey(nameOf(name)));

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
    ids.get(group)!.set(nameKey(name), r.id);
    kindById.set(r.id, kind);
    return r.id;
  };
  /** 要素の id → 種類、関係の (種類・両端) → 関係の id。関係を作るたびに全部を調べ直さないための索引 (向きを持たない関係は、両端の順を無視する) */
  const kindById = new Map<string, ElementKind>();
  const relationByKey = new Map<string, string>();
  const relationKey = (kind: string, a: string, b: string) => (isUndirected(kind as never) && a > b ? `${kind}:${b}:${a}` : `${kind}:${a}:${b}`);
  // 土台の要素と関係を、名前の突き合わせと重複の検査に使えるようにする (同じ名前が複数あれば最初のもの)
  /** 土台の操作 (名前の鍵 → id)。同じ名前でも、この下書きの同じ作業・同じ画面のものだけを同じ操作とみなすので、名前だけの一覧には入れない */
  const baseUsecasesByKey = new Map<string, string[]>();
  /** 土台の画面 (名前の鍵 → 画面)。下書きの画面・操作の対象の名前が、土台の画面を指せるように */
  const baseScreensByKey = new Map<string, Extract<Element, { kind: "screen" }>[]>();
  if (base) {
    const put = (group: string, name: string, id: string) => {
      const m = ids.get(group) ?? new Map<string, string>();
      ids.set(group, m);
      const key = nameKey(name);
      if (!m.has(key)) m.set(key, id);
    };
    for (const e of base.elements) {
      kindById.set(e.id, e.kind);
      switch (e.kind) {
        case "actor":
        case "externalActor":
          put("actor", e.name, e.id);
          break;
        case "system":
          // システムは人と別の名前の一覧 (同じ名前のアクターがいても、取り違えない)
          put("system", e.name, e.id);
          break;
        case "activity":
          put(`activity:${e.bucId}`, e.name, e.id);
          break;
        case "buc":
          if (!e.isDefault) put(`buc:${e.businessId}`, e.name, e.id);
          break;
        case "screen":
          put(`screen:${e.systemId}`, e.name, e.id);
          baseScreensByKey.set(nameKey(e.name), [...(baseScreensByKey.get(nameKey(e.name)) ?? []), e]);
          break;
        case "usecase":
          baseUsecasesByKey.set(nameKey(e.name), [...(baseUsecasesByKey.get(nameKey(e.name)) ?? []), e.id]);
          break;
        case "state":
          // 状態は、状態のまとまり (グループ) と名前の組で突き合わせる。名前だけで引くときの控えは、別の一覧に置く
          put(`state:${nameKey(e.group ?? "")}`, e.name, e.id);
          put("stateAny", e.name, e.id);
          break;
        case "ledger":
        case "business":
        case "event":
        case "context":
        case "variation":
        case "information":
        case "condition":
          put(e.kind, e.name, e.id);
          break;
        default:
          break;
      }
    }
    for (const r of base.relations) relationByKey.set(relationKey(r.kind, r.sourceId, r.targetId), r.id);
  }
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
    // 土台にいる人のペルソナは、すでにあれば書き換えない
    if (baseIds.has(id) && (model.elements.find((e) => e.id === id) as { persona?: unknown } | undefined)?.persona) return;
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
  for (const a of clip(spec.systems, L.systems, "システム")) add("system", "system", a);
  for (const a of clip(spec.ledgers, L.ledgers, "帳票")) add("ledger", "ledger", a);
  // 情報のまわり (操作から参照されるので先に作る)
  for (const c of clip(spec.contexts, L.contexts, "コンテキスト")) add("context", "context", c);
  const ctx = (name: string | undefined) => (name ? ref(["context"], name, "コンテキスト") : null);
  for (const v of clip(spec.variations, L.variations, "バリエーション")) {
    add("variation", "variation", v, { values: clip(v.values, L.valuesPerItem, `バリエーション「${v.name}」の値`), contextId: ctx(v.context) });
  }
  for (const g of clip(spec.state_groups, L.stateGroups, "状態グループ")) {
    for (const st of clip(g.states, L.valuesPerItem, `状態グループ「${g.name}」の状態`)) {
      // 状態は、グループと名前の組で突き合わせる (別のグループの同じ名前の状態は、別の状態)。名前だけで引く参照 (from_states など) のために、最初の 1 つを控える
      const id = add("state", `state:${nameKey(typeof g.name === "string" ? nameOf(g.name) : "")}`, st, { group: g.name, contextId: ctx(g.context) });
      if (id && typeof st.name === "string") {
        const any = ids.get("state") ?? new Map<string, string>();
        ids.set("state", any);
        if (!any.has(nameKey(nameOf(st.name)))) any.set(nameKey(nameOf(st.name)), id);
      }
    }
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
    for (const n of clip(c.states, L.refsPerItem, `条件「${c.name}」の状態`)) relate(id, ref(["state", "stateAny"], n, "状態"));
  }

  const nameOfId = (id: string) => model.elements.find((e) => e.id === id)?.name ?? id;
  /** 画面の名前 (spec.screens)。操作の targets にこの名前が書かれたら、その画面を使う操作として画面の段階で結ぶ (screens[].usecase と同じ扱い) */
  // 上限で切られる画面 (先頭 SPEC_LIMITS.screens 件のあと) は含めない。切られた画面を指す targets は、「対象が見つかりません」の警告になる
  const specScreens = clip(spec.screens, L.screens, "画面").filter((sc) => sc && typeof sc === "object");
  /** targets に書いてよい画面の名前の鍵: 下書きの画面と、土台にすでにある画面 */
  const specScreenKeys = new Set([...specScreens.flatMap((sc) => (typeof sc.name === "string" && nameOf(sc.name) ? [nameKey(nameOf(sc.name))] : [])), ...baseScreensByKey.keys()]);
  /** 画面の名前の鍵 → targets にその名前を書いた操作の id */
  const usecasesNamingScreen = new Map<string, string[]>();
  /** 画面の段階で、targets の画面の名前から結びにいった操作の id (結べたかは別。ここに無いものは、画面が作られなかったなどで結びにいけなかった) */
  const namedAttempted = new Set<string>();
  /** 土台の画面を使っている土台の操作の id (画面の id → 操作の id) */
  const baseUserOfScreen = new Map<string, string>();
  if (base) {
    const kindOfBase = new Map(base.elements.map((e) => [e.id, e.kind]));
    for (const r of base.relations) if (r.kind === "usecaseScreen" && kindOfBase.get(r.targetId) === "screen") baseUserOfScreen.set(r.targetId, r.sourceId);
  }
  /** 土台の操作のうち、この下書きの画面が「同じ操作を使う」と宣言しているもの (土台の同じ名前の画面を使う、同じ名前の操作)。同じ画面を使うので、同じ操作とみなす */
  const sameByScreen = new Set<string>();
  for (const sc of specScreens) {
    if (typeof sc.name !== "string" || typeof sc.usecase !== "string") continue;
    for (const screen of baseScreensByKey.get(nameKey(nameOf(sc.name))) ?? []) {
      const user = baseUserOfScreen.get(screen.id);
      if (user && baseUsecasesByKey.get(nameKey(nameOf(sc.usecase)))?.includes(user)) sameByScreen.add(user);
    }
  }
  /** 土台の操作が、この下書きの操作と同じものか: この下書きの同じ作業 (同じ業務・活動の同じ名前の作業) に属する、同じイベントをきっかけにする、または同じ画面を使う */
  const isSameUsecase = (baseId: string, u: SpecUsecase, scope: { activityId?: string; eventId?: string }): boolean => {
    if (scope.activityId && model.relations.some((r) => r.kind === "activityUsecase" && r.sourceId === scope.activityId && r.targetId === baseId)) return true;
    if (scope.eventId && model.relations.some((r) => r.kind === "eventUsecase" && r.sourceId === scope.eventId && r.targetId === baseId)) return true;
    if (sameByScreen.has(baseId)) return true;
    return (Array.isArray(u.targets) ? u.targets : []).some((n) => typeof n === "string" && (baseScreensByKey.get(nameKey(nameOf(n))) ?? []).some((screen) => baseUserOfScreen.get(screen.id) === baseId));
  };
  /** 操作を作り、対象・情報・条件・状態を結ぶ (作業から使う操作も、イベントをきっかけにする操作も同じ) */
  const addUsecase = (u: SpecUsecase, systemTargets: string[] = [], scope: { activityId?: string; eventId?: string } = {}): string | null => {
    // この下書きがすでに作った (または土台から引いた) 同じ名前の操作は、同じもの
    let ucId: string | null = typeof u.name === "string" ? (idOf("usecase", u.name) ?? null) : null;
    if (!ucId && typeof u.name === "string" && nameOf(u.name)) {
      const candidates = baseUsecasesByKey.get(nameKey(nameOf(u.name))) ?? [];
      const same = candidates.find((id) => isSameUsecase(id, u, scope));
      if (same) {
        // 土台の同じ操作を使う (上限には数えない)。この下書きの中で同じ名前が出たら、これに合流する
        const m = ids.get("usecase") ?? new Map<string, string>();
        ids.set("usecase", m);
        m.set(nameKey(nameOf(u.name)), same);
        ucId = same;
      } else {
        if (!usecaseBudget.take()) return null;
        ucId = add("usecase", "usecase", u);
        if (ucId && candidates.length > 0) {
          warnings.push(`操作「${nameOf(u.name)}」は、土台にも同じ名前の操作がありますが、別の作業・別の画面のものなので、別の操作として作りました (名前が重なります。業務が分かる具体的な名前にしてください)`);
        }
      }
    } else if (!ucId) {
      if (!usecaseBudget.take()) return null;
      ucId = add("usecase", "usecase", u);
    }
    if (!ucId) return null;
    // 操作の対象は 1 つだけ (0.3.0)。担当に書かれたシステムか、targets の最初の 1 つを結ぶ
    const written = clip(u.targets, L.refsPerItem, `操作「${u.name}」の対象`).filter((n) => {
      // システム・帳票の名前ではなく、画面の名前なら、画面の段階でその画面を使う操作として結ぶ
      const screenName = typeof n === "string" ? nameOf(n) : "";
      if (!screenName || idOf("system", screenName) || idOf("ledger", screenName) || !specScreenKeys.has(nameKey(screenName))) return true;
      const list = usecasesNamingScreen.get(nameKey(screenName)) ?? [];
      if (!list.includes(ucId!)) list.push(ucId!);
      usecasesNamingScreen.set(nameKey(screenName), list);
      return false;
    });
    const targets = [...systemTargets.map((id) => ({ id })), ...written.map((n) => ({ name: n }))];
    const [first, ...rest] = targets;
    if (first) {
      // 操作の対象は、システム・帳票から探す (同じ名前の人がいても、人には向けない)
      const targetId = "id" in first ? first.id : ref(["system", "ledger"], first.name, "対象");
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
    for (const n of clip(u.from_states, L.refsPerItem, `操作「${u.name}」の実行できる状態`)) relate(ref(["state", "stateAny"], n, "状態"), ucId);
    for (const n of clip(u.to_states, L.refsPerItem, `操作「${u.name}」の実行後の状態`)) relate(ucId, ref(["state", "stateAny"], n, "状態"));
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
      // 作業の担当は人から探す (同じ名前のシステムがあっても、人を先に。人がいなければ、システムを操作の対象にする)
      const performer = ref(["actor", "system"], n, "担当");
      if (performer && model.elements.find((e) => e.id === performer)?.kind === "system") systemTargets.push(performer);
      else relate(performer, id);
    }
    for (const u of Array.isArray(a.usecases) ? a.usecases : []) {
      const ucId = addUsecase(u, systemTargets, { activityId: id });
      relate(id, ucId);
    }
  };
  for (const b of clip(spec.businesses, L.businesses, "業務")) {
    const bizId = add("business", "business", b);
    if (!bizId) continue;
    // 土台にある業務で、主担当がもういるなら、足さない (1 つの業務に結ぶアクターは主担当の 1 人)
    const keepMainActors = baseIds.has(bizId) && model.relations.some((r) => r.kind === "actorBusiness" && r.targetId === bizId);
    for (const n of keepMainActors ? [] : clip(b.main_actors, L.refsPerItem, `業務「${b.name}」の主担当`)) {
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
    for (const u of Array.isArray(ev.usecases) ? ev.usecases : []) relate(id, addUsecase(u, [], { eventId: id }));
  }
  // 名前 → 要素 (種類ごと。最初のもの)。要素を足し終えた段階で作り直す
  // 名前の鍵 → 要素。この下書きで足した要素を先に探す (土台の同じ名前の要素より前)
  const indexOf = (kind: ElementKind): Map<string, Element> => {
    const m = new Map<string, Element>();
    for (const fromBase of [false, true]) for (const e of model.elements) if (e.kind === kind && baseIds.has(e.id) === fromBase && !m.has(nameKey(e.name))) m.set(nameKey(e.name), e);
    return m;
  };
  const findByName = (kind: ElementKind, name: string) => indexOf(kind).get(nameKey(nameOf(name)));
  const systemIndex = indexOf("system");
  const usecaseIndex = indexOf("usecase");
  for (const { id, spec: ev } of pendingEvents) {
    let origins = 0;
    for (const n of clip(ev.raised_by, L.refsPerItem, `イベント「${ev.name}」を起こすもの`)) {
      const origin = systemIndex.get(nameKey(nameOf(n))) ?? usecaseIndex.get(nameKey(nameOf(n)));
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
  /** 土台にその名前の画面があり、それがただ 1 つのシステムのものなら、そのシステム (下書きに system が無く、システムが 2 つ以上あるときの手がかり) */
  const baseOwnerOfScreen = (name: string): Element | undefined => {
    const owners = new Map<string, Element>();
    for (const screen of baseScreensByKey.get(nameKey(name)) ?? []) {
      const owner = model.elements.find((e) => e.id === screen.systemId && e.kind === "system");
      if (owner) owners.set(owner.id, owner);
    }
    return owners.size === 1 ? [...owners.values()][0] : undefined;
  };
  /** 下書きに書いていない画面: targets に名前だけ書かれた、土台の画面 (土台の画面を使う操作として結ぶため、下書きの画面と同じ扱いで流す) */
  const declaredScreenKeys = new Set(specScreens.flatMap((sc) => (typeof sc.name === "string" && nameOf(sc.name) ? [nameKey(nameOf(sc.name))] : [])));
  const targetOnlyScreens: SpecScreen[] = [];
  for (const key of usecasesNamingScreen.keys()) {
    if (declaredScreenKeys.has(key)) continue;
    for (const screen of baseScreensByKey.get(key) ?? []) {
      const owner = model.elements.find((e) => e.id === screen.systemId && e.kind === "system");
      if (owner) targetOnlyScreens.push({ name: screen.name, system: owner.name });
    }
  }
  const screenList: SpecScreen[] = [...specScreens, ...targetOnlyScreens];
  /**
   * 画面の宣言 (名前・属するシステム・使う操作) を、画面を作る前に解決する。作られない画面 (名前が無い・属するシステムが見つからない・
   * 属するシステムが決まらない) は含めない。属するシステムは、書いてあればそれ、無ければシステムが 1 つだけのときのそのシステム、
   * それも無ければ土台にあるその名前の画面のシステム (1 つだけのとき)、それも無ければ宣言した操作の対象のシステム
   */
  const resolvedScreens: { key: string; systemKey: string; declaredId?: string }[] = [];
  for (const sc of screenList) {
    const name = typeof sc?.name === "string" ? nameOf(sc.name) : "";
    if (!name) continue;
    const declaredUc = typeof sc.usecase === "string" && nameOf(sc.usecase) ? usecaseIndex.get(nameKey(nameOf(sc.usecase))) : undefined;
    const explicit = typeof sc.system === "string" && sc.system ? systemIndex.get(nameKey(nameOf(sc.system))) : undefined;
    // 書かれたシステムが見つからない画面は作られない
    if (typeof sc.system === "string" && sc.system && !explicit) continue;
    const declaredTarget = declaredUc ? targetOfUsecase.get(declaredUc.id) : undefined;
    const system = explicit ?? (systems.length === 1 ? systems[0] : undefined) ?? baseOwnerOfScreen(name) ?? (declaredTarget?.kind === "system" ? declaredTarget : undefined);
    // システムが決まらない画面は、宣言した操作が無ければ、名前を書いた操作の対象から決まることがある (そのため、宣言には数えず、同じ名前の判定では 1 つのシステム扱いにする)
    resolvedScreens.push({ key: nameKey(name), systemKey: system?.id ?? "", ...(declaredUc && system ? { declaredId: declaredUc.id } : {}) });
  }
  /** 同じ名前の画面が、別のシステムにも (または、システムが決まらないまま) 複数あるときの名前の鍵。targets の名前だけでは、どの画面か決められない。同じシステムの同じ名前は 1 つの画面 */
  const ambiguousScreenNames = new Set<string>();
  {
    const systemsByName = new Map<string, Set<string>>();
    for (const r of resolvedScreens) {
      const set = systemsByName.get(r.key) ?? new Set<string>();
      set.add(r.systemKey);
      systemsByName.set(r.key, set);
    }
    for (const [n, set] of systemsByName) if (set.size > 1) ambiguousScreenNames.add(n);
  }
  /** 作られる画面が screens[].usecase で宣言した操作の id → 宣言した画面の名前の鍵 (宣言が勝つ。targets に別の画面の名前があっても、そちらには結ばない) */
  const declaredScreensOfUsecase = new Map<string, Set<string>>();
  for (const r of resolvedScreens) {
    if (r.declaredId === undefined) continue;
    const set = declaredScreensOfUsecase.get(r.declaredId) ?? new Set<string>();
    set.add(r.key);
    declaredScreensOfUsecase.set(r.declaredId, set);
  }
  const declaredUsecaseIds = new Set(declaredScreensOfUsecase.keys());
  /** 画面 (分析の要素の id) → 使う操作の id と、操作 → 画面。結んだものだけを覚える (画面はこの段階で初めて結ぶ) */
  const usecaseOfScreen = new Map<string, string>();
  const screenOfUsecase = new Map<string, string>();
  // 土台で、すでに画面を使っている操作 (画面 → 操作と操作 → 画面。同じ組を結び直さず、別の組は断る)
  for (const [screenId, usecaseId] of baseUserOfScreen) {
    usecaseOfScreen.set(screenId, usecaseId);
    screenOfUsecase.set(usecaseId, screenId);
  }
  for (const sc of screenList) {
    const name = typeof sc.name === "string" ? nameOf(sc.name) : "";
    if (!name) {
      nameless.set("screen", (nameless.get("screen") ?? 0) + 1);
      continue;
    }
    const declared = sc.usecase ? usecaseIndex.get(nameKey(nameOf(sc.usecase))) : undefined;
    if (sc.usecase && !declared) warnings.push(`画面「${name}」を使う操作「${sc.usecase}」が見つかりません`);
    // 操作の targets に画面の名前を書いたものも、screens の usecase と同じ扱いで、その画面を使う操作にする
    // 属するシステム: 書いてあればそれ、無ければシステムが 1 つだけのときのそのシステム、それも無ければ土台にあるその名前の画面のシステム (1 つだけのとき)
    let system = sc.system ? systemIndex.get(nameKey(nameOf(sc.system))) : (systems.length === 1 ? systems[0] : undefined) ?? baseOwnerOfScreen(name);
    if (!system && sc.system) warnings.push(`画面「${name}」の属するシステム「${sc.system}」が見つかりません`);
    // targets に名前を書いた操作: どこかの画面が screens[].usecase で宣言した操作には結ばない (宣言が勝つ)。同じ名前の画面が複数あるときは、
    // 操作の対象のシステムが、この画面のシステムと同じものだけ結ぶ (それで 1 つに決まる。決まらないものは、最後に 1 件だけ警告する)
    const named: Element[] = [];
    for (const id of usecasesNamingScreen.get(nameKey(name)) ?? []) {
      const u = model.elements.find((e) => e.id === id);
      if (!u || declaredUsecaseIds.has(u.id)) continue;
      if (ambiguousScreenNames.has(nameKey(name))) {
        const t = targetOfUsecase.get(u.id);
        if (!(t?.kind === "system" && system && t.id === system.id)) continue;
      }
      named.push(u);
    }
    const usecases: Element[] = [];
    for (const u of [declared, ...named]) {
      if (u && !usecases.some((x) => x.id === u.id)) usecases.push(u);
    }
    const usecase = usecases[0];
    // 操作がシステムを対象にしていれば、そのシステムに合わせる (画面を使うと対象は画面に替わる)
    const firstTarget = usecase ? targetOfUsecase.get(usecase.id) : undefined;
    if (!system && firstTarget?.kind === "system") system = firstTarget;
    if (!system) {
      warnings.push(`画面「${name}」は属するシステムが決まらないので作りませんでした`);
      continue;
    }
    const screenId = add("screen", `screen:${system.id}`, sc, { systemId: system.id });
    if (!screenId) continue;
    for (const u of named) namedAttempted.add(u.id);
    for (const uc of usecases) {
      const target = targetOfUsecase.get(uc.id);
      const userOfScreen = usecaseOfScreen.get(screenId);
      // すでに同じ組で結んでいれば、黙って飛ばす (同じ下書きを 2 回書かれても警告にしない)
      if (userOfScreen === uc.id) continue;
      if (userOfScreen !== undefined) {
        warnings.push(`画面「${name}」はすでに別の操作が使っているので、操作「${uc.name}」とは結びませんでした (1 つの画面を使う操作は 1 つだけ)`);
        continue;
      }
      if (screenOfUsecase.has(uc.id)) {
        warnings.push(`操作「${uc.name}」はすでに別の画面を使っているので、画面「${name}」とは結びませんでした (1 つの操作が使う画面は 1 つだけ)`);
        continue;
      }
      if (target?.kind === "ledger") {
        warnings.push(`操作「${uc.name}」は帳票を対象にしているので、画面「${name}」とは結びませんでした (1 つの操作の対象は 1 つだけ)`);
        continue;
      }
      if (target?.kind === "system" && target.id !== system.id) {
        warnings.push(`操作「${uc.name}」の対象はシステム「${target.name}」なので、システム「${system.name}」の画面「${name}」とは結びませんでした (画面の属するシステムを合わせてください)`);
        continue;
      }
      if (apply(setScreenUsecase(model, { screenId, usecaseId: uc.id }), `画面「${name}」を操作「${uc.name}」に結べません`)) {
        usecaseOfScreen.set(screenId, uc.id);
        screenOfUsecase.set(uc.id, screenId);
      }
    }
  }

  // targets に画面の名前を書いたのに、その画面に結べなかった操作 (画面が作られなかった・同じ名前の画面が複数あって決められなかった)
  for (const [screenKey, ucIds] of usecasesNamingScreen) {
    const screenName = specScreens.find((sc) => typeof sc.name === "string" && nameKey(nameOf(sc.name)) === screenKey)?.name ?? baseScreensByKey.get(screenKey)?.[0]?.name ?? screenKey;
    // 宣言のある操作の targets がほかの画面を指していたら、宣言を優先したことを知らせる
    for (const id of ucIds) {
      const u = model.elements.find((e) => e.id === id);
      const declaredBy = u ? declaredScreensOfUsecase.get(u.id) : undefined;
      if (u && declaredBy && !declaredBy.has(screenKey)) {
        const names = [...declaredBy].map((k) => specScreens.find((sc) => typeof sc.name === "string" && nameKey(nameOf(sc.name)) === k)?.name ?? baseScreensByKey.get(k)?.[0]?.name ?? k);
        warnings.push(
          `操作「${u.name}」の targets の画面「${nameOf(screenName)}」は結びませんでした (画面${names.map((n) => `「${nameOf(n)}」`).join("")}が screens[].usecase でこの操作を使うと宣言しているため。1 つの操作が使う画面は 1 つだけ)`,
        );
      }
    }
    const left = ucIds.map((id) => model.elements.find((e) => e.id === id)).filter((u): u is Element => !!u && !declaredUsecaseIds.has(u.id) && !namedAttempted.has(u.id));
    if (left.length === 0) continue;
    if (ambiguousScreenNames.has(screenKey)) {
      warnings.push(`画面「${nameOf(screenName)}」は同じ名前の画面が複数あるので、操作 (${left.map((u) => `「${u.name}」`).join("")}) の targets からは結べません。screens[].usecase で書いてください`);
    } else {
      for (const u of left) warnings.push(`操作「${u.name}」の対象「${nameOf(screenName)}」が見つかりません (その画面は作られませんでした)`);
    }
  }

  // 作業の起点 (作業・イベント・その他)
  for (const { id, spec: a } of pendingTriggers) {
    for (const n of clip(a.trigger_activities, L.refsPerItem, `作業「${a.name}」の起点の作業`)) {
      // この下書きで足した作業を先に探す (土台の同じ名前の作業より前)
      const same = model.elements
        .filter((e) => e.kind === "activity" && nameKey(e.name) === nameKey(nameOf(n)))
        .sort((a, b) => Number(baseIds.has(a.id)) - Number(baseIds.has(b.id)));
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
    const hasNote = baseIds.has(id) && !!(model.elements.find((e) => e.id === id) as { triggerNote?: string } | undefined)?.triggerNote;
    if (note && !hasNote) apply(updateElement(model, { id, patch: { triggerNote: truncateText(note, TRIGGER_NOTE_MAX_LENGTH) } }), `作業「${a.name}」の起点を書けません`);
  }

  // 課題
  for (const issue of clip(spec.issues, L.issues, "課題")) {
    // 土台にある課題と同じ名前は、足さない (同じ業務をやり直したとき、課題が二重にならないように)
    if (base && base.elements.some((e) => e.kind === "issue" && nameKey(e.name) === nameKey(nameOf(issue.name ?? "")))) continue;
    const found = clip(issue.targets, L.refsPerItem, `課題「${issue.name}」の対象`)
      // 対象は、この下書きで足した要素を先に探す (土台の別の業務の同じ名前の作業に付かないように)
      .map((n) => {
        const same = model.elements.filter((e) => isIssueTargetKind(e.kind) && nameKey(e.name) === nameKey(nameOf(n)));
        return same.find((e) => !baseIds.has(e.id)) ?? same[0];
      })
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
  const added: BuildResult["added"] = {};
  for (const e of model.elements) {
    if (e.kind === "buc" && e.isDefault) continue;
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (!baseIds.has(e.id)) added[e.kind] = (added[e.kind] ?? 0) + 1;
  }
  return { model, warnings: [...new Set(warnings)], counts, added };
}
