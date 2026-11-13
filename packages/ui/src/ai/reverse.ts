// ソースコードから作成 (リバースエンジニアリング): 選んだフォルダのソースコードを AI が道具で読み、
// 対象の業務と関連する業務を調べて、分析の要素・データ・サイトマップ・画面 UI まで入ったモデルを作る。
// 段階: 調査 → 分析モデル → データ → 画面 UI。組み立ては spec.ts と designDraft.ts に任せる。
import { checkDesign } from "@untie/core/model/designCheck";
import { designScreenName } from "@untie/core/model/sitemap";
import { traceToActors } from "@untie/core/model/trace";
import { ELEMENT_KIND_LABELS, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { ChatError, createChatSession, type ChatSession, type SeedTurn } from "./chat";
import {
  applyDatabaseDraft,
  applyScreenDraft,
  applySitemapDraft,
  readDatabaseDraft,
  readScreenDraft,
  readSitemapDraft,
  SUBMIT_DATABASE_DRAFT_TOOL,
  SUBMIT_SCREEN_DRAFT_TOOL,
  SUBMIT_SITEMAP_TOOL,
} from "./designDraft";
import { screenRequest } from "./designScreen";
import { summarizeCounts } from "./generate";
import type { ProviderId } from "./providers";
import { reverseDataRequest, reverseModelRequest, reverseScreenRequest, reverseSurveyRequest, reverseSystemPrompt } from "./reversePrompts";
import { executeSourceTool, isSourceTool, SOURCE_TOOLS } from "./sourceTools";
import { visibleFiles, type SourceTree } from "./sourceTree";
import { buildModelFromSpec, SUBMIT_MODEL_TOOL, type BuildResult, type ModelSpec } from "./spec";
import type { ToolDef, ToolOutcome } from "./tools";

/** 進み具合の段階。survey = ソースコードの調査、model = 分析モデル、data = データ、screens = 画面 UI */
export type ReverseStep = "survey" | "model" | "data" | "screens" | "done";

export interface ReverseOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
  onStep?: (step: ReverseStep) => void;
  /** 調査結果の文章が届いたとき */
  onText?: (delta: string) => void;
  /** AI がソースコードを読む道具を使ったとき (path は読んだファイルやフォルダ、検索なら検索語) */
  onSourceTool?: (name: string, detail: string) => void;
  /** 提出と検査の結果 */
  onSubmit?: (accepted: boolean, message: string) => void;
  /** 画面 UI を 1 つ終えたとき (done / total は件数、name は画面の名前、ok は置けたか) */
  onScreen?: (done: number, total: number, name: string, ok: boolean) => void;
}

export interface ReverseResult {
  /** 組み立てたモデル (設計データも入っている) と、要素の数 */
  build: BuildResult;
  /** 調査結果の文章 */
  survey: string;
  /** 組み立てと設計データで気づいたこと (落とした部分など) */
  warnings: string[];
  /** このあとエージェントの会話に引き継ぐ履歴 */
  seed: SeedTurn[];
  summary: string;
}

// ---------------------------------------------------------------- 上限

export const REVERSE_LIMITS = {
  /** 画面 UI を作る画面の数。超えた分は作らず、警告に残す */
  screens: 30,
  /** 1 回の生成でソースの道具を呼べる回数の合計 */
  sourceCallsTotal: 300,
  /** 会話 (段階・システム・画面) ごとに呼べる回数。1 つの会話が全部を使い切って、あとの段階が読めなくならないようにする */
  sourceCallsSurvey: 60,
  sourceCallsModel: 15,
  sourceCallsData: 25,
  sourceCallsScreen: 8,
  /** 分析モデルを厳しく検査する提出の回数 (これを超えたら、気づいたことが残っていても受け付ける) */
  strictModelAttempts: 2,
  /** データ・画面 UI の出し直しの回数 (最初の提出に続けて) */
  dataRetries: 2,
  screenRetries: 1,
  /** あとの段階の会話に引き継ぐ調査結果の長さ (文字)。超えたら先頭だけ */
  surveySeedChars: 30000,
} as const;

// 会話の持ち方:
// 調査と分析モデルは別の会話にし、データはシステムごと、画面 UI は画面ごとに、それぞれ新しい会話にする。
// 理由: ソースのファイルを読むたびに会話は膨らみ (1 回の読み取りで最大 3 万文字)、1 つの会話で続けると、画面 UI の段階には文脈の
// 窓も 1 回の send の往復の上限 (chat.ts の MAX_STEPS = 60) も残らない。そこで、読んだ中身は捨て、調査結果の文章 (と、
// 画面・データの依頼に入れる、分析モデルから取り出した材料) だけを次の会話の履歴 (seed) に渡す。同じ段階の出し直しは、
// 検査の理由が会話に残るほうがよいので、1 つの会話の中で続ける。

const ABORT_MESSAGE = "中断しました。";
/** 中断されていたら例外を投げる (どの段階でも、道具の呼び出しと会話の切れ目で見る) */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException(ABORT_MESSAGE, "AbortError");
}

const errorOutcome = (message: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: message }), changed: false });
const okOutcome = (message: string, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify({ result: message }), changed });

/** 通知に出す、道具の対象 (読むパス・探す語) */
function sourceToolDetail(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = name === "search_code" ? i.pattern : name === "list_files" ? i.path || "/" : i.path;
  return typeof text === "string" ? text.slice(0, 200) : "";
}

interface Ctx {
  tree: SourceTree;
  o: ReverseOptions;
  /** ソースの道具を呼んだ回数の合計 (会話をまたいで数える) */
  sourceCalls: { n: number };
}

/** ソースの道具の実行。回数の上限を超えたら、実行せずに「分かった範囲で提出する」よう結果で伝える */
function sourceRunner(ctx: Ctx, cap: number): (name: string, input: unknown) => Promise<ToolOutcome> {
  let used = 0;
  return async (name, input) => {
    throwIfAborted(ctx.o.signal);
    if (ctx.sourceCalls.n >= REVERSE_LIMITS.sourceCallsTotal) {
      return errorOutcome(`ソースコードを読む回数の上限 (全体で ${REVERSE_LIMITS.sourceCallsTotal} 回) に達したので、これ以上は読めません。分かった範囲で提出してください`);
    }
    if (used >= cap) return errorOutcome(`この段階でソースコードを読む回数の上限 (${cap} 回) に達したので、これ以上は読めません。分かった範囲で提出してください`);
    used++;
    ctx.sourceCalls.n++;
    ctx.o.onSourceTool?.(name, sourceToolDetail(name, input));
    return executeSourceTool(ctx.tree, name, input);
  };
}

/** 新しい会話。道具の呼び出しは、ソースの道具ならソースへ、それ以外は handlers へ振り分ける */
function openSession(
  ctx: Ctx,
  system: string,
  extraTools: ToolDef[],
  cap: number,
  handlers: Record<string, (input: unknown) => ToolOutcome>,
  seed: SeedTurn[],
): ChatSession {
  const runSource = sourceRunner(ctx, cap);
  const session = createChatSession(ctx.o.provider, {
    apiKey: ctx.o.apiKey,
    model: ctx.o.model,
    system,
    tools: [...SOURCE_TOOLS, ...extraTools],
    runTool: (name, input) => {
      if (isSourceTool(name)) return runSource(name, input);
      throwIfAborted(ctx.o.signal);
      const h = handlers[name];
      return h ? h(input) : errorOutcome(`不明な道具です: ${name}`);
    },
  });
  if (seed.length > 0) session.seed(seed);
  return session;
}

const elementName = (model: UntieModel, id: string) => model.elements.find((e) => e.id === id)?.name ?? "";

export async function reverseEngineer(tree: SourceTree, request: string, o: ReverseOptions): Promise<ReverseResult> {
  const ctx: Ctx = { tree, o, sourceCalls: { n: 0 } };
  const system = reverseSystemPrompt();

  // ---- 1. 調査 ----
  throwIfAborted(o.signal);
  o.onStep?.("survey");
  const surveyRequest = reverseSurveyRequest(request, tree.name, visibleFiles(tree).length);
  const surveySession = openSession(ctx, system, [], REVERSE_LIMITS.sourceCallsSurvey, {}, []);
  const survey = (await surveySession.send(surveyRequest, { onText: o.onText }, o.signal)).trim();
  throwIfAborted(o.signal);
  if (survey === "") throw new ChatError("AI がソースコードの調査結果を返しませんでした。もう一度試してください。");
  const clipped = survey.length > REVERSE_LIMITS.surveySeedChars ? `${survey.slice(0, REVERSE_LIMITS.surveySeedChars)}\n(長いので、ここから先は省きました)` : survey;
  // あとの段階の会話に渡す履歴 (読んだファイルの中身は渡さない)
  const stageSeed: SeedTurn[] = [
    { role: "user", text: surveyRequest },
    { role: "assistant", text: clipped },
  ];

  // ---- 2. 分析モデル ----
  throwIfAborted(o.signal);
  o.onStep?.("model");
  let accepted: BuildResult | null = null;
  let attempts = 0;
  const submitModel = (input: unknown): ToolOutcome => {
    attempts++;
    const spec = input as ModelSpec;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.businesses)) return errorOutcome("businesses の一覧が必要です");
    const build = buildModelFromSpec(spec);
    const validation = validateModel(JSON.parse(JSON.stringify(build.model)));
    if (!validation.ok) return { ...errorOutcome("モデルの検査で問題がありました"), content: JSON.stringify({ error: "モデルの検査で問題がありました", details: validation.errors.slice(0, 20) }) };
    // 担い手まで辿れない要素も直してもらう
    const trace = traceToActors(build.model).problems.filter((p) => p.isBreak);
    const byId = new Map(build.model.elements.map((e) => [e.id, e]));
    const issues = [
      ...build.warnings,
      ...trace.map((p) => {
        const e = byId.get(p.elementId)!;
        return `${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」: ${p.reason}`;
      }),
    ];
    // ソースから作るモデルは、画面とイベントを含める (厳しく見るうちだけ。本当に無いなら、そのまま受け付ける)
    if (!build.counts.screen) issues.push("画面が 1 つもありません。ソースコードに画面 (ルート・テンプレート・コンポーネント) があれば、screens に書いてください (本当に無ければ、そのまま提出し直してください)");
    if (!build.counts.event) issues.push("イベントが 1 つもありません。人が担当しない処理 (バッチ・ジョブ・webhook・イベントハンドラー) があれば、events に書いてください (本当に無ければ、そのまま提出し直してください)");
    if (issues.length > 0 && attempts <= REVERSE_LIMITS.strictModelAttempts) {
      const message = `次の点を直して、モデル全体をもう一度提出してください:\n- ${issues.slice(0, 30).join("\n- ")}`;
      o.onSubmit?.(false, message);
      return errorOutcome(message);
    }
    accepted = build;
    const message = `受け付けました: ${summarizeCounts(build.counts)}${issues.length > 0 ? ` (気づいたこと ${issues.length} 件は残っています)` : ""}`;
    o.onSubmit?.(true, message);
    return okOutcome(message, true);
  };
  const modelSession = openSession(ctx, system, [SUBMIT_MODEL_TOOL], REVERSE_LIMITS.sourceCallsModel, { submit_model: submitModel }, stageSeed);
  await modelSession.send(reverseModelRequest(request), {}, o.signal);
  throwIfAborted(o.signal);
  if (!accepted) {
    // 提出せずに終わったら、もう一度だけ頼む
    await modelSession.send("submit_model でモデル全体を提出してください。", {}, o.signal);
    throwIfAborted(o.signal);
  }
  const build = accepted as BuildResult | null;
  if (!build) throw new ChatError("AI がモデルを提出しませんでした。起こしたい業務を具体的にして、もう一度試してください。");

  let model = build.model;
  const warnings: string[] = build.warnings.map((w) => `分析モデル: ${w}`);

  // ---- 3. データ (システムごと) ----
  o.onStep?.("data");
  const dataSystems = model.elements.filter((e) => e.kind === "system" && model.elements.some((s) => s.kind === "screen" && s.systemId === e.id));
  let databases = 0;
  for (const sys of dataSystems) {
    throwIfAborted(o.signal);
    let dbApplied = false;
    let dbGaveUp = false;
    let dbAttempts = 0;
    let sitemapDone = false;
    let dbWarnings: string[] = [];
    let sitemapWarnings: string[] = [];
    const submitDatabase = (input: unknown): ToolOutcome => {
      const draft = readDatabaseDraft(input);
      if (!draft) return errorOutcome("system・dsl・tables が必要です");
      dbAttempts++;
      // 出し直しのあとも解析エラーが残るなら、エラーを警告に残して DSL をそのまま置く
      const r = applyDatabaseDraft(model, { ...draft, system: sys.name }, { acceptDslErrors: dbAttempts > REVERSE_LIMITS.dataRetries });
      if (!r.applied) {
        if (r.dslErrors.length > 0 || dbAttempts <= REVERSE_LIMITS.dataRetries) {
          const detail = r.dslErrors.slice(0, 10).map((e) => `${e.line} 行 ${e.column} 列: ${e.message}`);
          const message = r.dslErrors.length > 0 ? `DSL に解析エラーがあります。直して出し直してください:\n- ${detail.join("\n- ")}` : `${r.failure ?? "データベースを足せませんでした"}。直して出し直してください`;
          o.onSubmit?.(false, message);
          return errorOutcome(message);
        }
        dbGaveUp = true;
        dbWarnings = r.warnings;
        o.onSubmit?.(false, `データ: システム「${sys.name}」のデータベースは足せませんでした`);
        return okOutcome("データベースは足せなかったので、見送ります。次へ進んでください", false);
      }
      model = r.model;
      dbApplied = true;
      dbWarnings = r.warnings;
      const message = `受け付けました: テーブル ${r.added.tables}、情報 ${r.added.informations}${r.dslErrors.length > 0 ? ` (DSL の解析エラー ${r.dslErrors.length} 件は残っています)` : ""}`;
      o.onSubmit?.(true, message);
      return okOutcome(message, true);
    };
    const submitSitemap = (input: unknown): ToolOutcome => {
      const draft = readSitemapDraft(input);
      if (!draft) return errorOutcome("system・transitions が必要です");
      const r = applySitemapDraft(model, { ...draft, system: sys.name });
      model = r.model;
      sitemapDone = true;
      sitemapWarnings = r.warnings;
      const message = `受け付けました: 画面 ${r.added.screens}、遷移 ${r.added.transitions + r.added.derivedTransitions}`;
      o.onSubmit?.(true, message);
      return okOutcome(message, true);
    };
    try {
      const dataSession = openSession(
        ctx,
        system,
        [SUBMIT_DATABASE_DRAFT_TOOL, SUBMIT_SITEMAP_TOOL],
        REVERSE_LIMITS.sourceCallsData,
        { submit_database: submitDatabase, submit_sitemap: submitSitemap },
        stageSeed,
      );
      await dataSession.send(reverseDataRequest(model, sys.id), {}, o.signal);
      throwIfAborted(o.signal);
      if (!dbApplied && !dbGaveUp) {
        await dataSession.send("submit_database でデータベースを提出してください。", {}, o.signal);
        throwIfAborted(o.signal);
      }
    } catch (e) {
      // 中断と API のエラー (キーの誤りなど) は、このまま止める。会話の上限などで終わったときは、この段階だけ飛ばす
      if (!(e instanceof ChatError) || o.signal?.aborted) throw e;
      warnings.push(`データ: システム「${sys.name}」: ${e.message}`);
    }
    if (dbApplied) databases++;
    else if (!dbGaveUp) warnings.push(`データ: システム「${sys.name}」: AI がデータベースを提出しなかったので、データベースは作りませんでした`);
    warnings.push(...dbWarnings);
    // 画面を設計に足すため、AI が遷移を出さなくても、空の遷移で必ず足す
    if (!sitemapDone) {
      const r = applySitemapDraft(model, { system: sys.name, transitions: [] });
      model = r.model;
      sitemapWarnings = r.warnings;
    }
    warnings.push(...sitemapWarnings);
  }

  // ---- 4. 画面 UI (画面ごと) ----
  throwIfAborted(o.signal);
  o.onStep?.("screens");
  const targets = model.designs.flatMap((d) =>
    d.screens.flatMap((s) => (s.source.kind === "screen" ? [{ systemId: d.systemId, id: s.id, name: designScreenName(model, s) }] : [])),
  );
  const todo = targets.slice(0, REVERSE_LIMITS.screens);
  if (targets.length > todo.length) {
    const rest = targets.slice(todo.length);
    warnings.push(`画面 UI: 画面が ${targets.length} 件あり、上限 ${REVERSE_LIMITS.screens} 件を超えたので、後ろの ${rest.length} 件は作りませんでした (${rest.slice(0, 5).map((t) => `「${t.name}」`).join("")}${rest.length > 5 ? " ほか" : ""})`);
  }
  let done = 0;
  let placed = 0;
  for (const t of todo) {
    throwIfAborted(o.signal);
    let applied = false;
    let gaveUp = false;
    let attempt = 0;
    let screenWarnings: string[] = [];
    const sysName = elementName(model, t.systemId);
    const submitScreen = (input: unknown): ToolOutcome => {
      const draft = readScreenDraft(input);
      if (!draft) return errorOutcome("screen・view・bindings が必要です");
      if (draft.screen.trim() !== t.name) return errorOutcome(`この会話で作る画面は「${t.name}」だけです (「${draft.screen}」ではありません)`);
      attempt++;
      const r = applyScreenDraft(model, { ...draft, system: sysName });
      if (r.applied) {
        model = r.model;
        applied = true;
        screenWarnings = r.warnings;
        const message = `受け付けました: 対応 ${r.added.bindings} 件`;
        o.onSubmit?.(true, message);
        return okOutcome(message, true);
      }
      if (r.viewError && attempt <= REVERSE_LIMITS.screenRetries) {
        const message = `view が mokkun の検証に通りませんでした。直して出し直してください: ${r.viewError}`;
        o.onSubmit?.(false, message);
        return errorOutcome(message);
      }
      gaveUp = true;
      screenWarnings = r.warnings;
      o.onSubmit?.(false, `画面「${t.name}」の画面 UI は置けませんでした`);
      return okOutcome("この画面の画面 UI は置けなかったので、見送ります。次へ進んでください", false);
    };
    try {
      const screenSession = openSession(ctx, system, [SUBMIT_SCREEN_DRAFT_TOOL], REVERSE_LIMITS.sourceCallsScreen, { submit_screen: submitScreen }, stageSeed);
      const design = model.designs.find((d) => d.systemId === t.systemId)!;
      const screen = design.screens.find((s) => s.id === t.id)!;
      await screenSession.send(reverseScreenRequest(screenRequest(model, t.systemId, design, screen), t.name), {}, o.signal);
      throwIfAborted(o.signal);
    } catch (e) {
      if (!(e instanceof ChatError) || o.signal?.aborted) throw e;
      warnings.push(`画面 UI: 画面「${t.name}」: ${e.message}`);
    }
    if (!applied && !gaveUp && screenWarnings.length === 0) warnings.push(`画面 UI: 画面「${t.name}」: AI が画面 UI を提出しなかったので、作りませんでした`);
    warnings.push(...screenWarnings);
    done++;
    if (applied) placed++;
    o.onScreen?.(done, todo.length, t.name, applied);
  }

  o.onStep?.("done");
  const result: BuildResult = { model, warnings: build.warnings, counts: build.counts };
  const designProblems = model.elements.filter((e) => e.kind === "system").flatMap((e) => checkDesign(model, e.id).problems);
  if (designProblems.length > 0) warnings.push(`設計の検証: エラー ${designProblems.length} 件 (${designProblems[0]!.message}${designProblems.length > 1 ? " ほか" : ""})`);
  const summary = `ソースコード「${tree.name}」からモデル「${model.meta.name}」を作成しました (${summarizeCounts(build.counts)})。データベース ${databases}/${dataSystems.length} システム、画面 UI ${placed}/${targets.length} 画面。${
    warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    build: result,
    survey,
    warnings,
    summary,
    seed: [
      { role: "user", text: `次のソースコードから業務モデルを作ってください。\n\n<ソースコードのフォルダ>${tree.name}</ソースコードのフォルダ>\n<モデルに起こしたい業務>\n${request}\n</モデルに起こしたい業務>` },
      { role: "assistant", text: `${survey}\n\n${summary}` },
    ],
  };
}
