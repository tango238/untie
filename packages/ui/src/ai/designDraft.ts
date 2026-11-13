// 設計データの下書き (名前で参照する形) と、それを既存のモデルに足す純粋な関数。AI の呼び出しや画面は持たない。
// 「ソースコードから作成」の、データ (DSL とテーブル → 情報)・サイトマップ (画面と遷移)・画面 UI (view と bindings) の段階が使う。
// AI には id を作らせず、名前で参照させる。足すのは既存のコマンドで行い、足せない部分はその部分だけ落として警告に残す (モデルは壊さない)。
import {
  addDatabase,
  addTransition,
  renameDatabase,
  setDatabaseDesign,
  setDesignDatabases,
  setDesignScreenView,
  type CommandResult,
} from "@untie/core/model/commands";
import { DEFAULT_DATABASE_ID } from "@untie/core/model/design";
import { viewShapeProblem } from "@untie/core/model/designView";
import { NAME_MAX_LENGTH, truncateText } from "@untie/core/model/limits";
import { parsePrismaDsl, type PrismaError } from "@untie/core/model/prisma";
import { addSitemapScreens, designScreenName, TRANSITION_VIAS } from "@untie/core/model/sitemap";
import type { DesignScreen, SystemDesign, Transition, UntieModel } from "@untie/core/model/types";
import { validateView } from "../components/design/viewValidate";
import { sanitizeBindings } from "./designScreen";
import type { ToolDef } from "./tools";

// ---------------------------------------------------------------- 共通

const nameOf = (text: string): string => truncateText(text.trim(), NAME_MAX_LENGTH);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 足した結果の共通部分 */
export interface DraftResult {
  /** 足したあとのモデル。何も足せなければ渡したモデルのまま */
  model: UntieModel;
  /** 落とした部分・気づいたこと */
  warnings: string[];
}

/** 名前で見つけた要素 (同じ名前が複数あれば最初のもの) */
function findNamed(model: UntieModel, kind: "system" | "information", name: string) {
  const n = nameOf(name);
  return model.elements.find((e) => e.kind === kind && e.name === n);
}

// ---------------------------------------------------------------- データ (DSL とテーブル → 情報)

export interface DatabaseDraft {
  /** 対象のシステムの名前 */
  system: string;
  /** データベースの名前 (省略はシステム名から) */
  database_name?: string;
  /** Prisma のスキーマ (model / enum だけ) */
  dsl: string;
  /** テーブル (model の名前) と、それが表す情報の名前 */
  tables: { table: string; informations: string[] }[];
}

export interface DatabaseDraftOptions {
  /**
   * DSL に解析エラーがあっても受け付けるか。false (既定) ならモデルを変えず、dslErrors を返す (呼ぶ側が AI に出し直させる)。
   * true なら DSL をそのまま置き、エラーを警告に残す
   */
  acceptDslErrors?: boolean;
}

export interface DatabaseDraftResult extends DraftResult {
  /** 足したか (false ならモデルは変わっていない) */
  applied: boolean;
  /** DSL の解析エラー (acceptDslErrors でないときは、これがあると足さない) */
  dslErrors: PrismaError[];
  /** 見つからないシステムなど、足せなかった理由 (dslErrors とは別。出し直しても直らない) */
  failure?: string;
  databaseId?: string;
  added: { tables: number; informations: number };
}

export const SUBMIT_DATABASE_DRAFT_TOOL: ToolDef = {
  name: "submit_database",
  description: "システムのデータベースの DSL (Prisma のスキーマの一部) と、テーブル → 情報の対応を提出する。情報は名前で書く (id は作らない)。DSL に解析エラーがあると理由が返るので直して出し直す。",
  parameters: {
    type: "object",
    properties: {
      system: { type: "string", description: "対象のシステムの名前 (モデルにあるもの)" },
      database_name: { type: "string", description: "データベースの名前 (省略するとシステム名から付ける)" },
      dsl: { type: "string", description: "Prisma のスキーマ (model / enum だけ。datasource や generator は書かない)" },
      tables: {
        type: "array",
        description: "model の名前と、それが表す情報の名前 (モデルにある情報)。1 つの情報を複数のテーブルが表してもよい",
        items: {
          type: "object",
          properties: { table: { type: "string" }, informations: { type: "array", items: { type: "string" } } },
          required: ["table", "informations"],
          additionalProperties: false,
        },
      },
    },
    required: ["system", "dsl", "tables"],
    additionalProperties: false,
  },
};

/** 提出された内容を取り出す。形が違えば null */
export function readDatabaseDraft(raw: unknown): DatabaseDraft | null {
  if (!isObject(raw) || typeof raw.system !== "string" || typeof raw.dsl !== "string" || !Array.isArray(raw.tables)) return null;
  const tables = raw.tables.flatMap((t) => {
    if (!isObject(t) || typeof t.table !== "string" || t.table === "") return [];
    return [{ table: t.table, informations: strings(t.informations) }];
  });
  return { system: raw.system, ...(typeof raw.database_name === "string" ? { database_name: raw.database_name } : {}), dsl: raw.dsl, tables };
}

/**
 * データベースの下書きを、システムの設計に足す。データベースを 1 つ作り (同じ名前が設計にあればそれを置き換え)、
 * DSL とテーブル → 情報の対応を置いて、設計が使うデータベースにする。
 * 落とす: DSL に無いテーブルの対応、見つからない情報の名前。システムが見つからない・DSL が置けないときは何も足さず failure を返す。
 * DSL の解析エラーは acceptDslErrors でないとき足さずに dslErrors を返す
 */
export function applyDatabaseDraft(model: UntieModel, draft: DatabaseDraft, options: DatabaseDraftOptions = {}): DatabaseDraftResult {
  const none = (failure: string, dslErrors: PrismaError[] = []): DatabaseDraftResult => ({
    model,
    warnings: [failure],
    applied: false,
    dslErrors,
    failure,
    added: { tables: 0, informations: 0 },
  });
  const system = findNamed(model, "system", draft.system);
  if (!system) return none(`データ: システム「${draft.system}」が見つからないので、データベースを足せません`);
  const schema = parsePrismaDsl(draft.dsl);
  if (schema.errors.length > 0 && !options.acceptDslErrors) {
    return { model, warnings: [`データ: DSL に解析エラーが ${schema.errors.length} 件あるので、データベースを足しませんでした`], applied: false, dslErrors: schema.errors, added: { tables: 0, informations: 0 } };
  }
  const warnings: string[] = [];
  if (schema.errors.length > 0) {
    const first = schema.errors[0]!;
    warnings.push(`データ: DSL に解析エラーが ${schema.errors.length} 件残っています (${first.line} 行 ${first.column} 列: ${first.message})`);
  }
  // テーブル → 情報。DSL に無いテーブルと、見つからない情報は落とす
  const modelNames = new Set(schema.models.map((m) => m.name));
  const tables: { table: string; informationIds: string[] }[] = [];
  for (const t of draft.tables) {
    if (!modelNames.has(t.table)) {
      warnings.push(`データ: テーブル ${t.table} が DSL に無いので、情報との対応を外しました`);
      continue;
    }
    const ids: string[] = [];
    for (const n of t.informations) {
      const info = findNamed(model, "information", n);
      if (!info) warnings.push(`データ: テーブル ${t.table} が表す情報「${n}」が見つかりません`);
      else if (!ids.includes(info.id)) ids.push(info.id);
    }
    if (ids.length > 0) tables.push({ table: t.table, informationIds: ids });
  }

  // 自動で足された空の既定のデータベースがあれば、それを使う。設計に同じ名前のデータベースがあれば置き換える
  const dbName = nameOf(draft.database_name ?? "") || nameOf(`${system.name}のデータベース`);
  const design = model.designs.find((d) => d.systemId === system.id);
  let next = model;
  const step = <T>(r: CommandResult<T>, what: string): (T & { model: UntieModel }) | null => {
    if (!r.ok) {
      warnings.push(`データ: ${what}: ${r.reason}`);
      return null;
    }
    next = r.model;
    return r as T & { model: UntieModel };
  };
  const owned = (design?.databaseIds ?? []).map((id) => next.databases.find((d) => d.id === id)).find((d) => d?.name === dbName);
  const emptyDefault = next.databases.length === 1 && next.databases[0]!.id === DEFAULT_DATABASE_ID && next.databases[0]!.dsl === "" && next.databases[0]!.tables.length === 0;
  let databaseId: string;
  if (owned) databaseId = owned.id;
  else if (emptyDefault) {
    databaseId = DEFAULT_DATABASE_ID;
    if (!step(renameDatabase(next, { id: databaseId, name: dbName }), "データベースの名前を付けられません")) return none(warnings.join(" / "));
  } else {
    const added = step(addDatabase(next, { name: dbName }), "データベースを足せません");
    if (!added) return none(warnings.join(" / "));
    databaseId = added.id;
  }
  if (!step(setDatabaseDesign(next, { id: databaseId, dsl: draft.dsl, tables }), "DSL を置けません")) return none(warnings.join(" / "));
  const explicit = next.designs.find((d) => d.systemId === system.id)?.databaseIds ?? design?.databaseIds ?? [];
  if (!step(setDesignDatabases(next, { systemId: system.id, databaseIds: [...new Set([...explicit, databaseId])] }), "設計が使うデータベースにできません")) {
    return none(warnings.join(" / "));
  }
  const mapped = new Set(tables.flatMap((t) => t.informationIds));
  return { model: next, warnings, applied: true, dslErrors: schema.errors, databaseId, added: { tables: tables.length, informations: mapped.size } };
}

// ---------------------------------------------------------------- サイトマップ (画面と遷移)

export interface SitemapDraft {
  /** 対象のシステムの名前 */
  system: string;
  /** ソースから読み取れた遷移。画面は分析の画面の名前 */
  transitions: { from: string; to: string; via?: string; label?: string }[];
}

export interface SitemapDraftResult extends DraftResult {
  added: {
    /** サイトマップに足した画面 (分析の画面) の数 */
    screens: number;
    /** 作業のつながりなどから導いて足した遷移の数 */
    derivedTransitions: number;
    /** 下書きから足した遷移の数 */
    transitions: number;
    /** 導出済みなどで、すでにあるため足さなかった遷移の数 */
    skipped: number;
  };
}

export const SUBMIT_SITEMAP_TOOL: ToolDef = {
  name: "submit_sitemap",
  description: "システムの画面遷移 (ソースコードから読み取れたもの) を提出する。画面は分析の画面の名前で書く (id は作らない)。作業のつながりから導ける遷移は足さなくてよい。",
  parameters: {
    type: "object",
    properties: {
      system: { type: "string", description: "対象のシステムの名前" },
      transitions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "遷移元の画面の名前" },
            to: { type: "string", description: "遷移先の画面の名前" },
            via: { type: "string", enum: [...TRANSITION_VIAS], description: "きっかけ: button ボタン / row 一覧の行 / nav メニュー / afterSubmit 送信のあと" },
            label: { type: "string", description: "ボタンの文言など" },
          },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
    },
    required: ["system", "transitions"],
    additionalProperties: false,
  },
};

export function readSitemapDraft(raw: unknown): SitemapDraft | null {
  if (!isObject(raw) || typeof raw.system !== "string") return null;
  const transitions = (Array.isArray(raw.transitions) ? raw.transitions : []).flatMap((t) => {
    if (!isObject(t) || typeof t.from !== "string" || typeof t.to !== "string") return [];
    return [{ from: t.from, to: t.to, ...(typeof t.via === "string" ? { via: t.via } : {}), ...(typeof t.label === "string" ? { label: t.label } : {}) }];
  });
  return { system: raw.system, transitions };
}

/**
 * システムの分析の画面を設計の画面にし (addSitemapScreens。導出する遷移も足る)、ソースから読み取れた遷移を足す。
 * 落とす: 見つからない画面の名前を持つ遷移、自分自身への遷移。すでにある遷移 (導出済みを含む) は足さず skipped に数える。
 * 使えない via はきっかけだけ外して遷移は足す
 */
export function applySitemapDraft(model: UntieModel, draft: SitemapDraft): SitemapDraftResult {
  const empty = { screens: 0, derivedTransitions: 0, transitions: 0, skipped: 0 };
  const system = findNamed(model, "system", draft.system);
  if (!system) return { model, warnings: [`サイトマップ: システム「${draft.system}」が見つからないので、足せません`], added: empty };
  const warnings: string[] = [];
  const before = model.designs.find((d) => d.systemId === system.id);
  const sources = model.elements
    .filter((e) => e.kind === "screen" && e.systemId === system.id)
    .map((e) => ({ kind: "screen", screenId: e.id }) as const);
  let next = model;
  const added = addSitemapScreens(next, system.id, sources);
  if (!added.ok) return { model, warnings: [`サイトマップ: 画面を足せません: ${added.reason}`], added: empty };
  next = added.model;
  const design = (m: UntieModel): SystemDesign | undefined => m.designs.find((d) => d.systemId === system.id);
  const afterScreens = design(next);
  const result = { ...empty, screens: (afterScreens?.screens.length ?? 0) - (before?.screens.length ?? 0), derivedTransitions: (afterScreens?.transitions.length ?? 0) - (before?.transitions.length ?? 0) };

  // 画面の名前 → 設計の画面の id (同じ名前が複数あれば最初のもの)
  const byName = new Map<string, DesignScreen>();
  for (const s of afterScreens?.screens ?? []) {
    const n = designScreenName(next, s);
    if (!byName.has(n)) byName.set(n, s);
  }
  for (const t of draft.transitions) {
    const from = byName.get(nameOf(t.from));
    const to = byName.get(nameOf(t.to));
    if (!from || !to) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」の画面が見つからないので、落としました${!from && !to ? " (両方)" : !from ? ` (「${t.from}」)` : ` (「${t.to}」)`}`);
      continue;
    }
    if (from.id === to.id) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」は同じ画面への遷移なので、落としました`);
      continue;
    }
    if (design(next)?.transitions.some((x) => x.from === from.id && x.to === to.id)) {
      result.skipped++;
      continue;
    }
    let via: Transition["via"];
    if (t.via !== undefined && t.via !== "") {
      if ((TRANSITION_VIAS as readonly string[]).includes(t.via)) via = t.via as Transition["via"];
      else warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」のきっかけ「${t.via}」は使えないので、きっかけなしで足しました`);
    }
    const label = t.label ? truncateText(t.label.trim(), NAME_MAX_LENGTH) : undefined;
    const r = addTransition(next, { systemId: system.id, from: from.id, to: to.id, ...(via ? { via } : {}), ...(label ? { label } : {}) });
    if (!r.ok) {
      warnings.push(`サイトマップ: 遷移「${t.from}」→「${t.to}」を足せません: ${r.reason}`);
      continue;
    }
    next = r.model;
    result.transitions++;
  }
  return { model: next, warnings, added: result };
}

// ---------------------------------------------------------------- 画面 UI (view と bindings)

export interface ScreenDraft {
  /** 分析の画面の名前 (設計の画面の名前) */
  screen: string;
  /** 画面が複数のシステムにあるときの絞り込み */
  system?: string;
  /** mokkun v2 の view。遷移 (to) は画面の名前でも設計の画面の id でもよい */
  view: Record<string, unknown>;
  /** 項目 (fields[].item、一覧の列は `<セクションの id>.<列の id>`) → テーブルの列。databaseId は省くと設計が使うデータベース */
  bindings: { item: string; table: string; column: string; database?: string }[];
}

export interface ScreenDraftResult extends DraftResult {
  /** view を置いたか (false ならモデルは変わっていない) */
  applied: boolean;
  /** view が mokkun の検証に通らなかった理由 (AI に出し直させる材料。通らなければ view は置かない) */
  viewError?: string;
  /** 足せなかった理由 (画面が見つからないなど。viewError とは別) */
  failure?: string;
  added: { bindings: number; droppedBindings: number };
}

export const SUBMIT_SCREEN_DRAFT_TOOL: ToolDef = {
  name: "submit_screen",
  description: "画面 UI (mokkun v2 の view) と、項目と列の対応を提出する。画面は分析の画面の名前で書く。view が mokkun の検証に通らないと理由が返るので直して出し直す。",
  parameters: {
    type: "object",
    properties: {
      screen: { type: "string", description: "画面の名前" },
      system: { type: "string", description: "同じ名前の画面が複数のシステムにあるときのシステムの名前" },
      view: { type: "object", description: "mokkun v2 の view。遷移は action の navigate / submit の to、一覧の列の to に、遷移先の画面の名前を書く", additionalProperties: true },
      bindings: {
        type: "array",
        description: "項目と列の対応。item は fields[].item、一覧の列は `<セクションの id>.<列の id>`",
        items: {
          type: "object",
          properties: { item: { type: "string" }, table: { type: "string" }, column: { type: "string" } },
          required: ["item", "table", "column"],
          additionalProperties: false,
        },
      },
    },
    required: ["screen", "view", "bindings"],
    additionalProperties: false,
  },
};

export function readScreenDraft(raw: unknown): ScreenDraft | null {
  if (!isObject(raw) || typeof raw.screen !== "string" || !isObject(raw.view)) return null;
  const bindings = (Array.isArray(raw.bindings) ? raw.bindings : []).flatMap((b) => {
    if (!isObject(b) || typeof b.item !== "string" || typeof b.table !== "string" || typeof b.column !== "string") return [];
    const database = typeof b.database === "string" ? b.database : typeof b.databaseId === "string" ? b.databaseId : undefined;
    return [{ item: b.item, table: b.table, column: b.column, ...(database ? { database } : {}) }];
  });
  return { screen: raw.screen, ...(typeof raw.system === "string" ? { system: raw.system } : {}), view: raw.view, bindings };
}

const REMOVE = Symbol("remove");

/**
 * view の中の遷移先 (to) を、画面の名前から設計の画面の id へ直す。分からない to は、navigate の操作ならその操作ごと、
 * ほか (送信のあと・一覧の列) なら to だけを外し、その名前を unknown に集める (元の view は書き換えない)
 */
function resolveViewTargets(view: unknown, byName: ReadonlyMap<string, string>, ids: ReadonlySet<string>, unknown: Set<string>): unknown {
  if (Array.isArray(view)) return view.map((v) => resolveViewTargets(v, byName, ids, unknown)).filter((v) => v !== REMOVE);
  if (!isObject(view)) return view;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    if (key === "to" && typeof value === "string") {
      const id = ids.has(value) ? value : byName.get(nameOf(value));
      if (id) out[key] = id;
      else {
        unknown.add(value);
        if (view.kind === "navigate") return REMOVE;
      }
      continue;
    }
    const resolved = resolveViewTargets(value, byName, ids, unknown);
    if (resolved !== REMOVE) out[key] = resolved;
  }
  return out;
}

/**
 * 画面の画面 UI と対応を足す (setDesignScreenView)。画面の名前は設計の画面 (サイトマップにあるもの) の名前。
 * title は画面の名前にそろえ、goal が無ければ説明 (無ければ名前) で補う。view 内の遷移先は名前から id に直す (分からない遷移先は外す)。
 * 落とす: 存在しないデータベース・テーブル・列や、view に無い項目の対応 (sanitizeBindings)。
 * view が mokkun の検証に通らなければ置かず、viewError を返す (呼ぶ側が AI に出し直させるか、警告のまま飛ばすかを選ぶ)
 */
export function applyScreenDraft(model: UntieModel, draft: ScreenDraft): ScreenDraftResult {
  const fail = (failure: string): ScreenDraftResult => ({ model, warnings: [failure], applied: false, failure, added: { bindings: 0, droppedBindings: 0 } });
  const wanted = nameOf(draft.screen);
  let system: { id: string } | undefined;
  if (draft.system) {
    system = findNamed(model, "system", draft.system);
    if (!system) return fail(`画面 UI: システム「${draft.system}」が見つかりません`);
  }
  const candidates = model.designs
    .filter((d) => !system || d.systemId === system.id)
    .flatMap((d) => d.screens.filter((s) => designScreenName(model, s) === wanted).map((s) => ({ design: d, screen: s })));
  if (candidates.length === 0) return fail(`画面 UI: 画面「${draft.screen}」がサイトマップに見つかりません`);
  const warnings: string[] = [];
  if (candidates.length > 1) warnings.push(`画面 UI: 画面「${draft.screen}」が複数のシステムにあるので、最初の 1 つに置きました`);
  const { design, screen } = candidates[0]!;

  // 大きさ・深さ・使えないキー (__proto__ など) は、読み替える前に検査する
  const shape = viewShapeProblem(draft.view);
  if (shape) return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view を置きませんでした (${shape})`], applied: false, viewError: shape, added: { bindings: 0, droppedBindings: 0 } };

  const byName = new Map<string, string>();
  for (const s of design.screens) {
    const n = designScreenName(model, s);
    if (!byName.has(n)) byName.set(n, s.id);
  }
  const unknownTargets = new Set<string>();
  const resolved = resolveViewTargets(draft.view, byName, new Set(design.screens.map((s) => s.id)), unknownTargets) as Record<string, unknown>;
  for (const t of unknownTargets) warnings.push(`画面 UI: 画面「${wanted}」の遷移先「${t}」が見つからないので、その遷移を外しました`);

  const analysis = screen.source.kind === "screen" ? model.elements.find((e) => e.id === (screen.source as { screenId: string }).screenId) : undefined;
  const goal = typeof resolved.goal === "string" && resolved.goal.trim() !== "" ? resolved.goal : (analysis?.kind === "screen" && analysis.description?.trim()) || wanted;
  const view = { ...resolved, title: wanted, goal };
  const check = validateView(view, screen.id, design.screens.map((s) => s.id));
  if (!check.ok) {
    return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view が mokkun の検証に通らないので、置きませんでした (${check.message})`], applied: false, viewError: check.message, added: { bindings: 0, droppedBindings: 0 } };
  }
  // 対応: databaseId は名前で書かれていても使うデータベースの id にそろえる (sanitizeBindings が id で判定する)
  const proposed = draft.bindings.map((b) => {
    const db = b.database ? model.databases.find((d) => d.id === b.database || d.name === b.database) : undefined;
    return { item: b.item, table: b.table, column: b.column, ...(db ? { databaseId: db.id } : {}) };
  });
  const { bindings, dropped } = sanitizeBindings(model, design, view, proposed);
  if (dropped > 0) warnings.push(`画面 UI: 画面「${wanted}」の項目と列の対応のうち ${dropped} 件は、存在しないテーブル・列や view に無い項目なので、落としました`);
  const r = setDesignScreenView(model, { systemId: design.systemId, id: screen.id, view, bindings });
  if (!r.ok) return { model, warnings: [...warnings, `画面 UI: 画面「${wanted}」の view を置けません: ${r.reason}`], applied: false, failure: r.reason, added: { bindings: 0, droppedBindings: dropped } };
  return { model: r.model, warnings, applied: true, added: { bindings: bindings.length, droppedBindings: dropped } };
}
