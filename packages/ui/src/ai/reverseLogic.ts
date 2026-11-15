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
  designWarningLines,
  elementName,
  errorOutcome,
  logicBudget,
  okOutcome,
  openSession,
  REVERSE_LIMITS,
  revisionNote,
  sourceLimits,
  stageFailure,
  surveyCollector,
  throwIfAborted,
  type Ctx,
  type StageOptions,
} from "./reverse";
import { addScreensToDesign } from "./reverseScreens";
import { clipSurvey, FINISH_NOTE, reverseLogicModelRequest, reverseLogicSurveyRequest, reverseSystemPrompt, reverseTableMapRequest, wrapSurvey } from "./reversePrompts";
import { combineSourceTrees, isMultiSourceTree, sourcesTitle, visibleFiles, type LabeledSource, type SourceTree } from "./sourceTree";
import { executeGetTable, GET_TABLE_TOOL } from "./reverseTables";
import { buildModelFromSpec, nameKey, SUBMIT_MODEL_TOOL, type BuildResult, type ModelSpec } from "./spec";
import type { ToolOutcome } from "./tools";

export interface LogicResult {
  /** 足したあとのモデル */
  model: UntieModel;
  /** このとき新しく足した要素の数と、情報とテーブルの対応を付けた情報の数 */
  added: BuildResult["added"];
  mappedInformations: number;
  survey: string;
  warnings: string[];
  seed: SeedTurn[];
  summary: string;
}

/**
 * システムの対応付けの対象にするデータベースの id (DSL にテーブルのあるもの)。設計があるシステムは、設計が実際に使うデータベース (effectiveDatabaseIds)。
 * 設計がまだ無いシステム (画面を持たない・画面の段階がまだ) と、設計の使うデータベースにテーブルが無いシステムは、使うデータベースがまだ決まっていないので、
 * テーブルのあるデータベースすべて (AI が選ぶ。選んだデータベースが、設計の使うデータベースになる)
 */
export function systemDatabaseIds(model: UntieModel, systemId: string): string[] {
  const withTables = (id: string) => {
    const db = model.databases.find((d) => d.id === id);
    return !!db && tableNamesOf(db).length > 0;
  };
  const design = model.designs.find((d) => d.systemId === systemId);
  const used = design ? effectiveDatabaseIds(model, design).filter(withTables) : [];
  return used.length > 0 ? used : model.databases.filter((d) => withTables(d.id)).map((d) => d.id);
}

/** システムが使う情報のうち、対応付けの対象のデータベース (systemDatabaseIds) のどのテーブルにも対応していないものの id */
export function unmappedInSystem(model: UntieModel, systemId: string): string[] {
  const dbs = systemDatabaseIds(model, systemId).map((id) => model.databases.find((d) => d.id === id)!);
  const mapped = new Set(dbs.flatMap((d) => d.tables.flatMap((t) => t.informationIds)));
  return systemInformationIds(model, systemId).filter((id) => !mapped.has(id));
}

/** テーブルと情報の対応の、すきま: どのテーブルにも対応していない情報 (システムごとの重複を除く) と、どの情報にも対応していないテーブル (テーブルのあるデータベース) の数 */
export function mappingGap(model: UntieModel): { informations: number; tables: number; systems: number } {
  const infos = new Set<string>();
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

/** テーブルの DSL の中の、テーブルの前の `///` の説明の行 (テーブルの名前 → 行の並び) */
function tableDocComments(dsl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let docs: string[] = [];
  for (const line of dsl.split("\n")) {
    const doc = /^\s*\/\/\/\s?(.*)$/.exec(line);
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
 * 突き合わせの鍵 (NFKC・小文字・空白の削除) で、テーブルの名前・`@@map` のもとの名前・テーブルの説明 (`///` の行) のどれかと、情報の名前が一致するもの。
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
 * テーブルと情報の対応を、システムごとの会話で付ける (業務の段階の最後と、対応付けだけの入口で共通)。
 * 対象のデータベースは、システムの設計が実際に使うもの (systemDatabaseIds)。AI は use_database で答え、列を知りたいテーブルは get_table で調べる。
 * ctx.budget は呼ぶ側が決めておく
 */
async function mapTablesAndInformations(args: { model: UntieModel; ctx: Ctx; system: string; seed: SeedTurn[]; nSources: number; warnings: string[] }): Promise<TableMapResult> {
  const { ctx, system, seed, nSources, warnings } = args;
  const o = ctx.o;
  let model = args.model;
  const lim = sourceLimits(nSources);
  let mappedInformations = 0;
  const targets = model.elements.filter((e) => e.kind === "system").filter((e) => systemDatabaseIds(model, e.id).length > 0 && unmappedInSystem(model, e.id).length > 0);
  let streak = 0;
  for (const sys of targets) {
    throwIfAborted(o.signal);
    if (streak >= REVERSE_LIMITS.screenErrorStreak) {
      warnings.push(`データ: 会話が続けて ${REVERSE_LIMITS.screenErrorStreak} 回失敗したので、残りのシステムのテーブルと情報の対応は付けませんでした`);
      break;
    }
    const before = unmappedInSystem(model, sys.id).length;
    const dbIds = systemDatabaseIds(model, sys.id);
    let useAttempts = 0;
    let used = false;
    const maxAttempts = 1 + REVERSE_LIMITS.dataRetries;
    /** 出し直しの案内に添える、対応のすきま: どの情報にも結ばれていないテーブルと、どのテーブルにも結ばれていない情報 */
    const gap = (databaseId: string): { lines: string[]; any: boolean } => {
      const infos = unmappedInSystem(model, sys.id).map((id) => elementName(model, id));
      const db = model.databases.find((d) => d.id === databaseId);
      const tables = db ? unmappedTableNames(db) : [];
      const lines: string[] = [];
      if (tables.length > 0) lines.push(`DSL にあるテーブルのうち、どの情報にも結ばれていないもの: ${tables.slice(0, 20).join("、")}${tables.length > 20 ? " ほか" : ""}`);
      if (infos.length > 0) lines.push(`どのテーブルにも結ばれていない情報: ${infos.slice(0, 20).join("、")}${infos.length > 20 ? " ほか" : ""}`);
      return { lines, any: infos.length > 0 };
    };
    const useDatabase = (input: unknown): ToolOutcome => {
      const draft = readDatabaseUse(input);
      if (!draft) return errorOutcome("system・database・tables が必要です");
      if (useAttempts >= maxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${FINISH_NOTE}`, false);
      const wanted = draft.database.trim();
      const target = dbIds.map((id) => model.databases.find((d) => d.id === id)).find((d) => d && (d.id === wanted || nameKey(d.name) === nameKey(wanted)));
      if (!target) {
        const names = dbIds.map((id) => model.databases.find((d) => d.id === id)?.name ?? "").filter((n) => n !== "");
        return errorOutcome(`データベース「${draft.database}」は、このシステムが使うデータベースにありません。次のどれかの名前で指してください: ${names.map((n) => `「${n}」`).join("")}`);
      }
      useAttempts++;
      const r = applyDatabaseUse(model, { ...draft, system: sys.name, database: target.id });
      if (!r.applied) return errorOutcome(`${r.failure ?? "データベースを使えませんでした"}。直して出し直してください`);
      model = r.model;
      used = true;
      const message = `受け付けました: データベース「${target.name}」を使います (対応を足したテーブル ${r.added.tables}、情報 ${r.added.informations})`;
      o.onSubmit?.(true, message);
      const retriesLeft = maxAttempts - useAttempts;
      const g = gap(target.id);
      const others = r.warnings.filter((w) => !/がどのテーブルにも対応していません/.test(w));
      const note = revisionNote(others, retriesLeft, "use_database", "");
      if (g.any && retriesLeft > 0) {
        return okOutcome(
          `${message}${note}\n${g.lines.join("\n")}\nこのシステムの情報で、テーブルが DSL にあるのに対応が無いものは、tables に足して use_database を出し直してください (あと ${retriesLeft} 回まで。足した対応は残ります)。対応するテーブルがソースに無い情報だけ、直さなくてかまいません`,
          true,
        );
      }
      return okOutcome(`${message}${note}\n${FINISH_NOTE}`, true);
    };
    try {
      const session = openSession(ctx, system, [USE_DATABASE_TOOL, GET_TABLE_TOOL], { ...lim.data, finish: "submit" }, { use_database: useDatabase, get_table: (input) => executeGetTable(model, dbIds, input) }, seed, ["get_table"]);
      await session.send(reverseTableMapRequest(model, sys.id, dbIds), {}, o.signal);
      throwIfAborted(o.signal);
      if (!used) {
        await session.send("use_database で、このシステムが使うデータベースのテーブルと、このシステムの情報の対応を答えてください (対応するテーブルが無ければ、tables を空にして答えてください)。", {}, o.signal);
        throwIfAborted(o.signal);
      }
      streak = 0;
    } catch (e) {
      const failure = stageFailure(e, o.signal);
      if (!failure) throw e;
      streak++;
      warnings.push(`データ: システム「${sys.name}」: ${failure.message}`);
    }
    mappedInformations += Math.max(0, before - unmappedInSystem(model, sys.id).length);
  }
  return { model, mappedInformations };
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
export async function reverseLogic(base: UntieModel, source: SourceTree | readonly LabeledSource[], request: string, o: StageOptions): Promise<LogicResult> {
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
  const surveyRequest = reverseLogicSurveyRequest(request, base, tree.name, visibleFiles(tree).length, tree.sources);
  const surveySession = openSession(ctx, system, [], { ...lim.survey, finish: "survey" }, {}, []);
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
    return okOutcome(`${message}。${FINISH_NOTE}`, true);
  };
  const modelSession = openSession(ctx, system, [SUBMIT_MODEL_TOOL], { ...lim.model, finish: "submit" }, { submit_model: submitModel }, modelSeed);
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
  warnings.push(...build.warnings.map((w) => `業務: ${w}`));

  // 新しい画面は、画面の段階で作った設計 (サイトマップ・メニュー) に載せる (設計がまだ無いシステムには何もしない)
  const newScreens = model.elements.filter((e) => e.kind === "screen" && !baseIds.has(e.id));
  for (const sysId of new Set(newScreens.flatMap((e) => (e.kind === "screen" ? [e.systemId] : [])))) {
    model = addScreensToDesign(model, sysId, newScreens.filter((e) => e.kind === "screen" && e.systemId === sysId).map((e) => e.id), warnings);
  }

  // ---- 3. テーブルと情報の対応 (システムごと) ----
  throwIfAborted(o.signal);
  o.onStep?.("tables");
  const realDbs = model.databases.filter((d) => tableNamesOf(d).length > 0);
  const withInfo = model.elements.filter((e) => e.kind === "system" && systemInformationIds(model, e.id).length > 0);
  const toMap = model.elements.filter((e) => e.kind === "system" && systemDatabaseIds(model, e.id).length > 0 && unmappedInSystem(model, e.id).length > 0);
  ctx.budget.calls = logicBudget(toMap.length, nSources).calls;
  ctx.budget.chars = logicBudget(toMap.length, nSources).chars;
  let mappedInformations = 0;
  if (realDbs.length === 0) {
    if (withInfo.length > 0) warnings.push("データ: データベースがまだ無いので、テーブルと情報の対応は付けませんでした。データの段階で、先に SQL などからデータベースを取り込んでください");
  } else {
    const mapped = await mapTablesAndInformations({ model, ctx, system, seed: stageSeed, nSources, warnings });
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

  const summary = `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}から業務「${request.trim()}」を足しました (${summarizeCounts(build.added)}、テーブルと対応づけた情報 ${mappedInformations})。${
    warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    model,
    added: build.added,
    mappedInformations,
    survey,
    warnings,
    summary,
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
  /** このあとエージェントの会話に足す履歴 */
  seed: SeedTurn[];
}

/**
 * テーブルと情報の対応を付けるだけの入口 (業務の段階の最後の会話を、単独で実行する)。段階 1 → 2 → 3 の順でなくても (業務のあとにデータを取り込んだなど)、
 * 対応を付けられる。調査はせず、すでにあるモデルの情報とデータベースのテーブルから、AI が use_database で答える。
 * 失敗・中断は例外で、そのとき足したものは返らない
 */
export async function reverseMapping(base: UntieModel, source: SourceTree | readonly LabeledSource[], o: StageOptions): Promise<MappingResult> {
  const tree: SourceTree = "files" in source ? source : combineSourceTrees(source);
  const nSources = tree.sources?.length ?? 1;
  const multi = isMultiSourceTree(tree);
  const toMap = base.elements.filter((e) => e.kind === "system" && systemDatabaseIds(base, e.id).length > 0 && unmappedInSystem(base, e.id).length > 0);
  if (toMap.length === 0) throw new ChatError("対応を付けられる情報がありません (どのテーブルにも対応していない情報と、テーブルのあるデータベースの両方が要ります)。");
  const ctx: Ctx = { tree, o, budget: { ...logicBudget(toMap.length, nSources), usedCalls: 0, usedChars: 0 } };
  const warnings: string[] = [];
  throwIfAborted(o.signal);
  o.onStep?.("tables");
  const mapped = await mapTablesAndInformations({ model: base, ctx, system: reverseSystemPrompt(multi, "logic"), seed: [], nSources, warnings });
  o.onStep?.("done");
  warnings.push(...leftoverMappingWarnings(mapped.model));
  const summary = `テーブルと情報の対応を付けました (対応づいた情報 ${mapped.mappedInformations} 件)。${warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""}`;
  return {
    model: mapped.model,
    mappedInformations: mapped.mappedInformations,
    warnings,
    summary,
    seed: [
      { role: "user", text: `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}を参考に、テーブルと情報の対応を付けてください。` },
      { role: "assistant", text: summary },
    ],
  };
}
