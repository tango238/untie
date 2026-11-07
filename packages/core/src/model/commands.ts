// モデルを変える純粋関数 (設計書 6 章)。
// すべて (model, payload) => 結果 の形で、失敗は例外ではなく { ok: false, reason } で返す。
import { produce } from "immer";
import { DEFAULT_DATABASE_ID, DEFAULT_DATABASE_NAME, removeDesignScreens, usedDesignIds } from "./design";
import { newUniqueId } from "./id";
import { isPrismaIdent } from "./prisma";
import { checkLength, LINK_TITLE_MAX_LENGTH, truncateText } from "./limits";
import { relationKindFor, sameRelation } from "./relations";
import {
  DEFAULT_EDGE_SIDES,
  EDGE_SIDES,
  isFrameKind,
  isContextMemberKind,
  isIssueTargetKind,
  isSystemMemberKind,
  NFR_CATEGORIES,
  ISSUE_ANALYSIS_KEYS,
  issueScopeOfKind,
  type Buc,
  type DesignScreen,
  type SystemDesign,
  type Transition,
  type EdgeSide,
  type Element,
  type ElementKind,
  type IssueAnalysis,
  type Link,
  type NfrCategory,
  type UntieModel,
} from "./types";

export interface Fail {
  ok: false;
  reason: string;
}
export type Ok<T = unknown> = { ok: true; model: UntieModel } & T;
export type CommandResult<T = unknown> = Ok<T> | Fail;

export interface Position {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

/** 枠でない要素 (カード) の表示サイズ。UI のカードの大きさと一致させる */
export const DEFAULT_CARD_SIZE: Size = { width: 168, height: 64 };

/** 枠 (業務・BUC) をボードに置くときの既定サイズ */
export const DEFAULT_FRAME_SIZE: Record<"business" | "buc", Size> = {
  business: { width: 480, height: 320 },
  buc: { width: 240, height: 200 },
};

/** 種類ごとに追加時に指定できる初期値 */
export interface ElementInit {
  description?: string;
  /** information / state / condition / variation (所属コンテキスト。省略時は未分類) */
  contextId?: string | null;
  /** state */
  group?: string;
  /** variation */
  values?: string[];
  /** issue */
  severity?: number;
  targetIds?: string[];
  /** buc (必須) */
  businessId?: string;
  /** activity */
  bucId?: string | null;
  /** screen / nfr (必須。属するシステム) */
  systemId?: string;
  /** nfr */
  category?: NfrCategory;
  verification?: string;
}

/** updateElement で変えられる項目 */
export interface ElementPatch {
  name?: string;
  description?: string;
  /** activity / usecase */
  links?: Link[];
  /** activity / usecase。かかる時間 (時間単位、小数点第一位まで)。null で消す */
  hours?: number | null;
  group?: string;
  values?: string[];
  severity?: number;
  targetIds?: string[];
  /** issue。分析 (現象・所在・理由・影響)。指定した項目だけ変わり、空文字で消す。null で分析全体を消す */
  analysis?: Partial<IssueAnalysis> | null;
  /** nfr。分類。null で未分類にする */
  category?: NfrCategory | null;
  /** nfr。検証方法。空文字で消す */
  verification?: string;
  /** activity。起点のうち、作業・イベント以外の自由入力 (その他)。空文字 (空白だけも) で消す */
  triggerNote?: string;
}

const PATCH_KEYS_BY_KIND: Record<ElementKind, readonly (keyof ElementPatch)[]> = {
  actor: [],
  externalActor: [],
  system: [],
  ledger: [],
  business: [],
  buc: [],
  activity: ["links", "hours", "triggerNote"],
  usecase: ["links", "hours"],
  context: [],
  information: [],
  state: ["group"],
  variation: ["values"],
  condition: [],
  issue: ["severity", "targetIds", "analysis"],
  event: [],
  screen: [],
  nfr: ["category", "verification"],
};

const fail = (reason: string): Fail => ({ ok: false, reason });

function findElement(model: UntieModel, id: string): Element | undefined {
  return model.elements.find((e) => e.id === id);
}

function usedIds(model: UntieModel): Set<string> {
  const used = new Set<string>();
  for (const e of model.elements) used.add(e.id);
  for (const r of model.relations) used.add(r.id);
  for (const b of model.boards) used.add(b.id);
  return used;
}

function isFinitePoint(p: Position): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function isValidSize(s: Size): boolean {
  return Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= 1 && s.height >= 1;
}

/** 課題の対象 id 一覧を検査する。問題があれば理由を返す */
function checkIssueTargets(model: UntieModel, targetIds: readonly string[]): string | null {
  const scopes = new Set<string>();
  for (const id of targetIds) {
    const t = findElement(model, id);
    if (!t) return `課題の対象が存在しません: ${id}`;
    if (!isIssueTargetKind(t.kind)) return "課題の対象にできるのは登場人物 (アクター・外部アクター・システム・帳票)・業務・作業・操作・画面だけです";
    scopes.add(issueScopeOfKind(t.kind));
  }
  // 全体的な課題 (登場人物) と具体的な課題 (業務・作業・操作) は分けて扱う
  if (scopes.size > 1) return ISSUE_SCOPE_MIX_REASON;
  return null;
}

export const ISSUE_SCOPE_MIX_REASON =
  "全体的な課題 (登場人物が対象) と具体的な課題 (業務・作業・操作が対象) の対象は混ぜられません。付け替えるときは、いまの対象を外してから追加してください";

function checkSeverity(severity: number): string | null {
  return Number.isInteger(severity) && severity >= 1 && severity <= 5 ? null : "重要度は 1〜5 の整数にしてください";
}

/** 時間は 0 以上で、小数点第一位まで */
export function checkHours(hours: number): string | null {
  if (!Number.isFinite(hours) || hours < 0 || hours > 100000) return "時間は 0 以上の数で入力してください";
  if (Math.abs(Math.round(hours * 10) - hours * 10) > 1e-6) return "時間は小数点第一位まで入力してください";
  return null;
}

function checkLinks(links: Link[]): string | null {
  for (const l of links) {
    const url = l.url.trim();
    if (!/^https?:\/\//.test(url)) return `リンクの URL は http:// か https:// で始めてください: ${truncateText(l.url, 80)}`;
    const reason = checkLength("linkUrl", url) ?? checkLength("linkTitle", l.title.trim());
    if (reason) return reason;
  }
  return null;
}

/** 文字列の項目の長さを検査する。最初に見つかった問題の理由を返す */
function firstLengthProblem(...problems: (string | null)[]): string | null {
  return problems.find((p) => p !== null) ?? null;
}

function checkValues(values: readonly string[]): string | null {
  for (const v of values) {
    const reason = checkLength("value", v);
    if (reason) return reason;
  }
  return null;
}

/** 削除した要素への参照を、関係・ボードのノード・課題の対象から掃除する */
function sweepReferences(draft: UntieModel, removed: ReadonlySet<string>): void {
  draft.relations = draft.relations.filter((r) => !removed.has(r.sourceId) && !removed.has(r.targetId));
  const relationIds = new Set(draft.relations.map((r) => r.id));
  for (const board of draft.boards) {
    board.nodes = board.nodes.filter((n) => !removed.has(n.elementId));
    // 消えた関係のボードごとの線の見た目も一緒に消す (removeRelation と同じ)
    if (board.edges) {
      board.edges = board.edges.filter((e) => relationIds.has(e.relationId));
      if (board.edges.length === 0) delete board.edges;
    }
  }
  for (const e of draft.elements) {
    if (e.kind === "issue") e.targetIds = e.targetIds.filter((id) => !removed.has(id));
  }
  sweepDesigns(draft, removed);
}

/**
 * 削除した要素への参照を、設計データから掃除する (0.4.0)。
 * - システムを消すと、その設計も消す
 * - 画面を消すと、それを参照する設計の画面と、その画面を参照する遷移・ナビゲーションの項目を消す (bindings は画面と一緒に消える)
 * - 情報を消すと、データベースのテーブルが表す情報から外す。データベース自体は消さない
 */
function sweepDesigns(draft: UntieModel, removed: ReadonlySet<string>): void {
  draft.designs = draft.designs.filter((d) => !removed.has(d.systemId));
  for (const design of draft.designs) {
    removeDesignScreens(design, (s) => s.source.kind === "screen" && removed.has(s.source.screenId));
  }
  for (const db of draft.databases) {
    for (const table of db.tables) table.informationIds = table.informationIds.filter((id) => !removed.has(id));
    // 表す情報が無くなったテーブルの項目は消す (setTableInformation で空にしたのと同じ)
    db.tables = db.tables.filter((t) => t.informationIds.length > 0);
  }
}

// ---------------------------------------------------------------- 設計

export interface EnsureDesignPayload {
  systemId: string;
}

/**
 * そのシステムの設計が無ければ空の設計を足す。データベースが 1 つも無ければ既定のデータベースも足す。
 * 設計モードでシステムを選んだときに呼ぶ。すでにあれば何も変えない
 */
export function ensureDesign(model: UntieModel, payload: EnsureDesignPayload): CommandResult {
  const system = findElement(model, payload.systemId);
  if (!system || system.kind !== "system") return fail(`システムが存在しません: ${payload.systemId}`);
  const needsDesign = !model.designs.some((d) => d.systemId === payload.systemId);
  const needsDatabase = model.databases.length === 0;
  if (!needsDesign && !needsDatabase) return { ok: true, model };
  const next = produce(model, (draft) => {
    if (needsDesign) {
      draft.designs.push({ systemId: payload.systemId, databaseIds: [], screens: [], transitions: [], layout: { shell: "shell", navigation: [] } });
    }
    if (needsDatabase) draft.databases.push({ id: DEFAULT_DATABASE_ID, name: DEFAULT_DATABASE_NAME, dsl: "", tables: [] });
  });
  return { ok: true, model: next };
}

export interface RemoveDesignPayload {
  systemId: string;
}

/** システムの設計を消す。データベースは消さない */
export function removeDesign(model: UntieModel, payload: RemoveDesignPayload): CommandResult {
  if (!model.designs.some((d) => d.systemId === payload.systemId)) return fail(`設計が存在しません: ${payload.systemId}`);
  const next = produce(model, (draft) => {
    draft.designs = draft.designs.filter((d) => d.systemId !== payload.systemId);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 設計: データ

const databaseOf = (model: UntieModel, id: string) => model.databases.find((d) => d.id === id);

/** 情報の id の一覧の検査 (重複を除いた一覧か、失敗の理由) */
function checkInformationIds(model: UntieModel, ids: readonly string[]): string[] | Fail {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const e = findElement(model, id);
    if (!e || e.kind !== "information") return fail(`情報が存在しません: ${id}`);
  }
  return unique;
}

/** テーブル (model) の名前の検査。問題があれば理由 */
function checkTableName(table: string): string | null {
  if (table === "") return "テーブルの名前が必要です";
  const tooLong = checkLength("name", table);
  if (tooLong) return tooLong;
  return isPrismaIdent(table) ? null : `テーブルの名前は英数字とアンダースコアで書いてください: ${table}`;
}

export interface AddDatabasePayload {
  /** 省略すると作る (db_ で始まる) */
  id?: string;
  name: string;
}

/** データベースを足す (DSL は空)。設計をまたいで共有する */
export function addDatabase(model: UntieModel, payload: AddDatabasePayload): CommandResult<{ id: string }> {
  const name = payload.name.trim();
  if (name === "") return fail("名前が必要です");
  const tooLong = checkLength("name", name);
  if (tooLong) return fail(tooLong);
  const used = new Set(model.databases.map((d) => d.id));
  if (payload.id !== undefined && used.has(payload.id)) return fail(`id がすでに使われています: ${payload.id}`);
  const id = payload.id ?? newUniqueId("database", used);
  const next = produce(model, (draft) => {
    draft.databases.push({ id, name, dsl: "", tables: [] });
  });
  return { ok: true, model: next, id };
}

export interface RenameDatabasePayload {
  id: string;
  name: string;
}

export function renameDatabase(model: UntieModel, payload: RenameDatabasePayload): CommandResult {
  if (!databaseOf(model, payload.id)) return fail(`データベースが存在しません: ${payload.id}`);
  const name = payload.name.trim();
  if (name === "") return fail("名前が必要です");
  const tooLong = checkLength("name", name);
  if (tooLong) return fail(tooLong);
  const next = produce(model, (draft) => {
    databaseOf(draft, payload.id)!.name = name;
  });
  return { ok: true, model: next };
}

export interface RemoveDatabasePayload {
  id: string;
}

/** データベースを消す。全設計の使うデータベースから外し、そのデータベースを指す画面の項目の対応 (bindings) も消す */
export function removeDatabase(model: UntieModel, payload: RemoveDatabasePayload): CommandResult {
  if (!databaseOf(model, payload.id)) return fail(`データベースが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.databases = draft.databases.filter((d) => d.id !== payload.id);
    for (const design of draft.designs) {
      design.databaseIds = design.databaseIds.filter((id) => id !== payload.id);
      for (const screen of design.screens) {
        if (!screen.bindings) continue;
        screen.bindings = screen.bindings.filter((b) => b.databaseId !== payload.id);
        if (screen.bindings.length === 0) delete screen.bindings;
      }
    }
  });
  return { ok: true, model: next };
}

export interface SetDatabaseDslPayload {
  id: string;
  dsl: string;
}

/** データベースの DSL を置き換える (解析エラーがあっても保存する) */
export function setDatabaseDsl(model: UntieModel, payload: SetDatabaseDslPayload): CommandResult {
  if (!databaseOf(model, payload.id)) return fail(`データベースが存在しません: ${payload.id}`);
  const tooLong = checkLength("dsl", payload.dsl);
  if (tooLong) return fail(tooLong);
  if (databaseOf(model, payload.id)!.dsl === payload.dsl) return { ok: true, model };
  const next = produce(model, (draft) => {
    databaseOf(draft, payload.id)!.dsl = payload.dsl;
  });
  return { ok: true, model: next };
}

export interface SetTableInformationPayload {
  /** データベースの id */
  id: string;
  table: string;
  informationIds: string[];
}

/** テーブルが表す情報を置き換える。空にするとテーブルの項目を消す。重複は除く。存在しない情報は失敗 */
export function setTableInformation(model: UntieModel, payload: SetTableInformationPayload): CommandResult {
  if (!databaseOf(model, payload.id)) return fail(`データベースが存在しません: ${payload.id}`);
  const table = payload.table.trim();
  const badName = checkTableName(table);
  if (badName) return fail(badName);
  const ids = checkInformationIds(model, payload.informationIds);
  if (!Array.isArray(ids)) return ids;
  const next = produce(model, (draft) => {
    const db = databaseOf(draft, payload.id)!;
    const at = db.tables.findIndex((t) => t.table === table);
    if (ids.length === 0) {
      if (at >= 0) db.tables.splice(at, 1);
    } else if (at >= 0) db.tables[at]!.informationIds = ids;
    else db.tables.push({ table, informationIds: ids });
  });
  return { ok: true, model: next };
}

export interface SetDatabaseDesignPayload {
  id: string;
  dsl: string;
  tables: { table: string; informationIds: string[] }[];
}

/** DSL と、テーブルが表す情報の対応を、まとめて置き換える (雛形・AI の生成が 1 回の変更にするため) */
export function setDatabaseDesign(model: UntieModel, payload: SetDatabaseDesignPayload): CommandResult {
  if (!databaseOf(model, payload.id)) return fail(`データベースが存在しません: ${payload.id}`);
  const tooLong = checkLength("dsl", payload.dsl);
  if (tooLong) return fail(tooLong);
  const tables: { table: string; informationIds: string[] }[] = [];
  for (const t of payload.tables) {
    const name = t.table.trim();
    const badName = checkTableName(name);
    if (badName) return fail(badName);
    const ids = checkInformationIds(model, t.informationIds);
    if (!Array.isArray(ids)) return ids;
    const existing = tables.find((x) => x.table === name);
    if (existing) existing.informationIds = [...new Set([...existing.informationIds, ...ids])];
    else if (ids.length > 0) tables.push({ table: name, informationIds: ids });
  }
  const next = produce(model, (draft) => {
    const db = databaseOf(draft, payload.id)!;
    db.dsl = payload.dsl;
    db.tables = tables;
  });
  return { ok: true, model: next };
}

export interface SetDesignDatabasesPayload {
  systemId: string;
  /** 空なら既定のデータベース */
  databaseIds: string[];
}

/** 設計が使うデータベースを置き換える。設計が無ければ作る (ensureDesign)。存在しないデータベースは失敗 */
export function setDesignDatabases(model: UntieModel, payload: SetDesignDatabasesPayload): CommandResult {
  const ensured = ensureDesign(model, { systemId: payload.systemId });
  if (!ensured.ok) return ensured;
  const ids = [...new Set(payload.databaseIds)];
  const missing = ids.find((id) => !databaseOf(ensured.model, id));
  if (missing !== undefined) return fail(`データベースが存在しません: ${missing}`);
  const next = produce(ensured.model, (draft) => {
    draft.designs.find((d) => d.systemId === payload.systemId)!.databaseIds = ids;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 設計: サイトマップ

const BUILTIN_SCREENS: readonly string[] = ["signIn", "top", "signUp", "passwordReminder"];
const TRANSITION_VIAS: readonly string[] = ["button", "row", "nav", "afterSubmit"];

/** 設計が無ければ失敗 (足す以外のコマンドは、設計を作らない) */
function existingDesign(model: UntieModel, systemId: string): SystemDesign | Fail {
  return model.designs.find((d) => d.systemId === systemId) ?? fail(`設計が存在しません: ${systemId}`);
}
const isFail = (x: SystemDesign | Fail): x is Fail => "ok" in x;

const sourceKey = (source: DesignScreen["source"]): string => (source.kind === "screen" ? `screen:${source.screenId}` : `builtin:${source.builtin}`);

export interface AddDesignScreensPayload {
  systemId: string;
  /** 足す画面。id を省くと作る (遷移から指したいときは、先に決めた id を渡す) */
  screens: { id?: string; source: DesignScreen["source"] }[];
  /** 足す遷移。from / to は設計にある画面か、同時に足す画面の id */
  transitions: { id?: string; from: string; to: string; via?: Transition["via"]; label?: string }[];
}

/**
 * サイトマップに画面と遷移を足す。設計が無ければ作る (ensureDesign)。
 * 分析の画面は同じシステムの画面だけ。同じ画面を 2 つ足せず、同じ from / to の遷移は 2 本持てない
 */
export function addDesignScreens(model: UntieModel, payload: AddDesignScreensPayload): CommandResult<{ screenIds: string[]; transitionIds: string[] }> {
  if (payload.screens.length === 0 && payload.transitions.length === 0) return { ok: true, model, screenIds: [], transitionIds: [] };
  const ensured = ensureDesign(model, { systemId: payload.systemId });
  if (!ensured.ok) return ensured;
  const base = ensured.model;
  const design = base.designs.find((d) => d.systemId === payload.systemId)!;
  const used = usedDesignIds(base);
  const sources = new Set(design.screens.map((s) => sourceKey(s.source)));
  const added: DesignScreen[] = [];
  for (const input of payload.screens) {
    const { source } = input;
    if (source.kind === "screen") {
      const screen = findElement(base, source.screenId);
      if (!screen || screen.kind !== "screen") return fail(`画面が存在しません: ${source.screenId}`);
      if (screen.systemId !== payload.systemId) return fail(`別のシステムの画面は足せません: ${screen.name || source.screenId}`);
    } else if (!BUILTIN_SCREENS.includes(source.builtin)) {
      return fail(`組み込みの画面ではありません: ${String(source.builtin)}`);
    }
    if (sources.has(sourceKey(source))) return fail("その画面はすでにサイトマップにあります");
    sources.add(sourceKey(source));
    if (input.id !== undefined && used.has(input.id)) return fail(`id がすでに使われています: ${input.id}`);
    const id = input.id ?? newUniqueId("designScreen", used);
    used.add(id);
    added.push({ id, source: source.kind === "screen" ? { kind: "screen", screenId: source.screenId } : { kind: "builtin", builtin: source.builtin } });
  }
  const screenIds = new Set([...design.screens, ...added].map((s) => s.id));
  const pairs = new Set(design.transitions.map((t) => `${t.from}\n${t.to}`));
  const transitions: Transition[] = [];
  for (const t of payload.transitions) {
    const reason = checkTransition(t, screenIds, pairs);
    if (reason) return fail(reason);
    pairs.add(`${t.from}\n${t.to}`);
    if (t.id !== undefined && used.has(t.id)) return fail(`id がすでに使われています: ${t.id}`);
    const id = t.id ?? newUniqueId("transition", used);
    used.add(id);
    transitions.push({ id, from: t.from, to: t.to, ...(t.via ? { via: t.via } : {}), ...(t.label ? { label: t.label } : {}) });
  }
  const next = produce(base, (draft) => {
    const d = draft.designs.find((x) => x.systemId === payload.systemId)!;
    d.screens.push(...added);
    d.transitions.push(...transitions);
  });
  return { ok: true, model: next, screenIds: added.map((s) => s.id), transitionIds: transitions.map((t) => t.id) };
}

/** 遷移の入力の検査。問題があれば理由 */
function checkTransition(t: { from: string; to: string; via?: string; label?: string }, screenIds: ReadonlySet<string>, pairs: ReadonlySet<string>): string | null {
  if (!screenIds.has(t.from) || !screenIds.has(t.to)) return "遷移の両端はサイトマップの画面でなければなりません";
  if (t.from === t.to) return "同じ画面への遷移は作れません";
  if (pairs.has(`${t.from}\n${t.to}`)) return "その遷移はすでにあります";
  if (t.via !== undefined && !TRANSITION_VIAS.includes(t.via)) return `遷移のきっかけが正しくありません: ${t.via}`;
  if (t.label !== undefined) return checkLength("transitionLabel", t.label);
  return null;
}

export interface RemoveDesignScreensByIdPayload {
  systemId: string;
  /** 外す DesignScreen の id */
  ids: string[];
}

/** サイトマップから画面を外す。その画面を指す遷移とナビゲーションの項目も外す (画面 UI・bindings は画面と一緒に消える) */
export function removeDesignScreensById(model: UntieModel, payload: RemoveDesignScreensByIdPayload): CommandResult<{ removed: string[] }> {
  if (payload.ids.length === 0) return { ok: true, model, removed: [] };
  const design = existingDesign(model, payload.systemId);
  if (isFail(design)) return design;
  const missing = payload.ids.find((id) => !design.screens.some((s) => s.id === id));
  if (missing !== undefined) return fail(`サイトマップに画面がありません: ${missing}`);
  const ids = new Set(payload.ids);
  let removed: string[] = [];
  const next = produce(model, (draft) => {
    const d = draft.designs.find((x) => x.systemId === payload.systemId)!;
    removed = [...removeDesignScreens(d, (s) => ids.has(s.id))];
  });
  return { ok: true, model: next, removed };
}

export interface AddTransitionPayload {
  systemId: string;
  from: string;
  to: string;
  via?: Transition["via"];
  label?: string;
}

/** 遷移を足す。両端はサイトマップの画面で、同じ from / to の遷移はすでにあれば失敗 */
export function addTransition(model: UntieModel, payload: AddTransitionPayload): CommandResult<{ id: string }> {
  const ensured = ensureDesign(model, { systemId: payload.systemId });
  if (!ensured.ok) return ensured;
  const design = ensured.model.designs.find((d) => d.systemId === payload.systemId)!;
  const label = payload.label?.trim();
  const reason = checkTransition(
    { from: payload.from, to: payload.to, via: payload.via, label },
    new Set(design.screens.map((s) => s.id)),
    new Set(design.transitions.map((t) => `${t.from}\n${t.to}`)),
  );
  if (reason) return fail(reason);
  const id = newUniqueId("transition", usedDesignIds(ensured.model));
  const next = produce(ensured.model, (draft) => {
    draft.designs.find((d) => d.systemId === payload.systemId)!.transitions.push({
      id,
      from: payload.from,
      to: payload.to,
      ...(payload.via ? { via: payload.via } : {}),
      ...(label ? { label } : {}),
    });
  });
  return { ok: true, model: next, id };
}

export interface UpdateTransitionPayload {
  systemId: string;
  id: string;
  /** undefined は変えない。via の null は「未定」に戻す。label の null か空文字は文言を消す */
  patch: { via?: Transition["via"] | null; label?: string | null };
}

/** 遷移のきっかけ (via) と文言 (label) を変える。両端は変えられない (消して作り直す) */
export function updateTransition(model: UntieModel, payload: UpdateTransitionPayload): CommandResult {
  const design = existingDesign(model, payload.systemId);
  if (isFail(design)) return design;
  if (!design.transitions.some((t) => t.id === payload.id)) return fail(`遷移が存在しません: ${payload.id}`);
  const { via, label } = payload.patch;
  if (via !== undefined && via !== null && !TRANSITION_VIAS.includes(via)) return fail(`遷移のきっかけが正しくありません: ${via}`);
  const trimmed = label === undefined || label === null ? label : label.trim();
  if (trimmed) {
    const reason = checkLength("transitionLabel", trimmed);
    if (reason) return fail(reason);
  }
  const next = produce(model, (draft) => {
    const t = draft.designs.find((d) => d.systemId === payload.systemId)!.transitions.find((x) => x.id === payload.id)!;
    if (via === null) delete t.via;
    else if (via !== undefined) t.via = via;
    if (trimmed === null || trimmed === "") delete t.label;
    else if (trimmed !== undefined) t.label = trimmed;
  });
  return { ok: true, model: next };
}

export interface RemoveTransitionPayload {
  systemId: string;
  id: string;
}

/** 遷移を消す */
export function removeTransition(model: UntieModel, payload: RemoveTransitionPayload): CommandResult {
  const design = existingDesign(model, payload.systemId);
  if (isFail(design)) return design;
  if (!design.transitions.some((t) => t.id === payload.id)) return fail(`遷移が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    const d = draft.designs.find((x) => x.systemId === payload.systemId)!;
    d.transitions = d.transitions.filter((t) => t.id !== payload.id);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 要素

export interface AddElementPayload {
  kind: ElementKind;
  name: string;
  /** 指定するとそのボードに置く (課題は置けない) */
  boardId?: string;
  position?: Position;
  /** 枠の初期サイズ (省略時は既定) */
  size?: Size;
  init?: ElementInit;
  /** テスト用などで id を固定する */
  id?: string;
}

/** 要素を作る。業務なら既定 BUC も作る。boardId があればそのボードに置く */
export function addElement(model: UntieModel, payload: AddElementPayload): CommandResult<{ id: string }> {
  const { kind, boardId, init = {} } = payload;
  const name = payload.name.trim();

  const tooLong = firstLengthProblem(
    checkLength("name", name),
    init.description === undefined ? null : checkLength("description", init.description),
    init.group === undefined ? null : checkLength("group", init.group),
    init.values === undefined ? null : checkValues(init.values),
    init.verification === undefined ? null : checkLength("verification", init.verification),
  );
  if (tooLong) return fail(tooLong);

  if (boardId !== undefined) {
    if (!model.boards.some((b) => b.id === boardId)) return fail(`ボードが存在しません: ${boardId}`);
    if (kind === "issue") return fail("課題はボードに置けません");
  }
  if (payload.position && !isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);

  if (kind === "buc") {
    const biz = init.businessId ? findElement(model, init.businessId) : undefined;
    if (!biz || biz.kind !== "business") return fail("活動には所属する業務が必要です");
  }
  if (kind === "activity" && init.bucId) {
    const buc = findElement(model, init.bucId);
    if (!buc || buc.kind !== "buc") return fail(`所属先の活動が存在しません: ${init.bucId}`);
  }
  if (isSystemMemberKind(kind)) {
    const sys = init.systemId ? findElement(model, init.systemId) : undefined;
    if (!sys || sys.kind !== "system") return fail(`${kind === "screen" ? "画面" : "非機能要件"}には属するシステムが必要です`);
  }
  if (kind === "nfr" && init.category !== undefined && !NFR_CATEGORIES.includes(init.category)) return fail(`分類が不正です: ${init.category}`);
  if (isContextMemberKind(kind) && init.contextId) {
    const ctx = findElement(model, init.contextId);
    if (!ctx || ctx.kind !== "context") return fail(`所属先のコンテキストが存在しません: ${init.contextId}`);
  }
  if (kind === "issue") {
    const reason = checkIssueTargets(model, init.targetIds ?? []);
    if (reason) return fail(reason);
    if (init.severity !== undefined) {
      const sev = checkSeverity(init.severity);
      if (sev) return fail(sev);
    }
  }

  const used = usedIds(model);
  const id = payload.id ?? newUniqueId(kind, used);
  used.add(id);
  const description = init.description === undefined || init.description === "" ? {} : { description: init.description };

  let element: Element;
  switch (kind) {
    case "actor":
    case "externalActor":
    case "business":
    case "usecase":
    case "context":
    case "system":
    case "ledger":
      element = { id, kind, name, ...description };
      break;
    case "condition":
    case "event":
      element = { id, kind, name, contextId: init.contextId ?? null, ...description };
      break;
    case "screen":
      element = { id, kind, name, systemId: init.systemId!, ...description };
      break;
    case "nfr":
      element = {
        id,
        kind,
        name,
        systemId: init.systemId!,
        ...description,
        ...(init.category ? { category: init.category } : {}),
        ...(init.verification ? { verification: init.verification } : {}),
      };
      break;
    case "buc":
      element = { id, kind, name, businessId: init.businessId!, isDefault: false, ...description };
      break;
    case "activity":
      element = { id, kind, name, bucId: init.bucId ?? null, ...description };
      break;
    case "information":
      element = { id, kind, name, contextId: init.contextId ?? null, ...description };
      break;
    case "state":
      element = {
        id,
        kind,
        name,
        // 状態グループごとに同じコンテキストに属するので、同じグループの状態に合わせる
        contextId: init.contextId ?? (init.group ? stateGroupContext(model, init.group) : null),
        ...description,
        ...(init.group ? { group: init.group } : {}),
      };
      break;
    case "variation":
      element = { id, kind, name, values: [...(init.values ?? [])], contextId: init.contextId ?? null, ...description };
      break;
    case "issue":
      element = {
        id,
        kind,
        name,
        severity: init.severity ?? 3,
        targetIds: [...new Set(init.targetIds ?? [])],
        ...description,
      };
      break;
  }

  const defaultBucId = kind === "business" ? newUniqueId("buc", used) : null;

  const next = produce(model, (draft) => {
    draft.elements.push(element);
    if (defaultBucId) {
      draft.elements.push({ id: defaultBucId, kind: "buc", name, businessId: id, isDefault: true });
    }
    if (boardId !== undefined) {
      const board = draft.boards.find((b) => b.id === boardId)!;
      const pos = payload.position ?? { x: 0, y: 0 };
      const size = isFrameKind(kind) ? (payload.size ?? DEFAULT_FRAME_SIZE[kind]) : payload.size;
      board.nodes.push({ elementId: id, x: pos.x, y: pos.y, ...(size ?? {}) });
    }
  });
  return { ok: true, model: next, id };
}

export interface UpdateElementPayload {
  id: string;
  patch: ElementPatch;
}

/** 名前・説明・種類固有の項目を変える。所属 (bucId / businessId / contextId) は moveActivity / moveBuc / moveInformation で変える */
export function updateElement(model: UntieModel, payload: UpdateElementPayload): CommandResult {
  const target = findElement(model, payload.id);
  if (!target) return fail(`要素が存在しません: ${payload.id}`);
  const patch = payload.patch;

  if (target.kind === "buc" && target.isDefault && patch.name !== undefined) {
    return fail("既定の活動の名前は業務の名前と同じで、直接は変えられません");
  }

  const allowed = new Set<string>(["name", "description", ...PATCH_KEYS_BY_KIND[target.kind]]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return fail(`この要素では「${key}」を変更できません`);
  }
  const tooLong = firstLengthProblem(
    patch.name === undefined ? null : checkLength("name", patch.name.trim()),
    patch.description === undefined ? null : checkLength("description", patch.description),
    patch.group === undefined ? null : checkLength("group", patch.group),
    patch.values === undefined ? null : checkValues(patch.values),
    patch.verification === undefined ? null : checkLength("verification", patch.verification),
    patch.triggerNote === undefined ? null : checkLength("triggerNote", patch.triggerNote),
    ...(patch.analysis ? ISSUE_ANALYSIS_KEYS.map((key) => (patch.analysis![key] === undefined ? null : checkLength("analysis", patch.analysis![key]!.trim()))) : []),
  );
  if (tooLong) return fail(tooLong);
  if (patch.links !== undefined) {
    const reason = checkLinks(patch.links);
    if (reason) return fail(reason);
  }
  if (patch.hours !== undefined && patch.hours !== null) {
    const reason = checkHours(patch.hours);
    if (reason) return fail(reason);
  }
  if (patch.severity !== undefined) {
    const reason = checkSeverity(patch.severity);
    if (reason) return fail(reason);
  }
  if (patch.targetIds !== undefined) {
    const reason = checkIssueTargets(model, patch.targetIds);
    if (reason) return fail(reason);
  }
  if (patch.category !== undefined && patch.category !== null && !NFR_CATEGORIES.includes(patch.category)) return fail(`分類が不正です: ${patch.category}`);

  const next = produce(model, (draft) => {
    const el = draft.elements.find((e) => e.id === payload.id)!;
    if (patch.name !== undefined) {
      el.name = patch.name.trim();
      // 既定 BUC の名前は業務名と同じに保つ
      if (el.kind === "business") {
        const def = draft.elements.find((e) => e.kind === "buc" && e.isDefault && e.businessId === el.id);
        if (def) def.name = el.name;
      }
    }
    if (patch.description !== undefined) {
      if (patch.description === "") delete el.description;
      else el.description = patch.description;
    }
    if (el.kind === "state" && patch.group !== undefined) {
      if (patch.group === "") delete el.group;
      else {
        el.group = patch.group;
        // 既にあるグループへ移したら、そのグループのコンテキストに合わせる
        const other = model.elements.find((e) => e.kind === "state" && e.group === patch.group && e.id !== el.id);
        if (other && other.kind === "state") el.contextId = other.contextId;
      }
    }
    if (el.kind === "variation" && patch.values !== undefined) el.values = [...patch.values];
    if ((el.kind === "activity" || el.kind === "usecase") && patch.hours !== undefined) {
      if (patch.hours === null) delete el.hours;
      else el.hours = Math.round(patch.hours * 10) / 10;
    }
    if ((el.kind === "activity" || el.kind === "usecase") && patch.links !== undefined) {
      // 表示名が空なら URL を表示名にする (表示名の上限に収まるよう切り詰める)
      const links = patch.links.map((l) => ({ title: l.title.trim() || truncateText(l.url.trim(), LINK_TITLE_MAX_LENGTH), url: l.url.trim() }));
      if (links.length === 0) delete el.links;
      else el.links = links;
    }
    if (el.kind === "activity" && patch.triggerNote !== undefined) {
      if (patch.triggerNote.trim() === "") delete el.triggerNote;
      else el.triggerNote = patch.triggerNote;
    }
    if (el.kind === "nfr") {
      if (patch.category === null) delete el.category;
      else if (patch.category !== undefined) el.category = patch.category;
      if (patch.verification !== undefined) {
        if (patch.verification.trim() === "") delete el.verification;
        else el.verification = patch.verification;
      }
    }
    if (el.kind === "issue") {
      if (patch.severity !== undefined) el.severity = patch.severity;
      if (patch.targetIds !== undefined) el.targetIds = [...new Set(patch.targetIds)];
      if (patch.analysis === null) delete el.analysis;
      else if (patch.analysis !== undefined) {
        const analysis: IssueAnalysis = { ...el.analysis };
        for (const key of ISSUE_ANALYSIS_KEYS) {
          const v = patch.analysis[key];
          if (v === undefined) continue;
          if (v.trim() === "") delete analysis[key];
          else analysis[key] = v.trim();
        }
        if (Object.keys(analysis).length === 0) delete el.analysis;
        else el.analysis = analysis;
      }
    }
  });
  return { ok: true, model: next };
}

export interface RemoveElementPayload {
  id: string;
}

/** 要素と付随するもの (関係・ボードのノード・課題の対象・設計データ・業務なら BUC・システムなら画面と非機能要件) を消す */
export function removeElement(model: UntieModel, payload: RemoveElementPayload): CommandResult {
  const target = findElement(model, payload.id);
  if (!target) return fail(`要素が存在しません: ${payload.id}`);
  if (target.kind === "buc" && target.isDefault) return fail("既定の活動は削除できません");

  const next = produce(model, (draft) => {
    const removed = new Set<string>([payload.id]);

    if (target.kind === "business") {
      // 業務を消すと BUC は全て消え、所属アクティビティは未所属になる
      const bucIds = new Set(draft.elements.filter((e) => e.kind === "buc" && e.businessId === target.id).map((e) => e.id));
      for (const id of bucIds) removed.add(id);
      for (const e of draft.elements) {
        if (e.kind === "activity" && e.bucId && bucIds.has(e.bucId)) e.bucId = null;
      }
    } else if (target.kind === "system") {
      // システムを消すと、属する画面と非機能要件も消える
      for (const e of draft.elements) if (isSystemMemberKind(e.kind) && "systemId" in e && e.systemId === target.id) removed.add(e.id);
    } else if (target.kind === "context") {
      // コンテキストを消すと、所属していた要素は未分類になる
      for (const e of draft.elements) {
        if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId === target.id) e.contextId = null;
      }
    } else if (target.kind === "buc") {
      // 既定でない BUC を消すと、所属アクティビティは業務の既定 BUC に戻る
      const def = draft.elements.find(
        (e): e is Buc => e.kind === "buc" && e.isDefault && e.businessId === target.businessId,
      );
      for (const e of draft.elements) {
        if (e.kind === "activity" && e.bucId === target.id) e.bucId = def ? def.id : null;
      }
    }

    draft.elements = draft.elements.filter((e) => !removed.has(e.id));
    sweepReferences(draft, removed);
  });
  return { ok: true, model: next };
}

export interface MoveToSystemPayload {
  /** 画面か非機能要件 */
  elementId: string;
  systemId: string;
}

/** 画面・非機能要件の属するシステムを変える。画面なら、それを指す設計の画面と遷移・ナビゲーションの項目も外す */
export function moveToSystem(model: UntieModel, payload: MoveToSystemPayload): CommandResult {
  const target = findElement(model, payload.elementId);
  if (!target || !isSystemMemberKind(target.kind)) return fail(`画面・非機能要件が存在しません: ${payload.elementId}`);
  const sys = findElement(model, payload.systemId);
  if (!sys || sys.kind !== "system") return fail(`システムが存在しません: ${payload.systemId}`);
  if ("systemId" in target && target.systemId === payload.systemId) return { ok: true, model };
  const next = produce(model, (draft) => {
    const el = draft.elements.find((e) => e.id === payload.elementId);
    if (el && "systemId" in el) el.systemId = payload.systemId;
    // 設計の画面は同じシステムの画面しか指せないので、別のシステムへ移った画面を指すものは外す (removeElement と同じ範囲)
    if (target.kind === "screen") {
      for (const design of draft.designs) removeDesignScreens(design, (s) => s.source.kind === "screen" && s.source.screenId === payload.elementId);
    }
  });
  return { ok: true, model: next };
}

export interface MoveActivityPayload {
  activityId: string;
  /** null で未所属 */
  bucId: string | null;
}

/** アクティビティの所属 BUC を変える */
export function moveActivity(model: UntieModel, payload: MoveActivityPayload): CommandResult {
  const act = findElement(model, payload.activityId);
  if (!act || act.kind !== "activity") return fail(`作業が存在しません: ${payload.activityId}`);
  if (payload.bucId !== null) {
    const buc = findElement(model, payload.bucId);
    if (!buc || buc.kind !== "buc") return fail(`活動が存在しません: ${payload.bucId}`);
  }
  if (act.bucId === payload.bucId) return { ok: true, model };
  const next = produce(model, (draft) => {
    const a = draft.elements.find((e) => e.id === payload.activityId);
    if (a && a.kind === "activity") a.bucId = payload.bucId;
  });
  return { ok: true, model: next };
}

export interface MoveToContextPayload {
  /** 情報・状態・条件・バリエーション */
  elementId: string;
  /** null は未分類 */
  contextId: string | null;
}

/** 同じ状態グループの状態が属しているコンテキスト (無ければ null) */
function stateGroupContext(model: UntieModel, group: string): string | null {
  for (const e of model.elements) if (e.kind === "state" && e.group === group) return e.contextId;
  return null;
}

/**
 * 要素の所属コンテキストを変える。状態は状態グループごとに属するので、同じグループの状態もまとめて移す
 */
export function moveToContext(model: UntieModel, payload: MoveToContextPayload): CommandResult {
  const target = findElement(model, payload.elementId);
  if (!target || !isContextMemberKind(target.kind)) return fail(`コンテキストに属せない要素です: ${payload.elementId}`);
  if (payload.contextId !== null) {
    const ctx = findElement(model, payload.contextId);
    if (!ctx || ctx.kind !== "context") return fail(`コンテキストが存在しません: ${payload.contextId}`);
  }
  const group = target.kind === "state" ? target.group : undefined;
  const ids = new Set(
    group ? model.elements.filter((e) => e.kind === "state" && e.group === group).map((e) => e.id) : [target.id],
  );
  const members = model.elements.filter((e) => ids.has(e.id));
  if (members.every((e) => "contextId" in e && e.contextId === payload.contextId)) return { ok: true, model };
  const next = produce(model, (draft) => {
    for (const e of draft.elements) {
      if (ids.has(e.id) && "contextId" in e) e.contextId = payload.contextId;
    }
  });
  return { ok: true, model: next };
}

export interface MoveBucPayload {
  bucId: string;
  businessId: string;
}

/** BUC の所属業務を変える (所属アクティビティは BUC についていく) */
export function moveBuc(model: UntieModel, payload: MoveBucPayload): CommandResult {
  const buc = findElement(model, payload.bucId);
  if (!buc || buc.kind !== "buc") return fail(`活動が存在しません: ${payload.bucId}`);
  if (buc.isDefault) return fail("既定の活動の業務は変えられません");
  const biz = findElement(model, payload.businessId);
  if (!biz || biz.kind !== "business") return fail(`業務が存在しません: ${payload.businessId}`);
  if (buc.businessId === payload.businessId) return { ok: true, model };
  const next = produce(model, (draft) => {
    const b = draft.elements.find((e) => e.id === payload.bucId);
    if (b && b.kind === "buc") b.businessId = payload.businessId;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 関係

export interface AddRelationPayload {
  sourceId: string;
  targetId: string;
  id?: string;
}

/** 両端の種類から関係の種類を決めて関係を作る。不可なら失敗を返す */
export function addRelation(model: UntieModel, payload: AddRelationPayload): CommandResult<{ id: string }> {
  const { sourceId, targetId } = payload;
  if (sourceId === targetId) return fail("自分自身には線を引けません");
  const source = findElement(model, sourceId);
  const target = findElement(model, targetId);
  if (!source) return fail(`始点の要素が存在しません: ${sourceId}`);
  if (!target) return fail(`終点の要素が存在しません: ${targetId}`);
  const kind = relationKindFor(source.kind, target.kind);
  if (!kind) return fail("この組み合わせの要素は線で結べません");
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);

  const candidate = { kind, sourceId, targetId };
  if (model.relations.some((r) => sameRelation(r, candidate))) return fail("同じ関係がすでにあります");
  if (isUsecaseTargetKind(kind) && model.relations.some((r) => isUsecaseTargetKind(r.kind) && r.sourceId === sourceId)) {
    return fail(USECASE_TARGET_LIMIT_REASON);
  }

  const id = payload.id ?? newUniqueId("relation", usedIds(model));
  const next = produce(model, (draft) => {
    draft.relations.push({ id, kind, sourceId, targetId });
  });
  return { ok: true, model: next, id };
}

/** 操作の対象の関係 (システム・帳票 / 画面)。1 つの操作に合わせて 1 本まで (0.3.0) */
export function isUsecaseTargetKind(kind: string): kind is "usecaseSystem" | "usecaseScreen" {
  return kind === "usecaseSystem" || kind === "usecaseScreen";
}

export const USECASE_TARGET_LIMIT_REASON = "操作の対象は 1 つだけです。今の対象を外してから結んでください";

export interface SetUsecaseTargetPayload {
  usecaseId: string;
  /** システム・帳票・画面の id。null で対象を外す */
  targetId: string | null;
}

/** 操作の対象 (システム・帳票・画面のどれか 1 つ) を入れ替える。前の対象の関係は消す (入れ替えで 1 件の履歴) */
export function setUsecaseTarget(model: UntieModel, payload: SetUsecaseTargetPayload): CommandResult {
  const uc = findElement(model, payload.usecaseId);
  if (!uc || uc.kind !== "usecase") return fail(`操作が存在しません: ${payload.usecaseId}`);
  const current = model.relations.filter((r) => isUsecaseTargetKind(r.kind) && r.sourceId === uc.id);
  if (payload.targetId !== null) {
    const target = findElement(model, payload.targetId);
    if (!target || (target.kind !== "system" && target.kind !== "ledger" && target.kind !== "screen")) {
      return fail(`対象にできるのはシステム・帳票・画面です: ${payload.targetId}`);
    }
    if (current.length === 1 && current[0]!.targetId === payload.targetId) return { ok: true, model };
  } else if (current.length === 0) return { ok: true, model };
  let next = model;
  for (const r of current) {
    const removed = removeRelation(next, { id: r.id });
    if (!removed.ok) return removed;
    next = removed.model;
  }
  if (payload.targetId === null) return { ok: true, model: next };
  const added = addRelation(next, { sourceId: uc.id, targetId: payload.targetId });
  return added.ok ? { ok: true, model: added.model } : added;
}

export interface RemoveRelationPayload {
  id: string;
}

export function removeRelation(model: UntieModel, payload: RemoveRelationPayload): CommandResult {
  if (!model.relations.some((r) => r.id === payload.id)) return fail(`関係が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.relations = draft.relations.filter((r) => r.id !== payload.id);
    // ボードごとの線の見た目も一緒に消す
    for (const b of draft.boards) {
      if (!b.edges) continue;
      b.edges = b.edges.filter((e) => e.relationId !== payload.id);
      if (b.edges.length === 0) delete b.edges;
    }
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- ボード

export interface AddBoardPayload {
  name: string;
  id?: string;
}

export function addBoard(model: UntieModel, payload: AddBoardPayload): CommandResult<{ id: string }> {
  const tooLong = checkLength("boardName", payload.name.trim());
  if (tooLong) return fail(tooLong);
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);
  const id = payload.id ?? newUniqueId("board", usedIds(model));
  const next = produce(model, (draft) => {
    draft.boards.push({ id, name: payload.name.trim(), nodes: [] });
  });
  return { ok: true, model: next, id };
}

export interface RenameBoardPayload {
  id: string;
  name: string;
}

export function renameBoard(model: UntieModel, payload: RenameBoardPayload): CommandResult {
  const tooLong = checkLength("boardName", payload.name.trim());
  if (tooLong) return fail(tooLong);
  if (!model.boards.some((b) => b.id === payload.id)) return fail(`ボードが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.boards.find((b) => b.id === payload.id)!.name = payload.name.trim();
  });
  return { ok: true, model: next };
}

export interface RemoveBoardPayload {
  id: string;
}

/** ボードを消す。最後の 1 枚は消せない。ボード上にあった要素や関係は残る */
export function removeBoard(model: UntieModel, payload: RemoveBoardPayload): CommandResult {
  if (!model.boards.some((b) => b.id === payload.id)) return fail(`ボードが存在しません: ${payload.id}`);
  if (model.boards.length <= 1) return fail("最後の 1 枚のボードは削除できません");
  const next = produce(model, (draft) => {
    draft.boards = draft.boards.filter((b) => b.id !== payload.id) as typeof draft.boards;
  });
  return { ok: true, model: next };
}

export interface PlaceOnBoardPayload {
  boardId: string;
  elementId: string;
  position: Position;
  /** 枠の初期サイズ (省略時は既定) */
  size?: Size;
}

/** 要素をボードに置く。課題と既定 BUC は置けない。同じボードに 2 回は置けない */
export function placeOnBoard(model: UntieModel, payload: PlaceOnBoardPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  const el = findElement(model, payload.elementId);
  if (!el) return fail(`要素が存在しません: ${payload.elementId}`);
  if (el.kind === "issue") return fail("課題はボードに置けません");
  if (el.kind === "buc" && el.isDefault) return fail("既定の活動はボードに置けません");
  if (board.nodes.some((n) => n.elementId === el.id)) return fail("この要素はすでにこのボードにあります");
  if (!isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");

  const size = isFrameKind(el.kind) ? (payload.size ?? DEFAULT_FRAME_SIZE[el.kind]) : payload.size;
  const next = produce(model, (draft) => {
    draft.boards
      .find((b) => b.id === payload.boardId)!
      .nodes.push({ elementId: el.id, x: payload.position.x, y: payload.position.y, ...(size ?? {}) });
  });
  return { ok: true, model: next };
}

export interface RemoveFromBoardPayload {
  boardId: string;
  elementId: string;
}

/** ボードから外す (要素は残る) */
export function removeFromBoard(model: UntieModel, payload: RemoveFromBoardPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!board.nodes.some((n) => n.elementId === payload.elementId)) return fail("この要素はこのボードにありません");
  const next = produce(model, (draft) => {
    const b = draft.boards.find((x) => x.id === payload.boardId)!;
    b.nodes = b.nodes.filter((n) => n.elementId !== payload.elementId);
  });
  return { ok: true, model: next };
}

export interface MoveNodePayload {
  boardId: string;
  elementId: string;
  position: Position;
  size?: Size;
}

/** ノードの座標 (とサイズ) を変える */
export function moveNode(model: UntieModel, payload: MoveNodePayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!board.nodes.some((n) => n.elementId === payload.elementId)) return fail("この要素はこのボードにありません");
  if (!isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");
  const next = produce(model, (draft) => {
    const node = draft.boards.find((b) => b.id === payload.boardId)!.nodes.find((n) => n.elementId === payload.elementId)!;
    node.x = payload.position.x;
    node.y = payload.position.y;
    if (payload.size) {
      node.width = payload.size.width;
      node.height = payload.size.height;
    }
  });
  return { ok: true, model: next };
}

export interface SetEdgeSidesPayload {
  boardId: string;
  relationId: string;
  /** 既定 (right) に戻すなら undefined */
  sourceSide?: EdgeSide;
  /** 既定 (left) に戻すなら undefined */
  targetSide?: EdgeSide;
}

/** ボードごとの線の見た目 (どの辺から出て、どの辺に入るか) を変える。両方とも既定なら項目ごと消す */
export function setEdgeSides(model: UntieModel, payload: SetEdgeSidesPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!model.relations.some((r) => r.id === payload.relationId)) return fail(`関係が存在しません: ${payload.relationId}`);
  for (const side of [payload.sourceSide, payload.targetSide]) {
    if (side !== undefined && !EDGE_SIDES.includes(side)) return fail(`辺が不正です: ${side}`);
  }
  const sourceSide = payload.sourceSide === DEFAULT_EDGE_SIDES.sourceSide ? undefined : payload.sourceSide;
  const targetSide = payload.targetSide === DEFAULT_EDGE_SIDES.targetSide ? undefined : payload.targetSide;
  const next = produce(model, (draft) => {
    const b = draft.boards.find((x) => x.id === payload.boardId)!;
    const rest = (b.edges ?? []).filter((e) => e.relationId !== payload.relationId);
    if (sourceSide !== undefined || targetSide !== undefined) {
      rest.push({
        relationId: payload.relationId,
        ...(sourceSide !== undefined ? { sourceSide } : {}),
        ...(targetSide !== undefined ? { targetSide } : {}),
      });
    }
    if (rest.length > 0) b.edges = rest;
    else delete b.edges;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 課題・全体

export interface SetIssueTargetsPayload {
  issueId: string;
  targetIds: string[];
}

export function setIssueTargets(model: UntieModel, payload: SetIssueTargetsPayload): CommandResult {
  const issue = findElement(model, payload.issueId);
  if (!issue || issue.kind !== "issue") return fail(`課題が存在しません: ${payload.issueId}`);
  const reason = checkIssueTargets(model, payload.targetIds);
  if (reason) return fail(reason);
  const next = produce(model, (draft) => {
    const i = draft.elements.find((e) => e.id === payload.issueId);
    if (i && i.kind === "issue") i.targetIds = [...new Set(payload.targetIds)];
  });
  return { ok: true, model: next };
}

export interface ClearAllPayload {
  /** 空のボードの id (省略時は自動) */
  boardId?: string;
}

/** 要素・関係・ボードを全て消し、空のボード「ボード 1」だけにする (メタ情報は残す) */
export function clearAll(model: UntieModel, payload: ClearAllPayload = {}): CommandResult {
  const next = produce(model, (draft) => {
    draft.elements = [];
    draft.relations = [];
    draft.designs = [];
    draft.databases = [];
    draft.boards = [{ id: payload.boardId ?? newUniqueId("board", new Set()), name: "ボード 1", nodes: [] }];
  });
  return { ok: true, model: next };
}
