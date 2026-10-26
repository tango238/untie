// 「プロンプトから作成」で AI に出してもらうモデルの下書き (名前で参照する形) と、それをモデルに組み立てる処理。
// AI には id を作らせず、名前で参照させる。組み立ては既存のコマンドで行い、整合性の検査もコマンドに任せる。
import { addElement, addRelation, type CommandResult, type ElementInit } from "../model/commands";
import { defaultBucOf } from "../model/selectors";
import { emptyModel, type ElementKind, type UntieModel } from "../model/types";
import type { ToolDef } from "./tools";

export interface SpecNamed {
  name: string;
  description?: string;
}

export interface SpecUsecase extends SpecNamed {
  informations?: string[];
  conditions?: string[];
  /** この操作を実行できる状態 */
  from_states?: string[];
  /** 実行後の状態 */
  to_states?: string[];
}

export interface SpecActivity extends SpecNamed {
  /** 担当 (アクター・外部アクター・システムの名前) */
  performers?: string[];
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
  /** 取得元 (システム・帳票の名前) */
  sources?: string[];
  /** 保存先 (システム・帳票の名前) */
  stores?: string[];
}

export interface ModelSpec {
  system_name: string;
  overview?: string;
  actors?: SpecNamed[];
  external_actors?: SpecNamed[];
  systems?: SpecNamed[];
  ledgers?: SpecNamed[];
  businesses: SpecBusiness[];
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

const usecaseSchema = named({
  informations: names("扱う情報の名前 (informations に定義したもの)"),
  conditions: names("判断に使う条件の名前 (conditions に定義したもの)"),
  from_states: names("この操作を実行できる状態の名前"),
  to_states: names("実行後に移る状態の名前"),
});
const activitySchema = named({
  performers: names("担当する担い手の名前 (actors / external_actors / systems に定義したもの)。必ず 1 つ以上"),
  usecases: list(usecaseSchema, "この作業で使う操作 (システム・帳票に対する 1 回の操作)。同じ名前の操作は同じものとして扱う"),
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
      actors: list(named(), "社内の人の役割 (〇〇担当など)"),
      external_actors: list(named(), "社外の人・組織 (顧客・取引先など)"),
      systems: list(named(), "情報システム (自社・社外を問わない)。作業の担当にも、情報の置き場所にもなる"),
      ledgers: list(named(), "紙の台帳・伝票 (情報の置き場所)"),
      businesses: list(
        named({
          main_actors: names("主担当のアクターの名前"),
          activities: list(activitySchema, "活動 (BUC) に分けない作業"),
          bucs: list(named({ activities: list(activitySchema, "この活動の作業 (順番どおり)") }), "活動 (BUC): 1 つの目的を果たす作業のまとまり"),
        }),
        "業務: 部門や担当で分かれる仕事の大きなまとまり",
      ),
      contexts: list(named(), "コンテキスト: 役割の同じ情報をまとめる親カテゴリ"),
      informations: list(
        named({
          context: { type: "string", description: "所属するコンテキストの名前" },
          related: names("関連する情報の名前"),
          variations: names("種別にしているバリエーションの名前"),
          sources: names("取得元のシステム・帳票の名前"),
          stores: names("保存先のシステム・帳票の名前"),
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
            targets: names("対象の業務・作業・操作の名前"),
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

export interface BuildResult {
  model: UntieModel;
  /** 名前が見つからなかったなど、組み立てで気づいたこと */
  warnings: string[];
  counts: Partial<Record<ElementKind, number>>;
}

/** 下書きをモデルに組み立てる。参照先の名前が無ければ、その参照を飛ばして warnings に残す */
export function buildModelFromSpec(spec: ModelSpec): BuildResult {
  let model = emptyModel(spec.system_name || "新しいモデル");
  if (spec.overview) model = { ...model, meta: { ...model.meta, description: spec.overview } };
  const warnings: string[] = [];
  // 種類ごとの名前 → id
  const ids = new Map<string, Map<string, string>>();
  const idOf = (group: string, name: string) => ids.get(group)?.get(name.trim());

  const apply = <T>(r: CommandResult<T>, what: string): (T & { model: UntieModel }) | null => {
    if (!r.ok) {
      warnings.push(`${what}: ${r.reason}`);
      return null;
    }
    model = r.model;
    return r as T & { model: UntieModel };
  };
  const add = (kind: ElementKind, group: string, item: SpecNamed, init: Record<string, unknown> = {}): string | null => {
    const name = item.name?.trim();
    if (!name) return null;
    const existing = idOf(group, name);
    if (existing) return existing;
    const r = apply(
      addElement(model, { kind, name, init: { ...(item.description ? { description: item.description } : {}), ...init } as ElementInit }),
      `${name} を作れません`,
    );
    if (!r) return null;
    if (!ids.has(group)) ids.set(group, new Map());
    ids.get(group)!.set(name, r.id);
    return r.id;
  };
  const relate = (sourceId: string | null | undefined, targetId: string | null | undefined) => {
    if (!sourceId || !targetId) return;
    if (model.relations.some((r) => r.sourceId === sourceId && r.targetId === targetId)) return;
    apply(addRelation(model, { sourceId, targetId }), "関係を作れません");
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
  for (const a of spec.actors ?? []) add("actor", "actor", a);
  for (const a of spec.external_actors ?? []) add("externalActor", "actor", a);
  for (const a of spec.systems ?? []) add("system", "actor", a);
  for (const a of spec.ledgers ?? []) add("ledger", "ledger", a);
  // 情報のまわり (操作から参照されるので先に作る)
  for (const c of spec.contexts ?? []) add("context", "context", c);
  const ctx = (name: string | undefined) => (name ? ref(["context"], name, "コンテキスト") : null);
  for (const v of spec.variations ?? []) add("variation", "variation", v, { values: v.values ?? [], contextId: ctx(v.context) });
  for (const g of spec.state_groups ?? []) {
    for (const st of g.states ?? []) add("state", "state", st, { group: g.name, contextId: ctx(g.context) });
  }
  for (const i of spec.informations ?? []) add("information", "information", i, { contextId: ctx(i.context) });
  for (const c of spec.conditions ?? []) add("condition", "condition", c, { contextId: ctx(c.context) });
  for (const i of spec.informations ?? []) {
    const id = idOf("information", i.name);
    for (const n of i.related ?? []) relate(id, ref(["information"], n, "関連する情報"));
    for (const n of i.variations ?? []) relate(id, ref(["variation"], n, "バリエーション"));
    for (const n of i.sources ?? []) relate(ref(["actor", "ledger"], n, "取得元"), id);
    for (const n of i.stores ?? []) relate(id, ref(["actor", "ledger"], n, "保存先"));
  }
  for (const c of spec.conditions ?? []) {
    const id = idOf("condition", c.name);
    for (const n of c.variations ?? []) relate(id, ref(["variation"], n, "バリエーション"));
    for (const n of c.states ?? []) relate(id, ref(["state"], n, "状態"));
  }

  // 業務 → 活動 → 作業 → 操作
  const addActivity = (a: SpecActivity, bucId: string) => {
    const id = add("activity", `activity:${bucId}`, a, { bucId });
    if (!id) return;
    for (const n of a.performers ?? []) relate(ref(["actor"], n, "担当"), id);
    for (const u of a.usecases ?? []) {
      const ucId = add("usecase", "usecase", u);
      relate(id, ucId);
      for (const n of u.informations ?? []) relate(ucId, ref(["information"], n, "情報"));
      for (const n of u.conditions ?? []) relate(ucId, ref(["condition"], n, "条件"));
      for (const n of u.from_states ?? []) relate(ref(["state"], n, "状態"), ucId);
      for (const n of u.to_states ?? []) relate(ucId, ref(["state"], n, "状態"));
    }
  };
  for (const b of spec.businesses ?? []) {
    const bizId = add("business", "business", b);
    if (!bizId) continue;
    for (const n of b.main_actors ?? []) {
      const actorId = ref(["actor"], n, "主担当");
      if (actorId && model.elements.find((e) => e.id === actorId)?.kind === "actor") relate(actorId, bizId);
      else if (actorId) warnings.push(`主担当「${n}」はアクターではないので結べません`);
    }
    const def = defaultBucOf(model, bizId);
    if (def) for (const a of b.activities ?? []) addActivity(a, def.id);
    for (const buc of b.bucs ?? []) {
      const bucId = add("buc", `buc:${bizId}`, buc, { businessId: bizId });
      if (bucId) for (const a of buc.activities ?? []) addActivity(a, bucId);
    }
  }

  // 課題
  for (const issue of spec.issues ?? []) {
    const targets = (issue.targets ?? [])
      .map((n) => model.elements.find((e) => (e.kind === "business" || e.kind === "activity" || e.kind === "usecase") && e.name === n.trim())?.id)
      .filter((id): id is string => !!id);
    apply(
      addElement(model, {
        kind: "issue",
        name: issue.name,
        init: { severity: Math.min(5, Math.max(1, Math.round(issue.severity ?? 3))), targetIds: targets, ...(issue.description ? { description: issue.description } : {}) },
      }),
      `課題「${issue.name}」を作れません`,
    );
  }

  const counts: BuildResult["counts"] = {};
  for (const e of model.elements) {
    if (e.kind === "buc" && e.isDefault) continue;
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return { model, warnings: [...new Set(warnings)], counts };
}
