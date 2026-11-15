// 「ソースコードから作成」の段階 3: 業務。利用者が書いた「モデルに起こしたい業務」について、AI が処理のソース (ハンドラー・サービス・ジョブ) を調べ、
// すでにあるシステム・画面・データベースのテーブルを材料にして、業務・活動・作業・操作・登場人物・情報・状態・条件・バリエーション・イベントを開いているモデルに足す。
// 操作と画面を結び (1 画面 = 1 操作、1 操作の対象は 1 つ)、テーブルと情報の対応を付ける。
//
// 失敗・中断したときは、この段階で足したものを残さない (結果は最後に 1 回で返す。呼ぶ側が 1 件の履歴として反映する)。
// 画面の段階を飛ばしたとき (画面が無い): 業務に関わる画面だけを AI が足す (画面 UI は作らない。画面の段階で作る)。
// データの段階を飛ばしたとき (テーブルが無い): 対応は付けず、気づいたことでデータの段階を案内する。
import { setTableInformation } from "@untie/core/model/commands";
import { checkDesign } from "@untie/core/model/designCheck";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { systemInformationIds } from "@untie/core/model/designData";
import { traceToActors } from "@untie/core/model/trace";
import { ELEMENT_KIND_LABELS, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { ChatError, type SeedTurn } from "./chat";
import { applyDatabaseUse, readDatabaseUse, tableNamesOf, unmappedTableNames, USE_DATABASE_TOOL } from "./designDraft";
import { summarizeCounts } from "./generate";
import {
  acceptedOutcome,
  designWarningLines,
  elementName,
  errorOutcome,
  logicBudget,
  mappingLimits,
  okOutcome,
  openSession,
  REVERSE_LIMITS,
  revisionNote,
  sourceLimits,
  stageFailure,
  surveyCollector,
  throwIfAborted,
  trackUsage,
  type Ctx,
  type StageOptions,
  type StageUsageSummary,
} from "./reverse";
import { addScreensToDesign } from "./reverseScreens";
import { clipSurvey, FINISH_NOTE, reverseLogicModelRequest, reverseLogicSurveyRequest, reverseSystemPrompt, reverseTableMapRequest, wrapSurvey, type MappingPlan } from "./reversePrompts";
import type { ScreenSurvey } from "./surveyMemory";
import { combineSourceTrees, isMultiSourceTree, sourcesTitle, visibleFiles, type LabeledSource, type SourceTree } from "./sourceTree";
import { executeGetTable, GET_TABLE_TOOL } from "./reverseTables";
import { buildModelFromSpec, nameKey, SUBMIT_MODEL_TOOL, type BuildResult, type ModelSpec } from "./spec";
import type { ToolDef, ToolOutcome } from "./tools";

/** 業務の段階の会話が、どれも同じ道具の定義を持つ (調査・業務のモデル・テーブルの対応。reverseScreens.ts の STAGE_TOOLS と同じ理由) */
const STAGE_TOOLS: ToolDef[] = [SUBMIT_MODEL_TOOL, USE_DATABASE_TOOL, GET_TABLE_TOOL];

export interface LogicOptions extends StageOptions {
  /** 画面の段階の調査結果 (覚えているとき。無ければ、今までどおり、ソースを調べる) */
  previousSurvey?: ScreenSurvey | null;
}

export interface LogicResult {
  /** 足したあとのモデル */
  model: UntieModel;
  /** このとき新しく足した要素の数と、情報とテーブルの対応を付けた情報の数 */
  added: BuildResult["added"];
  mappedInformations: number;
  survey: string;
  warnings: string[];
  seed: SeedTurn[];
  /** 結果の文 (気づいたことを含む。エージェントへの引き継ぎに使う) */
  summary: string;
  /** 結果の文から、気づいたことを除いたもの */
  headline: string;
  /** 段階の AI の使用量の合計 (API が使用量を返さなかったときは null) */
  usage: StageUsageSummary | null;
}

/**
 * システムの対応付けの対象にするデータベースの id (DSL にテーブルのあるもの)。設計があるシステムは、設計が実際に使うデータベース (effectiveDatabaseIds)。
 * 設計がまだ無いシステム (画面を持たない・画面の段階がまだ) と、設計の使うデータベースにテーブルが無いシステムは、使うデータベースがまだ決まっていないので、
 * テーブルのあるデータベースすべて (AI が選ぶ。選んだデータベースが、設計の使うデータベースになる)
 */
export function systemDatabaseIds(model: UntieModel, systemId: string): string[] {
  return systemDatabaseChoice(model, systemId).ids;
}

/** systemDatabaseIds と、設計が使うデータベースをすでに決めているか (false なら、AI が選んだものが設計の使うデータベースになる) */
function systemDatabaseChoice(model: UntieModel, systemId: string): { ids: string[]; chosen: boolean } {
  const design = model.designs.find((d) => d.systemId === systemId);
  const used = design ? effectiveDatabaseIds(model, design).filter((id) => hasTables(model, id)) : [];
  return used.length > 0 ? { ids: used, chosen: true } : { ids: mappableDatabaseIds(model), chosen: false };
}

const hasTables = (model: UntieModel, id: string): boolean => {
  const db = model.databases.find((d) => d.id === id);
  return !!db && tableNamesOf(db).length > 0;
};

/** テーブルのあるデータベースすべての id */
export function mappableDatabaseIds(model: UntieModel): string[] {
  return model.databases.filter((d) => hasTables(model, d.id)).map((d) => d.id);
}

/** システムが使う情報のうち、対応付けの対象のデータベース (systemDatabaseIds) のどのテーブルにも対応していないものの id */
export function unmappedInSystem(model: UntieModel, systemId: string): string[] {
  const dbs = systemDatabaseIds(model, systemId).map((id) => model.databases.find((d) => d.id === id)!);
  const mapped = new Set(dbs.flatMap((d) => d.tables.flatMap((t) => t.informationIds)));
  return systemInformationIds(model, systemId).filter((id) => !mapped.has(id));
}

/** どのシステムにも使われていない (どの操作も扱っていない) 情報 (名前のあるもの) の id */
function unusedInformationIds(model: UntieModel): string[] {
  const used = new Set(model.elements.filter((e) => e.kind === "system").flatMap((e) => systemInformationIds(model, e.id)));
  return model.elements.filter((e) => e.kind === "information" && e.name.trim() !== "" && !used.has(e.id)).map((e) => e.id);
}

/** テーブルのあるデータベースの、どこかのテーブルに対応している情報の id */
function mappedInformationIds(model: UntieModel): Set<string> {
  return new Set(mappableDatabaseIds(model).flatMap((id) => model.databases.find((d) => d.id === id)!.tables.flatMap((t) => t.informationIds)));
}

/** どのシステムにも使われていない情報のうち、どのテーブルにも対応していないもの (テーブルのあるデータベースが無ければ空)。システムごとの対応の対象から漏れるものを、対応の対象に入れるため */
export function unusedUnmappedInformationIds(model: UntieModel): string[] {
  if (mappableDatabaseIds(model).length === 0) return [];
  const mapped = mappedInformationIds(model);
  return unusedInformationIds(model).filter((id) => !mapped.has(id));
}

/** まだどのテーブルにも対応していない情報の id: システムが使うもの (そのシステムが使うデータベースで見る) と、どのシステムにも使われていないもの */
export function unmappedInformationIds(model: UntieModel): Set<string> {
  return new Set([...model.elements.filter((e) => e.kind === "system").flatMap((e) => unmappedInSystem(model, e.id)), ...unusedUnmappedInformationIds(model)]);
}

/** 未対応の組: (システム, 情報) と、どのシステムにも使われていない情報。システムごとに数えるので、同じ情報が複数のシステムで未対応でも、組は別 */
function unmappedPairs(model: UntieModel): Set<string> {
  return new Set([
    ...model.elements.filter((e) => e.kind === "system").flatMap((e) => unmappedInSystem(model, e.id).map((id) => `${e.id}:${id}`)),
    ...unusedUnmappedInformationIds(model).map((id) => `-:${id}`),
  ]);
}

/** 未対応の組が減った情報の数 (before にあって after に無い組のある、情報の数。実際に未対応が減ったものだけ。別のテーブルにすでに結ばれていた・そのシステムが使わないデータベースへの対応は、減らさない) */
function reducedInformations(before: ReadonlySet<string>, after: ReadonlySet<string>): number {
  return new Set([...before].filter((p) => !after.has(p)).map((p) => p.slice(p.indexOf(":") + 1))).size;
}

/**
 * テーブルと情報の対応の、すきま: どのテーブルにも対応していない情報 (システムが使うもの (システムごとの重複を除く) と、どのシステムにも使われていないもの) と、
 * どの情報にも対応していないテーブル (テーブルのあるデータベース) の数。systems は、対応していない情報を持つシステムの数
 */
export function mappingGap(model: UntieModel): { informations: number; tables: number; systems: number } {
  const infos = new Set<string>(unusedUnmappedInformationIds(model));
  let systems = 0;
  for (const sys of model.elements.filter((e) => e.kind === "system")) {
    if (systemDatabaseIds(model, sys.id).length === 0) continue;
    const left = unmappedInSystem(model, sys.id);
    if (left.length > 0) systems++;
    for (const id of left) infos.add(id);
  }
  const tables = model.databases.reduce((n, d) => n + unmappedTableNames(d).length, 0);
  return { informations: infos.size, tables, systems };
}

/**
 * テーブルの DSL の中の、model の直前に続くコメントの行 (テーブルの名前 → 行の並び)。`///` の説明も、SQL の変換が書き出す `// 顧客`
 * (COMMENT ON TABLE・MySQL の COMMENT='…') も読む。空行をはさんだ、もっと前のコメントは読まない
 */
function tableDocComments(dsl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let docs: string[] = [];
  for (const line of dsl.split("\n")) {
    const doc = /^\s*\/\/\/?\s?(.*)$/.exec(line);
    if (doc) {
      docs.push(doc[1]!.trim());
      continue;
    }
    const m = /^\s*model\s+(\w+)\s*\{/.exec(line);
    if (m) out.set(m[1]!, docs);
    docs = [];
  }
  return out;
}

export interface MappingSuggestion {
  databaseId: string;
  databaseName: string;
  table: string;
  informationId: string;
  informationName: string;
  /** 何が一致したか */
  via: "テーブルの名前" | "もとの名前" | "テーブルの説明";
}

/**
 * 名前が明らかに合う、テーブルと情報の組 (AI を使わずに結ぶ候補)。まだどの情報にも結ばれていないテーブルだけが対象で、
 * 突き合わせの鍵 (NFKC・小文字・空白の削除) で、テーブルの名前・`@@map` のもとの名前・テーブルの説明 (model の直前の `//`・`///` の行) のどれかと、情報の名前が一致するもの。
 * 1 つの情報に複数のテーブルが合うとき、1 つのテーブルに複数の情報が合うときも、全部を候補にする (利用者が見て決める)
 */
export function suggestMappings(model: UntieModel): MappingSuggestion[] {
  const infos = model.elements.filter((e) => e.kind === "information" && e.name.trim() !== "");
  const byKey = new Map<string, typeof infos>();
  for (const i of infos) byKey.set(nameKey(i.name), [...(byKey.get(nameKey(i.name)) ?? []), i]);
  const out: MappingSuggestion[] = [];
  for (const db of model.databases) {
    const schema = parsePrismaDslCached(db.dsl);
    const docs = tableDocComments(db.dsl);
    const mapped = new Set(db.tables.filter((t) => t.informationIds.length > 0).map((t) => t.table));
    for (const m of schema.models) {
      if (mapped.has(m.name)) continue;
      const found = new Map<string, MappingSuggestion>();
      const tryName = (name: string | undefined, via: MappingSuggestion["via"]) => {
        if (!name || nameKey(name) === "") return;
        for (const info of byKey.get(nameKey(name)) ?? []) if (!found.has(info.id)) found.set(info.id, { databaseId: db.id, databaseName: db.name, table: m.name, informationId: info.id, informationName: info.name, via });
      };
      tryName(m.name, "テーブルの名前");
      tryName(m.mapName, "もとの名前");
      for (const line of docs.get(m.name) ?? []) tryName(line, "テーブルの説明");
      out.push(...found.values());
    }
  }
  return out;
}

/** 候補を結ぶ (すでにある対応は消さず、足す)。結べたものの数 */
export function applyMappingSuggestions(model: UntieModel, suggestions: readonly MappingSuggestion[]): { model: UntieModel; applied: number } {
  let next = model;
  let applied = 0;
  for (const s of suggestions) {
    const current = next.databases.find((d) => d.id === s.databaseId)?.tables.find((t) => t.table === s.table)?.informationIds ?? [];
    if (current.includes(s.informationId)) continue;
    const r = setTableInformation(next, { id: s.databaseId, table: s.table, informationIds: [...current, s.informationId] });
    if (r.ok) {
      next = r.model;
      applied++;
    }
  }
  return { model: next, applied };
}

export interface TableMapResult {
  model: UntieModel;
  /** 新しくテーブルに結べた情報の数 */
  mappedInformations: number;
}

/**
 * テーブルと情報の対応を付ける対象 (無ければ null)。モデルのすべての情報のうち、システムが使うものでまだ対応のないもの (unmappedInSystem) と、
 * どのシステムにも使われていないもの (unusedUnmappedInformationIds) を、テーブルのあるすべてのデータベースに対して、1 つの会話で扱う。
 * 対応を付けられる情報か、テーブルのあるデータベースが無ければ null (会話を開かない)。名前が合うもの (suggestMappings) は、候補として添える
 */
export function planMapping(model: UntieModel): MappingPlan | null {
  const databaseIds = mappableDatabaseIds(model);
  if (databaseIds.length === 0) return null;
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const brief = (id: string) => ({ name: byId.get(id)?.name ?? "", ...(byId.get(id)?.description ? { description: byId.get(id)!.description } : {}) });
  const systems = model.elements
    .filter((e) => e.kind === "system")
    .flatMap((e) => {
      const left = unmappedInSystem(model, e.id);
      if (left.length === 0) return [];
      const choice = systemDatabaseChoice(model, e.id);
      return [{ id: e.id, name: e.name, databases: choice.ids.map((id) => model.databases.find((d) => d.id === id)!.name), chosen: choice.chosen, informations: left.map(brief) }];
    });
  const unused = unusedUnmappedInformationIds(model).map(brief);
  if (systems.length === 0 && unused.length === 0) return null;
  const screens = model.elements.filter((e) => e.kind === "screen" && systems.some((s) => s.id === e.systemId));
  const hint = [...systems.flatMap((s) => s.informations), ...unused].flatMap((i) => [i.name, i.description ?? ""]).concat(screens.flatMap((e) => [e.name, e.description ?? ""])).join("\n");
  const unmappedTables = databaseIds.flatMap((id) => {
    const db = model.databases.find((d) => d.id === id)!;
    return unmappedTableNames(db).map((t) => (databaseIds.length > 1 ? `${db.name}.${t}` : t));
  });
  const suggestions = suggestMappings(model).map((x) => ({ database: x.databaseName, table: x.table, information: x.informationName, via: x.via }));
  return { systems: systems.map((x) => ({ name: x.name, databases: x.databases, chosen: x.chosen, informations: x.informations })), unused, databaseIds, suggestions, hint, unmappedTables };
}

/**
 * テーブルと情報の対応を、1 つの会話で付ける (業務の段階の最後と、対応付けだけの入口で共通)。対象は planMapping のとおり。
 * AI は use_database でデータベースごとに答え (システムごとに、使うデータベースが決まる)、列を知りたいテーブルは get_table で調べる。
 * システムが使うデータベースは、これまでの規則のまま (設計が実際に使うデータベースに絞る。決まっていないシステムは、選んだものが設計の使うデータベースになる)。
 * 対象が無ければ会話を開かない。ctx.budget は呼ぶ側が決めておく
 */
async function mapTablesAndInformations(args: { model: UntieModel; ctx: Ctx; system: string; seed: SeedTurn[]; nSources: number; warnings: string[] }): Promise<TableMapResult> {
  const { ctx, system, seed, nSources, warnings } = args;
  const o = ctx.o;
  let model = args.model;
  const plan = planMapping(model);
  if (!plan) return { model, mappedInformations: 0 };
  // 対応を付けるシステムが多いほど、調べる列も増えるので、会話ごとの上限を増やす
  const lim = mappingLimits(nSources, plan.systems.length);
  const before = unmappedPairs(model);
  const dbIds = plan.databaseIds;
  let calls = 0;
  let used = false;
  /** 出し直しの案内を返した回数 (内容 = 対応のない情報とテーブルの一覧ごと)。同じ内容は、未対応が減らないまま促し続けない */
  const nudged = new Map<string, number>();
  const dbNames = (ids: readonly string[]) => ids.map((id) => model.databases.find((d) => d.id === id)?.name ?? "").filter((n) => n !== "");
  /** 出し直しの案内に添える、対応のすきま: どのテーブルにも結ばれていない情報 (システムが使うものと、どのシステムにも使われていないもの) と、どの情報にも結ばれていないテーブル */
  const gap = (databaseId: string): { lines: string[]; any: boolean } => {
    const infos = [...unmappedInformationIds(model)].map((id) => elementName(model, id));
    const db = model.databases.find((d) => d.id === databaseId);
    const tables = db ? unmappedTableNames(db) : [];
    const lines: string[] = [];
    if (tables.length > 0) lines.push(`「${db!.name}」の DSL にあるテーブルのうち、どの情報にも結ばれていないもの: ${tables.slice(0, 20).join("、")}${tables.length > 20 ? " ほか" : ""}`);
    if (infos.length > 0) lines.push(`どのテーブルにも結ばれていない情報: ${infos.slice(0, 20).join("、")}${infos.length > 20 ? " ほか" : ""}`);
    return { lines, any: infos.length > 0 };
  };
  const useDatabase = (input: unknown): ToolOutcome => {
    const draft = readDatabaseUse(input);
    if (!draft) return errorOutcome("database・tables が必要です (system は省いてよい)");
    if (calls >= REVERSE_LIMITS.mappingCalls) return okOutcome(`これ以上は答えられません (${REVERSE_LIMITS.mappingCalls} 回まで)。このまま受け付けています。${FINISH_NOTE}`, false);
    // system を書いたときは、そのシステムが使えるデータベースの中から選ぶ。省いたときは、テーブルのあるデータベースすべて
    const sys = draft.system !== undefined ? model.elements.find((e) => e.kind === "system" && nameKey(e.name) === nameKey(draft.system!)) : undefined;
    if (draft.system !== undefined && !sys) return errorOutcome(`システム「${draft.system}」はモデルにありません。上の「システムと、対応のない情報」にあるシステムの名前を書くか、system を省いてください`);
    const allowed = sys ? systemDatabaseChoice(model, sys.id).ids : dbIds;
    const wanted = draft.database.trim();
    const target = allowed.map((id) => model.databases.find((d) => d.id === id)).find((d) => d && (d.id === wanted || nameKey(d.name) === nameKey(wanted)));
    if (!target) {
      return errorOutcome(`データベース「${draft.database}」は、${sys ? `システム「${sys.name}」が使う` : "対象の"}データベースにありません。次のどれかの名前で指してください: ${dbNames(allowed).map((n) => `「${n}」`).join("")}`);
    }
    // system を省いたとき、結べるのは、どのシステムにも使われていない情報だけ。システムが使う情報は、そのシステムが使うデータベースに結ばせる
    // (使わないデータベースに結ぶと、対応づいたように見えて、そのシステムの対応は付かないまま残る)
    const refused: string[] = [];
    let tables = draft.tables;
    if (!sys) {
      const ownerOf = new Map<string, string>();
      for (const e of model.elements) if (e.kind === "system") for (const id of systemInformationIds(model, e.id)) if (!ownerOf.has(id)) ownerOf.set(id, e.name);
      const infoByName = new Map<string, string>();
      for (const e of model.elements) if (e.kind === "information" && !infoByName.has(e.name)) infoByName.set(e.name, e.id);
      tables = draft.tables.map((t) => ({
        ...t,
        informations: t.informations.filter((n) => {
          const id = infoByName.get(n.trim());
          const owner = id !== undefined ? ownerOf.get(id) : undefined;
          if (owner === undefined) return true;
          const line = `情報「${n.trim()}」はシステム「${owner}」が使っています。system を書いて、そのシステムが使うデータベースに結んでください`;
          if (!refused.includes(line)) refused.push(line);
          return false;
        }),
      }));
      if (refused.length > 0 && tables.every((t) => t.informations.length === 0)) return errorOutcome(`結べませんでした:\n- ${refused.join("\n- ")}`);
    }
    calls++;
    const unmappedBefore = unmappedPairs(model);
    const r = applyDatabaseUse(model, { ...draft, tables, ...(sys ? { system: sys.name } : {}), database: target.id });
    if (!r.applied) return errorOutcome(`${r.failure ?? "データベースを使えませんでした"}。直して出し直してください`);
    model = r.model;
    used = true;
    // 未対応の情報が、実際にいくつ減ったか (別のテーブルにすでに結ばれていた情報や、そのシステムが使わないデータベースへの対応は数えない)
    const reduced = reducedInformations(unmappedBefore, unmappedPairs(model));
    const message = `受け付けました: データベース「${target.name}」${sys ? `をシステム「${sys.name}」が使います` : "の対応を足しました"} (対応を足したテーブル ${r.added.tables}、未対応が減った情報 ${reduced})`;
    o.onSubmit?.(true, message);
    const retriesLeft = REVERSE_LIMITS.mappingCalls - calls;
    const g = gap(target.id);
    const others = r.warnings.filter((w) => !/がどのテーブルにも対応していません/.test(w));
    const note = revisionNote(others, retriesLeft, "use_database", "");
    const refusedNote = refused.length > 0 ? `\n次の情報は結びませんでした:\n- ${refused.join("\n- ")}` : "";
    // 出し直しを促すのは、同じ内容 (対応のない情報とテーブルの一覧) で 2 回まで。減っていないのに促し続けない
    const nudgeKey = g.lines.join("\n");
    if (g.any && retriesLeft > 0 && (nudged.get(nudgeKey) ?? 0) < REVERSE_LIMITS.mappingNudges) {
      nudged.set(nudgeKey, (nudged.get(nudgeKey) ?? 0) + 1);
      return okOutcome(
        `${message}${note}${refusedNote}\n${g.lines.join("\n")}\nテーブルが DSL にあるのに対応が無い情報は、tables に足して use_database を出し直してください (足した対応は残ります)。ほかのシステム・データベースの分も続けて答えてください。対応するテーブルがソースに無い情報だけ、直さなくてかまいません (あと ${retriesLeft} 回まで)`,
        true,
      );
    }
    // 受け付けて、AI に返す気づいたこと (出し直してよいという案内・結ばなかった情報) が無ければ、会話を終えてよい
    const text = `${message}${note}${refusedNote}\n${FINISH_NOTE}`;
    return refused.length === 0 && (note === "" || retriesLeft <= 0) ? acceptedOutcome(text, true) : okOutcome(text, true);
  };
  try {
    const session = openSession(ctx, {
      label: "テーブルの対応",
      system,
      stageTools: STAGE_TOOLS,
      cap: { ...lim, finish: "submit" },
      handlers: { use_database: useDatabase, get_table: (input) => executeGetTable(model, dbIds, input) },
      seed,
      counted: ["get_table"],
      unavailable: "いまはテーブルと情報の対応を答える会話です (use_database)。業務のモデルは、すでに作ってあります。",
    });
    await session.send(reverseTableMapRequest(model, plan), {}, o.signal);
    throwIfAborted(o.signal);
    if (!used) {
      await session.send("use_database で、テーブルと情報の対応を答えてください (対応するテーブルが無ければ、tables を空にして答えてください)。", {}, o.signal);
      throwIfAborted(o.signal);
    }
  } catch (e) {
    const failure = stageFailure(e, o.signal);
    if (!failure) throw e;
    warnings.push(`データ: テーブルと情報の対応を付ける会話が失敗しました: ${failure.message}`);
  }
  // 対応づいた情報の数は、実際に未対応が減った情報の数
  return { model, mappedInformations: reducedInformations(before, unmappedPairs(model)) };
}

/** テーブルと情報の対応の結果のあとの、残りの気づいたこと (対応していない情報) */
function leftoverMappingWarnings(model: UntieModel): string[] {
  const out: string[] = [];
  for (const sys of model.elements.filter((e) => e.kind === "system")) {
    if (systemDatabaseIds(model, sys.id).length === 0) continue;
    const left = unmappedInSystem(model, sys.id);
    if (left.length > 0) {
      out.push(`データ: システム「${sys.name}」の情報 ${left.length} 件がどのテーブルにも対応していません (${left.slice(0, 3).map((id) => `「${elementName(model, id)}」`).join("")}${left.length > 3 ? " ほか" : ""})。データボードで結んでください`);
    }
  }
  return out;
}

/**
 * 業務の段階を実行する。base は今のモデル (これに足した新しいモデルを返す。base は変えない)。
 * 失敗・中断は例外で、そのとき足したものは返らない
 */
export async function reverseLogic(base: UntieModel, source: SourceTree | readonly LabeledSource[], request: string, options: LogicOptions): Promise<LogicResult> {
  const usage = trackUsage(options);
  const o = usage.options;
  const tree: SourceTree = "files" in source ? source : combineSourceTrees(source);
  const multi = isMultiSourceTree(tree);
  const nSources = tree.sources?.length ?? 1;
  const lim = sourceLimits(nSources);
  const ctx: Ctx = { tree, o, budget: { ...logicBudget(0, nSources), usedCalls: 0, usedChars: 0 } };
  const system = reverseSystemPrompt(multi, "logic");
  const warnings: string[] = [];
  const baseIds = new Set(base.elements.map((e) => e.id));

  // ---- 1. 調査 ----
  throwIfAborted(o.signal);
  o.onStep?.("survey");
  // 画面の段階の調査結果を覚えているときは、それを渡して、そこに無いことだけを調べさせる (覚えていなければ、今までどおり調べる)
  const previous = options.previousSurvey && options.previousSurvey.survey.trim() !== "" ? options.previousSurvey : null;
  const surveyRequest = reverseLogicSurveyRequest(request, base, tree.name, visibleFiles(tree).length, tree.sources, previous, REVERSE_LIMITS.previousSurveyChars);
  const surveySession = openSession(ctx, {
    label: "調査",
    system,
    stageTools: STAGE_TOOLS,
    cap: { ...lim.survey, finish: "survey" },
    handlers: {},
    seed: [],
    unavailable: "いまは調査の会話です。ソースコードを読んで、調査結果を文章で書いてください (提出は、調査のあとの会話で求めます)。",
  });
  const collector = surveyCollector(o.onText);
  let lastReply = "";
  try {
    lastReply = (await surveySession.send(surveyRequest, collector.events, o.signal)).trim();
  } catch (e) {
    throwIfAborted(o.signal);
    if (!(e instanceof ChatError) || o.signal?.aborted || collector.text() === "") throw e;
    warnings.push(`調査: 会話が途中で終わりました (${e.message})。集まった調査結果で進めました`);
  }
  throwIfAborted(o.signal);
  const survey = collector.text() || lastReply;
  if (survey === "") throw new ChatError("AI がソースコードの調査結果を返しませんでした。もう一度試してください。");
  const seedOf = (maxChars: number): SeedTurn[] => [
    { role: "user", text: surveyRequest },
    { role: "assistant", text: wrapSurvey(clipSurvey(survey, maxChars)) },
  ];
  const modelSeed = seedOf(REVERSE_LIMITS.surveyModelChars);
  const stageSeed = seedOf(REVERSE_LIMITS.surveySeedChars);

  // ---- 2. 業務のモデル (すでにあるモデルに足す) ----
  throwIfAborted(o.signal);
  o.onStep?.("model");
  let accepted: BuildResult | null = null;
  let attempts = 0;
  /** 「画面・イベントが無い」の注意は 1 度だけ出す (本当に無ければそのまま提出し直してよいと伝えてあるので、2 回目は断らない) */
  let nudged = false;
  /** 形の違う提出を断った数 (上限で打ち切る。往復の上限まで同じ断りを続けさせない) */
  let rejected = 0;
  let gaveUp = false;
  const reject = (outcome: ToolOutcome): ToolOutcome => {
    rejected++;
    if (rejected > REVERSE_LIMITS.submitRejections) {
      gaveUp = true;
      return okOutcome(`提出が続けて受け付けられなかったので、見送ります。これ以上は受け付けません。${FINISH_NOTE}`, false);
    }
    return outcome;
  };
  const submitModel = (input: unknown): ToolOutcome => {
    if (accepted) return okOutcome(`すでに受け付けました。${FINISH_NOTE}`, false);
    if (gaveUp) return okOutcome(`提出は見送りました。これ以上は受け付けません。${FINISH_NOTE}`, false);
    attempts++;
    const spec = (input && typeof input === "object" ? input : {}) as unknown as ModelSpec;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.businesses)) return reject(errorOutcome("businesses の一覧が必要です"));
    // 毎回、受け取ったときのモデルから組み立てる (出し直しで二重に足さない)
    const build = buildModelFromSpec(spec, { base });
    const validation = validateModel(JSON.parse(JSON.stringify(build.model)));
    if (!validation.ok) return reject({ ...errorOutcome("モデルの検査で問題がありました"), content: JSON.stringify({ error: "モデルの検査で問題がありました", details: validation.errors.slice(0, 20) }) });
    // 担い手まで辿れない要素も直してもらう (すでにあった要素のものは、この提出では直せないので数えない)
    const trace = traceToActors(build.model).problems.filter((p) => p.isBreak && !baseIds.has(p.elementId));
    const byId = new Map(build.model.elements.map((e) => [e.id, e]));
    const issues: { text: string; brief: string }[] = [
      ...build.warnings.map((w) => ({ text: w, brief: w })),
      ...trace.map((p) => {
        const e = byId.get(p.elementId)!;
        const text = `${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」: ${p.reason}`;
        return { text, brief: text };
      }),
    ];
    if (!nudged) {
      const missing: { text: string; brief: string }[] = [];
      if (!build.counts.screen) missing.push({ text: "画面が 1 つもありません。ソースコードに画面 (ルート・テンプレート・コンポーネント) があれば、screens に書いてください (本当に無ければ、そのまま提出し直してください)", brief: "画面がまだ無い" });
      if (!build.counts.event) missing.push({ text: "イベントが 1 つもありません。人が担当しない処理 (バッチ・ジョブ・webhook・イベントハンドラー) があれば、events に書いてください (本当に無ければ、そのまま提出し直してください)", brief: "イベントがまだ無い" });
      if (missing.length > 0) {
        nudged = true;
        issues.push(...missing);
      }
    }
    if (issues.length > 0 && attempts <= REVERSE_LIMITS.strictModelAttempts) {
      const message = `次の点を直して、モデルの下書き全体をもう一度提出してください:\n- ${issues.slice(0, 30).map((i) => i.text).join("\n- ")}`;
      const first = issues[0]!.brief.length > 40 ? `${issues[0]!.brief.slice(0, 40)}…` : issues[0]!.brief;
      o.onSubmit?.(false, `業務のモデルを直してもらっています (${first}${issues.length > 1 ? ` など ${issues.length} 件` : ""})`);
      return errorOutcome(message);
    }
    accepted = build;
    const message = `受け付けました: ${summarizeCounts(build.added)} を足します${issues.length > 0 ? ` (気づいたこと ${issues.length} 件は残っています)` : ""}`;
    o.onSubmit?.(true, message);
    // 受け付けたあとの出し直しは無い (気づいたことが残っていても、AI には返さない) ので、会話を終えてよい
    return acceptedOutcome(`${message}。${FINISH_NOTE}`, true);
  };
  const modelSession = openSession(ctx, {
    label: "業務のモデル",
    system,
    stageTools: STAGE_TOOLS,
    cap: { ...lim.model, finish: "submit" },
    handlers: { submit_model: submitModel },
    seed: modelSeed,
    unavailable: "いまは業務のモデルを提出する会話です (submit_model)。テーブルと情報の対応は、このあと別の会話で答えます。",
  });
  try {
    await modelSession.send(reverseLogicModelRequest(request, base, multi), {}, o.signal);
    throwIfAborted(o.signal);
    if (!accepted && !gaveUp) {
      await modelSession.send("submit_model でモデルの下書き全体を提出してください。", {}, o.signal);
      throwIfAborted(o.signal);
    }
  } catch (e) {
    throwIfAborted(o.signal);
    if (!(e instanceof ChatError) || o.signal?.aborted || !accepted) throw e;
  }
  const build = accepted as BuildResult | null;
  if (!build) throw new ChatError("AI がモデルを提出しませんでした。起こしたい業務を具体的にして、もう一度試してください。");
  let model = build.model;
  warnings.push(...build.warnings.map((w) => `業務: ${w}`), ...build.notices.map((w) => `業務: ${w}`));

  // 新しい画面は、画面の段階で作った設計 (サイトマップ・メニュー) に載せる (設計がまだ無いシステムには何もしない)
  const newScreens = model.elements.filter((e) => e.kind === "screen" && !baseIds.has(e.id));
  for (const sysId of new Set(newScreens.flatMap((e) => (e.kind === "screen" ? [e.systemId] : [])))) {
    model = addScreensToDesign(model, sysId, newScreens.filter((e) => e.kind === "screen" && e.systemId === sysId).map((e) => e.id), warnings);
  }

  // ---- 3. テーブルと情報の対応 (1 つの会話。モデルのすべての情報と、テーブルのあるすべてのデータベース) ----
  throwIfAborted(o.signal);
  o.onStep?.("tables");
  const realDbs = mappableDatabaseIds(model);
  const withInfo = model.elements.filter((e) => e.kind === "system" && systemInformationIds(model, e.id).length > 0);
  const mapPlan = planMapping(model);
  const mapBudget = logicBudget(mapPlan ? 1 : 0, nSources, mapPlan?.systems.length ?? 1);
  ctx.budget.calls = mapBudget.calls;
  ctx.budget.chars = mapBudget.chars;
  let mappedInformations = 0;
  if (realDbs.length === 0) {
    if (withInfo.length > 0) warnings.push("データ: データベースがまだ無いので、テーブルと情報の対応は付けませんでした。データの段階で、先に SQL などからデータベースを取り込んでください");
  } else {
    // 業務のモデルの会話と同じ履歴 (調査結果) で始める。先頭が同じなので、業務のモデルの会話が書いたキャッシュを読める
    const mapped = await mapTablesAndInformations({ model, ctx, system, seed: modelSeed, nSources, warnings });
    model = mapped.model;
    mappedInformations = mapped.mappedInformations;
  }
  warnings.push(...leftoverMappingWarnings(model));

  // ---- 検証 ----
  o.onStep?.("done");
  const remaining = traceToActors(model).problems.filter((p) => p.isBreak && !baseIds.has(p.elementId));
  for (const p of remaining.slice(0, 5)) {
    const e = model.elements.find((x) => x.id === p.elementId)!;
    warnings.push(`検証: ${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」: ${p.reason}`);
  }
  if (remaining.length > 5) warnings.push(`検証: ほか ${remaining.length - 5} 件の要素が担い手まで辿れません`);
  const designSystems = model.designs.map((d) => d.systemId);
  for (const systemId of designSystems) {
    const c = checkDesign(model, systemId);
    const prefix = designSystems.length > 1 ? `システム「${elementName(model, systemId)}」: ` : "";
    if (c.problems.length > 0) warnings.push(`設計の検証: ${prefix}エラー ${c.problems.length} 件 (${c.problems[0]!.message}${c.problems.length > 1 ? " ほか" : ""})`);
    for (const line of designWarningLines(model, systemId, c.warnings)) warnings.push(`設計の検証: ${prefix}${line}`);
  }
  if (!model.elements.some((e) => e.kind === "screen" && e.systemId && baseIds.has(e.id)) && build.added.screen) {
    warnings.push("画面: 画面の段階がまだなので、業務に関わる画面だけを足しました。画面の段階を進めると、画面 UI とメニューを作ります");
  }

  const headline = `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}から業務「${request.trim()}」を足しました (${summarizeCounts(build.added)}、テーブルと対応づけた情報 ${mappedInformations})。`;
  const summary = `${headline}${warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""}`;
  return {
    model,
    added: build.added,
    mappedInformations,
    survey,
    warnings,
    summary,
    headline,
    usage: usage.summary(),
    seed: [
      { role: "user", text: `次のソースコードから、業務をモデルに足してください。\n\n<ソースコードのフォルダ>${multi ? `\n${tree.sources!.map((x) => `${x.label}: ${x.folder}`).join("\n")}\n` : tree.name}</ソースコードのフォルダ>\n<モデルに起こしたい業務>\n${request}\n</モデルに起こしたい業務>` },
      { role: "assistant", text: `${stageSeed[1]!.text}\n\n${summary}` },
    ],
  };
}

export interface MappingResult {
  model: UntieModel;
  /** 新しくテーブルに結べた情報の数 */
  mappedInformations: number;
  warnings: string[];
  summary: string;
  headline: string;
  /** 段階の AI の使用量の合計 (API が使用量を返さなかったときは null) */
  usage: StageUsageSummary | null;
  /** このあとエージェントの会話に足す履歴 */
  seed: SeedTurn[];
}

/**
 * テーブルと情報の対応を付けるだけの入口 (業務の段階の最後の会話を、単独で実行する)。段階 1 → 2 → 3 の順でなくても (業務のあとにデータを取り込んだなど)、
 * 対応を付けられる。調査はせず、すでにあるモデルの情報とデータベースのテーブルから、AI が use_database で答える。
 * 失敗・中断は例外で、そのとき足したものは返らない
 */
export async function reverseMapping(base: UntieModel, source: SourceTree | readonly LabeledSource[], options: StageOptions): Promise<MappingResult> {
  const usage = trackUsage(options);
  const o = usage.options;
  const tree: SourceTree = "files" in source ? source : combineSourceTrees(source);
  const nSources = tree.sources?.length ?? 1;
  const multi = isMultiSourceTree(tree);
  if (!planMapping(base)) throw new ChatError("対応を付けられる情報がありません (どのテーブルにも対応していない情報と、テーブルのあるデータベースの両方が要ります)。");
  const ctx: Ctx = { tree, o, budget: { ...logicBudget(1, nSources, planMapping(base)?.systems.length ?? 1), usedCalls: 0, usedChars: 0 } };
  const warnings: string[] = [];
  throwIfAborted(o.signal);
  o.onStep?.("tables");
  const mapped = await mapTablesAndInformations({ model: base, ctx, system: reverseSystemPrompt(multi, "logic"), seed: [], nSources, warnings });
  o.onStep?.("done");
  warnings.push(...leftoverMappingWarnings(mapped.model));
  const headline = `テーブルと情報の対応を付けました (対応づいた情報 ${mapped.mappedInformations} 件)。`;
  const summary = `${headline}${warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""}`;
  return {
    model: mapped.model,
    mappedInformations: mapped.mappedInformations,
    warnings,
    summary,
    headline,
    usage: usage.summary(),
    seed: [
      { role: "user", text: `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}を参考に、テーブルと情報の対応を付けてください。` },
      { role: "assistant", text: summary },
    ],
  };
}
