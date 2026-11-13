// ソースコードから作成 (リバースエンジニアリング): 選んだフォルダのソースコードを AI が道具で読み、
// 対象の業務と関連する業務を調べて、分析の要素・データ・サイトマップ・画面 UI まで入ったモデルを作る。
// 段階: 調査 → 分析モデル → データ → 画面 UI。組み立ては spec.ts と designDraft.ts に任せる。
import { setDesignNavigation } from "@untie/core/model/commands";
import { checkDesign, DESIGN_PROBLEM_ORDER, DESIGN_PROBLEM_TITLES, type DesignProblem, type DesignProblemType } from "@untie/core/model/designCheck";
import { designScreenName, navigationFromSitemap } from "@untie/core/model/sitemap";
import { traceToActors } from "@untie/core/model/trace";
import { ELEMENT_KIND_LABELS, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { ChatError, createChatSession, type ChatEvents, type ChatSession, type SeedTurn } from "./chat";
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
import {
  clipSurvey,
  FINISH_NOTE,
  reverseDataRequest,
  reverseModelRequest,
  reverseScreenRequest,
  reverseSurveyRequest,
  reverseSystemPrompt,
  wrapSurvey,
} from "./reversePrompts";
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
  /** AI がソースコードを読む道具を使ったとき (name は「読む」「探す」「一覧」の短い日本語、detail は読んだファイルやフォルダ、検索なら検索語。画面には「name detail」と出す) */
  onSourceTool?: (name: string, detail: string) => void;
  /** 提出と検査の結果 (message は利用者に見せる短い文。AI に返す文とは別) */
  onSubmit?: (accepted: boolean, message: string) => void;
  /** 画面 UI を 1 つ終えたとき (done / total は件数、name は画面の名前、ok は置けたか) */
  onScreen?: (done: number, total: number, name: string, ok: boolean) => void;
}

export interface ReverseResult {
  /** 組み立てたモデル (設計データも入っている) と、要素の数 */
  build: BuildResult;
  /** 調査結果の文章 (調査の会話で届いた文章を、段落の区切りを保ってすべてつなげたもの) */
  survey: string;
  /** 組み立てと設計データで気づいたこと (落とした部分など) */
  warnings: string[];
  /** このあとエージェントの会話に引き継ぐ履歴 (調査結果は短くして、指示ではなくデータと分かる形で囲んである) */
  seed: SeedTurn[];
  summary: string;
}

// ---------------------------------------------------------------- 上限

/** 会話の 1 回の send で、道具を使う往復の上限 (chat.ts の MAX_STEPS = 60。export されていないので、値をここに写す) */
export const CHAT_MAX_STEPS = 60;

export const REVERSE_LIMITS = {
  /** 画面 UI を作る画面の数。超えた分は作らず、警告に残す */
  screens: 30,
  /** 1 回の生成でソースの道具を呼べる回数の合計 */
  sourceCallsTotal: 300,
  /**
   * 会話 (段階・システム・画面) ごとに呼べる回数。1 つの会話が全部を使い切って、あとの段階が読めなくならないようにする。
   * 1 回の send の往復の上限 (CHAT_MAX_STEPS = 60) より十分小さくする。読み切ったあとに、調査結果を書く往復・提出の往復・
   * 検査で返されたときの出し直しの往復・終わりの返答の往復が残るように (調査: 上限 + 返答 1、分析モデル: 上限 + 提出 3 + 返答、
   * データ: 上限 + 提出 3 + 2 + 返答、画面: 上限 + 提出 2 + 返答)
   */
  sourceCallsSurvey: 40,
  sourceCallsModel: 12,
  sourceCallsData: 20,
  sourceCallsScreen: 8,
  /** 会話ごとに、道具が返した文字数の合計の上限。超えたら回数の上限と同じ扱い (読み過ぎて、文脈の窓や費用があふれないように) */
  sourceCharsSurvey: 250_000,
  sourceCharsModel: 80_000,
  sourceCharsData: 120_000,
  sourceCharsScreen: 60_000,
  /** 分析モデルを厳しく検査する提出の回数 (これを超えたら、気づいたことが残っていても受け付ける) */
  strictModelAttempts: 2,
  /** データ・画面 UI の出し直しの回数 (最初の提出に続けて) */
  dataRetries: 2,
  screenRetries: 1,
  /** 分析モデルの会話に引き継ぐ調査結果の長さ (文字)。超えたら画面・データ・遷移の節を優先して省く */
  surveyModelChars: 30000,
  /** データ・画面 UI の会話と、エージェントに引き継ぐ履歴に入れる調査結果の長さ (文字)。費用を抑えるため短くする */
  surveySeedChars: 8000,
  /** 提出を受け付けたあと、気づいたことを AI に返す数 */
  revisionWarnings: 10,
  /** 画面 UI の会話の ChatError が続けて起きたら、残りの画面は作らずに終える回数 */
  screenErrorStreak: 3,
} as const;

// 会話の持ち方:
// 調査と分析モデルは別の会話にし、データはシステムごと、画面 UI は画面ごとに、それぞれ新しい会話にする。
// 理由: ソースのファイルを読むたびに会話は膨らみ (1 回の読み取りで最大 3 万文字)、1 つの会話で続けると、画面 UI の段階には文脈の
// 窓も 1 回の send の往復の上限 (CHAT_MAX_STEPS) も残らない。そこで、読んだ中身は捨て、調査結果の文章 (と、
// 画面・データの依頼に入れる、分析モデルから取り出した材料) だけを次の会話の履歴 (seed) に渡す。同じ段階の出し直しは、
// 検査の理由が会話に残るほうがよいので、1 つの会話の中で続ける。

const ABORT_MESSAGE = "中断しました。";
/** 中断されていたら例外を投げる (どの段階でも、道具の呼び出しと会話の切れ目で見る) */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException(ABORT_MESSAGE, "AbortError");
}

const errorOutcome = (message: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: message }), changed: false });
const okOutcome = (message: string, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify({ result: message }), changed });

/** 通知に出す、道具の名前 (画面に「name detail」と出るので、短い日本語にする) */
const SOURCE_TOOL_LABELS: Record<string, string> = { list_files: "一覧", read_file: "読む", search_code: "探す" };

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

/** 会話ごとのソースの道具の上限と、上限に達したときに AI へ伝えること (調査は「まとめる」、提出のある段階は「提出する」) */
interface SourceCap {
  calls: number;
  chars: number;
  finish: "survey" | "submit";
}

/** ソースの道具の実行。回数・文字数の上限を超えたら、実行せずに「まとめる・分かった範囲で提出する」よう結果で伝える */
function sourceRunner(ctx: Ctx, cap: SourceCap): (name: string, input: unknown) => Promise<ToolOutcome> {
  let used = 0;
  let chars = 0;
  const next = cap.finish === "survey" ? "調査結果をまとめてください" : "分かった範囲で提出してください";
  return async (name, input) => {
    throwIfAborted(ctx.o.signal);
    if (ctx.sourceCalls.n >= REVERSE_LIMITS.sourceCallsTotal) {
      return errorOutcome(`ソースコードを読む回数の上限 (全体で ${REVERSE_LIMITS.sourceCallsTotal} 回) に達したので、これ以上は読めません。${next}`);
    }
    if (used >= cap.calls) return errorOutcome(`この段階でソースコードを読む回数の上限 (${cap.calls} 回) に達したので、これ以上は読めません。${next}`);
    if (chars >= cap.chars) return errorOutcome(`この段階でソースコードを読んだ量の上限 (${cap.chars} 文字) に達したので、これ以上は読めません。${next}`);
    used++;
    ctx.sourceCalls.n++;
    ctx.o.onSourceTool?.(SOURCE_TOOL_LABELS[name] ?? name, sourceToolDetail(name, input));
    const outcome = await executeSourceTool(ctx.tree, name, input);
    chars += outcome.content.length;
    return outcome;
  };
}

/** 新しい会話。道具の呼び出しは、ソースの道具ならソースへ、それ以外は handlers へ振り分ける */
function openSession(
  ctx: Ctx,
  system: string,
  extraTools: ToolDef[],
  cap: SourceCap,
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

/** 提出を受け付けたあとの気づいたこと (先頭 REVERSE_LIMITS.revisionWarnings 件) を、AI に返す文にする。残りの出し直しの回数があれば、直せるなら出し直してよいと伝える */
function revisionNote(warnings: string[], retriesLeft: number, tool: string, ignorable: string): string {
  if (warnings.length === 0) return "";
  const shown = warnings.slice(0, REVERSE_LIMITS.revisionWarnings);
  const list = `気づいたこと ${warnings.length} 件${warnings.length > shown.length ? ` (先頭 ${shown.length} 件)` : ""}:\n- ${shown.join("\n- ")}`;
  return retriesLeft > 0
    ? `\n${list}\n直せるものがあれば、${tool} を出し直してよい (あと ${retriesLeft} 回まで)。${ignorable}`
    : `\n${list}\n(出し直しの回数の上限に達したので、このまま受け付けました)`;
}

// ---------------------------------------------------------------- 設計の検証の警告を、利用者向けの文にする

/** 検査の警告の message から、画面などの名前を取り出す */
function sampleNames(problems: DesignProblem[], pick: (message: string) => string | undefined): string {
  const names = problems.map((p) => pick(p.message)).filter((n): n is string => !!n);
  return names.length === 0 ? "" : ` (${names.slice(0, 3).join("、")}${names.length > 3 ? " ほか" : ""})`;
}
const screenNameIn = (message: string) => /画面「(.+?)」/.exec(message)?.[1];

const DESIGN_WARNING_TEXT: Partial<Record<DesignProblemType, (list: DesignProblem[]) => string>> = {
  screenWithoutView: (list) => {
    const n = /(\d+) 件/.exec(list[0]!.message)?.[1] ?? String(list.length);
    const names = /\((.+)\)/.exec(list[0]!.message)?.[1];
    return `画面 UI がまだ無い画面が ${n} 件あります${names ? ` (${names})` : ""}。設計モードの画面ボードで作ってください`;
  },
  transitionViaUndecided: (list) =>
    `きっかけが未定の遷移が ${list.length} 件あります${sampleNames(list, (m) => /遷移「(.+?)」のきっかけ/.exec(m)?.[1])}。サイトマップで、ボタン・一覧の行・送信のあとなどを選んでください`,
  screenUnreachable: (list) =>
    `メニューにも遷移にも出てこない画面が ${list.length} 件あります${sampleNames(list, screenNameIn)}。サイトマップで遷移を足すか、ナビゲーションに加えてください`,
  bindingUnmapped: (list) =>
    `列の対応が無い項目のある画面が ${list.length} 件あります${sampleNames(list, screenNameIn)}。画面ボードで、項目をテーブルの列に結んでください (対応するテーブルがソースに無い項目は、そのままでかまいません)`,
};

/** 検査の「気づいたこと」を、種類ごとに件数をまとめて、利用者が次に何を直せばよいか分かる文にする */
function designWarningLines(warnings: DesignProblem[]): string[] {
  const lines: string[] = [];
  for (const type of DESIGN_PROBLEM_ORDER) {
    const list = warnings.filter((w) => w.type === type);
    if (list.length === 0) continue;
    lines.push(DESIGN_WARNING_TEXT[type]?.(list) ?? `${DESIGN_PROBLEM_TITLES[type]}が ${list.length} 件あります`);
  }
  return lines;
}

// ---------------------------------------------------------------- 画面 UI を作る順

/** 対象の業務 (名前) の操作が使う画面の、分析の要素の id */
function screensOfBusinesses(model: UntieModel, businessNames: string[]): Set<string> {
  const wanted = new Set(businessNames.map((n) => n.trim()).filter((n) => n !== ""));
  const businessIds = new Set(model.elements.filter((e) => e.kind === "business" && wanted.has(e.name)).map((e) => e.id));
  if (businessIds.size === 0) return new Set();
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const usecases = new Set<string>();
  for (const r of model.relations) {
    if (r.kind !== "activityUsecase") continue;
    const a = byId.get(r.sourceId);
    const buc = a?.kind === "activity" && a.bucId ? byId.get(a.bucId) : undefined;
    if (buc?.kind === "buc" && buc.businessId && businessIds.has(buc.businessId)) usecases.add(r.targetId);
  }
  return new Set(model.relations.filter((r) => r.kind === "usecaseScreen" && usecases.has(r.sourceId)).map((r) => r.targetId));
}

/** submit_model に、対象の業務の名前を受け取る項目を足した道具 (spec.ts の道具は「プロンプトから作成」と共有なので、ここで包む) */
const SUBMIT_REVERSE_MODEL_TOOL: ToolDef = {
  ...SUBMIT_MODEL_TOOL,
  parameters: {
    ...SUBMIT_MODEL_TOOL.parameters,
    properties: {
      ...((SUBMIT_MODEL_TOOL.parameters as { properties: Record<string, unknown> }).properties),
      target_businesses: {
        type: "array",
        items: { type: "string" },
        description: "依頼された業務のうち、対象の業務の名前 (businesses の name と同じ名前)。対象の業務は作業・操作・画面まで詳しく、それ以外 (関連する業務) は業務・活動・主な作業までにする。画面 UI は対象の業務の画面から先に作る",
      },
    },
  },
};

/** 調査の会話で届いた文章を、段落の区切りを保ってすべて貯める (道具を使った前後は段落を分ける) */
function surveyCollector(onText: ((delta: string) => void) | undefined): { events: ChatEvents; text: () => string } {
  let collected = "";
  let breakNext = false;
  return {
    events: {
      onText: (delta) => {
        if (breakNext) {
          breakNext = false;
          if (collected !== "" && !/\n\s*$/.test(collected)) {
            collected += "\n\n";
            onText?.("\n\n");
          }
        }
        collected += delta;
        onText?.(delta);
      },
      onTool: () => {
        breakNext = true;
      },
    },
    text: () => collected.trim(),
  };
}

export async function reverseEngineer(tree: SourceTree, request: string, o: ReverseOptions): Promise<ReverseResult> {
  const ctx: Ctx = { tree, o, sourceCalls: { n: 0 } };
  const system = reverseSystemPrompt();

  // ---- 1. 調査 ----
  throwIfAborted(o.signal);
  o.onStep?.("survey");
  const surveyRequest = reverseSurveyRequest(request, tree.name, visibleFiles(tree).length);
  const surveySession = openSession(
    ctx,
    system,
    [],
    { calls: REVERSE_LIMITS.sourceCallsSurvey, chars: REVERSE_LIMITS.sourceCharsSurvey, finish: "survey" },
    {},
    [],
  );
  // 調査結果は、最後のメッセージだけでなく、会話で届いた文章のすべて (途中で本文を書いてから道具を使い、最後に「以上です。」と返す場合がある)
  const collector = surveyCollector(o.onText);
  const lastReply = (await surveySession.send(surveyRequest, collector.events, o.signal)).trim();
  throwIfAborted(o.signal);
  const survey = collector.text() || lastReply;
  if (survey === "") throw new ChatError("AI がソースコードの調査結果を返しませんでした。もう一度試してください。");
  // あとの段階の会話に渡す履歴 (読んだファイルの中身は渡さない。調査結果は、指示ではなくデータと分かる形で囲む)
  const seedOf = (maxChars: number): SeedTurn[] => [
    { role: "user", text: surveyRequest },
    { role: "assistant", text: wrapSurvey(clipSurvey(survey, maxChars)) },
  ];
  const modelSeed = seedOf(REVERSE_LIMITS.surveyModelChars);
  const stageSeed = seedOf(REVERSE_LIMITS.surveySeedChars);

  // ---- 2. 分析モデル ----
  throwIfAborted(o.signal);
  o.onStep?.("model");
  let accepted: BuildResult | null = null;
  let targetBusinesses: string[] = [];
  let attempts = 0;
  /** 「画面・イベントが無い」の注意は 1 度だけ出す (本当に無ければそのまま提出し直してよいと伝えてあるので、2 回目は断らない) */
  let nudged = false;
  const submitModel = (input: unknown): ToolOutcome => {
    // 受け付けたあとの出し直しは受けない (往復を使い切らないように)
    if (accepted) return okOutcome(`すでに受け付けました。${FINISH_NOTE}`, false);
    attempts++;
    const { target_businesses: targets, ...rest } = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const spec = rest as unknown as ModelSpec;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.businesses)) return errorOutcome("businesses の一覧が必要です");
    const build = buildModelFromSpec(spec);
    const validation = validateModel(JSON.parse(JSON.stringify(build.model)));
    if (!validation.ok) return { ...errorOutcome("モデルの検査で問題がありました"), content: JSON.stringify({ error: "モデルの検査で問題がありました", details: validation.errors.slice(0, 20) }) };
    // 担い手まで辿れない要素も直してもらう。issues は AI に返す文、brief は利用者に見せる短い言い方
    const trace = traceToActors(build.model).problems.filter((p) => p.isBreak);
    const byId = new Map(build.model.elements.map((e) => [e.id, e]));
    const issues: { text: string; brief: string }[] = [
      ...build.warnings.map((w) => ({ text: w, brief: w })),
      ...trace.map((p) => {
        const e = byId.get(p.elementId)!;
        const text = `${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」: ${p.reason}`;
        return { text, brief: text };
      }),
    ];
    // ソースから作るモデルは、画面とイベントを含める (厳しく見るうちの 1 回だけ。本当に無ければ、そのまま提出し直せば受け付ける)
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
      const message = `次の点を直して、モデル全体をもう一度提出してください:\n- ${issues.slice(0, 30).map((i) => i.text).join("\n- ")}`;
      const first = issues[0]!.brief.length > 40 ? `${issues[0]!.brief.slice(0, 40)}…` : issues[0]!.brief;
      o.onSubmit?.(false, `業務のモデルを直してもらっています (${first}${issues.length > 1 ? ` など ${issues.length} 件` : ""})`);
      return errorOutcome(message);
    }
    accepted = build;
    targetBusinesses = Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
    const message = `受け付けました: ${summarizeCounts(build.counts)}${issues.length > 0 ? ` (気づいたこと ${issues.length} 件は残っています)` : ""}`;
    o.onSubmit?.(true, message);
    return okOutcome(`${message}。${FINISH_NOTE}`, true);
  };
  const modelSession = openSession(
    ctx,
    system,
    [SUBMIT_REVERSE_MODEL_TOOL],
    { calls: REVERSE_LIMITS.sourceCallsModel, chars: REVERSE_LIMITS.sourceCharsModel, finish: "submit" },
    { submit_model: submitModel },
    modelSeed,
  );
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
    const dbMaxAttempts = 1 + REVERSE_LIMITS.dataRetries;
    const submitDatabase = (input: unknown): ToolOutcome => {
      const draft = readDatabaseDraft(input);
      if (!draft) return errorOutcome("system・dsl・tables が必要です");
      // 受け付けたあとの出し直しにも回数の上限がある (往復を使い切らないように)
      if (dbApplied && dbAttempts >= dbMaxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${sitemapDone ? FINISH_NOTE : "続けて submit_sitemap を提出してください"}`, false);
      dbAttempts++;
      // 出し直しのあとも解析エラーが残るなら、エラーを警告に残して DSL をそのまま置く
      const r = applyDatabaseDraft(model, { ...draft, system: sys.name }, { acceptDslErrors: dbAttempts > REVERSE_LIMITS.dataRetries });
      if (!r.applied) {
        if (r.dslErrors.length > 0 || dbAttempts <= REVERSE_LIMITS.dataRetries) {
          const detail = r.dslErrors.slice(0, 10).map((e) => `${e.line} 行 ${e.column} 列: ${e.message}`);
          const message = r.dslErrors.length > 0 ? `DSL に解析エラーがあります。直して出し直してください:\n- ${detail.join("\n- ")}` : `${r.failure ?? "データベースを足せませんでした"}。直して出し直してください`;
          o.onSubmit?.(false, "データベースの定義を直してもらっています");
          return errorOutcome(message);
        }
        if (dbApplied) return okOutcome("出し直しは通らなかったので、前の提出のままにします。", false);
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
      const retriesLeft = dbMaxAttempts - dbAttempts;
      const note = revisionNote(r.warnings, retriesLeft, "submit_database", "対応するテーブルがソースに無い情報は、直さなくてかまいません。");
      return okOutcome(`${message}${note}${note === "" || retriesLeft <= 0 ? `\n${sitemapDone ? FINISH_NOTE : "続けて submit_sitemap を提出してください"}` : ""}`, true);
    };
    const submitSitemap = (input: unknown): ToolOutcome => {
      const draft = readSitemapDraft(input);
      if (!draft) return errorOutcome("system・transitions が必要です");
      if (sitemapDone) return okOutcome(`すでに受け付けました。${FINISH_NOTE}`, false);
      const r = applySitemapDraft(model, { ...draft, system: sys.name });
      model = r.model;
      sitemapDone = true;
      sitemapWarnings = r.warnings;
      const message = `受け付けました: 画面 ${r.added.screens}、遷移 ${r.added.transitions + r.added.derivedTransitions}`;
      o.onSubmit?.(true, message);
      return okOutcome(`${message}。${dbApplied || dbGaveUp ? FINISH_NOTE : "続けて submit_database を提出してください"}`, true);
    };
    try {
      const dataSession = openSession(
        ctx,
        system,
        [SUBMIT_DATABASE_DRAFT_TOOL, SUBMIT_SITEMAP_TOOL],
        { calls: REVERSE_LIMITS.sourceCallsData, chars: REVERSE_LIMITS.sourceCharsData, finish: "submit" },
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

  // ---- ナビゲーション (メニュー) ----
  // サイトマップの業務の分け方から作る。作らないと、設計の検証に「メニューからも遷移からも辿れない画面」が残る
  for (const sys of dataSystems) {
    const navigation = navigationFromSitemap(model, sys.id);
    if (navigation.length === 0) continue;
    const r = setDesignNavigation(model, { systemId: sys.id, navigation });
    if (r.ok) model = r.model;
    else warnings.push(`ナビゲーション: システム「${sys.name}」のナビゲーションを作れませんでした (${r.reason})`);
  }

  // ---- 4. 画面 UI (画面ごと) ----
  throwIfAborted(o.signal);
  o.onStep?.("screens");
  const allTargets = model.designs.flatMap((d) =>
    d.screens.flatMap((s) =>
      s.source.kind === "screen" ? [{ systemId: d.systemId, id: s.id, analysisId: s.source.screenId, name: designScreenName(model, s) }] : [],
    ),
  );
  // 対象の業務の画面を先に作る (上限で切られるのは、関連する業務の画面の側になる)。同じ組の中では、もとの順
  const primary = screensOfBusinesses(model, targetBusinesses);
  const targets = primary.size === 0 ? allTargets : [...allTargets.filter((t) => primary.has(t.analysisId)), ...allTargets.filter((t) => !primary.has(t.analysisId))];
  const todo = targets.slice(0, REVERSE_LIMITS.screens);
  if (targets.length > todo.length) {
    const rest = targets.slice(todo.length);
    warnings.push(`画面 UI: 画面が ${targets.length} 件あり、上限 ${REVERSE_LIMITS.screens} 件を超えたので、後ろの ${rest.length} 件は作りませんでした (${rest.slice(0, 5).map((t) => `「${t.name}」`).join("")}${rest.length > 5 ? " ほか" : ""})`);
  }
  let done = 0;
  let placed = 0;
  let errorStreak = 0;
  for (const t of todo) {
    throwIfAborted(o.signal);
    // 画面の会話の失敗 (拒否・返答なし・長すぎ) が続くなら、同じ失敗を繰り返さずに終える
    if (errorStreak >= REVERSE_LIMITS.screenErrorStreak) {
      const rest = todo.length - done;
      warnings.push(`画面 UI: 画面の会話が続けて ${errorStreak} 回失敗したので、残りの ${rest} 画面は作りませんでした。しばらくしてから、設計モードの画面ボードで作ってください`);
      break;
    }
    let applied = false;
    let gaveUp = false;
    let attempt = 0;
    let screenWarnings: string[] = [];
    const sysName = elementName(model, t.systemId);
    const screenMaxAttempts = 1 + REVERSE_LIMITS.screenRetries;
    const submitScreen = (input: unknown): ToolOutcome => {
      const draft = readScreenDraft(input);
      if (!draft) return errorOutcome("screen・view・bindings が必要です");
      if (draft.screen.trim() !== t.name) return errorOutcome(`この会話で作る画面は「${t.name}」だけです (「${draft.screen}」ではありません)`);
      if (applied && attempt >= screenMaxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${FINISH_NOTE}`, false);
      attempt++;
      const r = applyScreenDraft(model, { ...draft, system: sysName });
      if (r.applied) {
        model = r.model;
        applied = true;
        screenWarnings = r.warnings;
        const message = `受け付けました: 対応 ${r.added.bindings} 件`;
        o.onSubmit?.(true, message);
        const retriesLeft = screenMaxAttempts - attempt;
        const note = revisionNote(r.warnings, retriesLeft, "submit_screen", "ソースに無い項目やボタンは、足さなくてかまいません。");
        return okOutcome(`${message}${note}${note === "" || retriesLeft <= 0 ? `\n${FINISH_NOTE}` : ""}`, true);
      }
      if (applied) return okOutcome(`出し直しは通らなかったので、前の提出のままにします。${FINISH_NOTE}`, false);
      if (r.viewError && attempt <= REVERSE_LIMITS.screenRetries) {
        const message = `view が mokkun の検証に通りませんでした。直して出し直してください: ${r.viewError}`;
        o.onSubmit?.(false, `画面「${t.name}」の形を直してもらっています`);
        return errorOutcome(message);
      }
      gaveUp = true;
      screenWarnings = r.warnings;
      o.onSubmit?.(false, `画面「${t.name}」の画面 UI は置けませんでした`);
      return okOutcome("この画面の画面 UI は置けなかったので、見送ります。次へ進んでください", false);
    };
    try {
      const screenSession = openSession(
        ctx,
        system,
        [SUBMIT_SCREEN_DRAFT_TOOL],
        { calls: REVERSE_LIMITS.sourceCallsScreen, chars: REVERSE_LIMITS.sourceCharsScreen, finish: "submit" },
        { submit_screen: submitScreen },
        stageSeed,
      );
      const design = model.designs.find((d) => d.systemId === t.systemId)!;
      const screen = design.screens.find((s) => s.id === t.id)!;
      await screenSession.send(reverseScreenRequest(screenRequest(model, t.systemId, design, screen), t.name), {}, o.signal);
      throwIfAborted(o.signal);
      errorStreak = 0;
    } catch (e) {
      if (!(e instanceof ChatError) || o.signal?.aborted) throw e;
      errorStreak++;
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
  // 設計の検証: エラーは先頭 1 件を、気づいたことは種類ごとに件数をまとめて残す
  const checks = model.designs.map((d) => ({ systemId: d.systemId, ...checkDesign(model, d.systemId) }));
  const designProblems = checks.flatMap((c) => c.problems);
  if (designProblems.length > 0) warnings.push(`設計の検証: エラー ${designProblems.length} 件 (${designProblems[0]!.message}${designProblems.length > 1 ? " ほか" : ""})`);
  for (const c of checks) {
    const prefix = checks.length > 1 ? `システム「${elementName(model, c.systemId)}」: ` : "";
    for (const line of designWarningLines(c.warnings)) warnings.push(`設計の検証: ${prefix}${line}`);
  }
  const summary = `ソースコード「${tree.name}」からモデル「${model.meta.name}」を作成しました (${summarizeCounts(build.counts)})。データベース ${databases}/${dataSystems.length} システム、画面 UI ${placed}/${allTargets.length} 画面。${
    warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    build: result,
    survey,
    warnings,
    summary,
    seed: [
      { role: "user", text: `次のソースコードから業務モデルを作ってください。\n\n<ソースコードのフォルダ>${tree.name}</ソースコードのフォルダ>\n<モデルに起こしたい業務>\n${request}\n</モデルに起こしたい業務>` },
      { role: "assistant", text: `${stageSeed[1]!.text}\n\n${summary}` },
    ],
  };
}
