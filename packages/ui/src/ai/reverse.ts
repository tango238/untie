// ソースコードから作成 (リバースエンジニアリング): 選んだフォルダのソースコードを AI が道具で読み、
// 対象の業務と関連する業務を調べて、分析の要素・データ・サイトマップ・画面 UI まで入ったモデルを作る。
// 段階: 調査 → 分析モデル → データ → 画面 UI。組み立ては spec.ts と designDraft.ts に任せる。
import { setDesignDatabases, setDesignNavigation } from "@untie/core/model/commands";
import { NAME_MAX_LENGTH, textLength, truncateText } from "@untie/core/model/limits";
import { checkDesign, DESIGN_PROBLEM_ORDER, DESIGN_PROBLEM_TITLES, type DesignProblem, type DesignProblemType } from "@untie/core/model/designCheck";
import { systemInformationIds, unmappedInformationIds } from "@untie/core/model/designData";
import { designScreenName, navigationFromSitemap } from "@untie/core/model/sitemap";
import { traceToActors } from "@untie/core/model/trace";
import { ELEMENT_KIND_LABELS, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { ChatError, createChatSession, describeChatError, isTransientApiError, type ChatEvents, type ChatSession, type SeedTurn } from "./chat";
import {
  applyDatabaseDraft,
  applyDatabaseUse,
  applyScreenDraft,
  applySitemapDraft,
  readDatabaseDraft,
  readDatabaseUse,
  readScreenDraft,
  readSitemapDraft,
  resolveDatabaseName,
  SUBMIT_SCREEN_DRAFT_TOOL,
  SUBMIT_SITEMAP_TOOL,
  submitDatabaseTool,
  tableNamesOf,
  tableOverlap,
  unmappedTableNames,
  USE_DATABASE_TOOL,
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
import { combineSourceTrees, isMultiSourceTree, sourcesTitle, visibleFiles, type LabeledSource, type SourceTree } from "./sourceTree";
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

export const REVERSE_LIMITS = {
  /** 画面 UI を作る画面の数。超えた分は作らず、警告に残す */
  screens: 30,
  /**
   * 会話 (段階・システム・画面) ごとに呼べる回数。1 つの会話が全部を使い切って、あとの段階が読めなくならないようにする。
   * 1 回の生成での合計の上限は、これらの合計から決める (sourceBudget。システムの数と画面の数で増える)。
   * 1 回の send の往復の上限 (chat.ts の MAX_STEPS) より十分小さくする (conversationSteps で検査する)。読み切ったあとに、調査結果を書く往復・提出の往復・
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
  /** データ・画面 UI の会話の失敗 (ChatError と、一時的な API のエラー) が続けて起きたら、残りは作らずに終える回数 */
  screenErrorStreak: 3,
} as const;

/**
 * ソースの数に応じた、会話ごとの上限 (回数・文字数)。ソースが 1 つなら REVERSE_LIMITS のとおり。
 *
 * 方針 (ソースが複数のとき): 会話は分けず、調査は 1 つの会話のまま、上限だけを増やす。理由: ソースをまたいだつながり
 * (画面の API 呼び出し → バックエンドのハンドラー → テーブル) をたどるには、1 つの会話が全部のソースを見渡せるほうがよい。
 * ソースごとに調査の会話を分けて最後にまとめると、境目で「どの URL がどのハンドラーか」が欠け、まとめの会話でまた読み直すことになる。
 * 増やし方は 1 ソースにつき調査 +6 回 (+8 万文字) などで、上限は 1 回の会話の往復の上限 (chat.ts の MAX_STEPS = 60) と、文脈の窓
 * (20 万トークン) から決める。調査の回数は 52 回 (ソースが 3 つで頭打ち。52 回 + 返答の往復 1 = 53 < 60。conversationSteps で検査する)、
 * 文字数は 30 万 (ソースが 2 つで頭打ち) までで、ソースが増えても 30 万前後を超えない (文字数は読んだ分が会話に積み重なるため)。
 * ソースが 3 つ以上になると、1 ソースあたりの調査は薄くなる (いまの限界。ソースごとに調査の会話を分ける方法は、その先の案)。
 * データ・画面 UI の会話は、画面やシステムごとに分かれているので、少しだけ増やす。
 */
/** 会話ごとの、道具が返す文字数の上限の最大 (ソースがいくつあっても超えない。文脈の窓に収めるため) */
export const SOURCE_CHARS_CAP = { survey: 300_000, model: 120_000, data: 160_000 } as const;

export function sourceLimits(sources: number): Record<"survey" | "model" | "data" | "screen", { calls: number; chars: number }> {
  const L = REVERSE_LIMITS;
  const extra = Math.max(0, Math.floor(sources) - 1);
  return {
    survey: { calls: Math.min(52, L.sourceCallsSurvey + 6 * extra), chars: Math.min(SOURCE_CHARS_CAP.survey, L.sourceCharsSurvey + 80_000 * extra) },
    model: { calls: Math.min(20, L.sourceCallsModel + 2 * extra), chars: Math.min(SOURCE_CHARS_CAP.model, L.sourceCharsModel + 20_000 * extra) },
    data: { calls: Math.min(32, L.sourceCallsData + 4 * extra), chars: Math.min(SOURCE_CHARS_CAP.data, L.sourceCharsData + 20_000 * extra) },
    screen: { calls: Math.min(10, L.sourceCallsScreen + (extra > 0 ? 2 : 0)), chars: L.sourceCharsScreen + (extra > 0 ? 20_000 : 0) },
  };
}

/**
 * 1 回の生成でソースの道具を呼べる回数と、道具が返す文字数の合計の上限。段階ごとの上限の合計から決める:
 * 調査 1 + 分析モデル 1 + データ (システムごと) + 画面 UI (画面ごと)。固定の数にすると、システムや画面が多いとき、
 * 後ろの画面の分が残らない (調査 40 + 分析モデル 12 + データ 20×システム + 画面 8×30 画面は 312 回以上)
 */
export function sourceBudget(systems: number, screens: number, sources = 1): { calls: number; chars: number } {
  const l = sourceLimits(sources);
  return {
    calls: l.survey.calls + l.model.calls + l.data.calls * systems + l.screen.calls * screens,
    chars: l.survey.chars + l.model.chars + l.data.chars * systems + l.screen.chars * screens,
  };
}

/**
 * 会話ごとに、ソースを読む上限まで読んだあとに必要な往復の数 (まとめ・提出・出し直し・終わりの返答)。
 * どれも chat.ts の MAX_STEPS (1 回の send の往復の上限) より小さくなければならない
 */
export function conversationSteps(sources = 1): Record<"survey" | "model" | "data" | "screen", number> {
  const L = REVERSE_LIMITS;
  const l = sourceLimits(sources);
  return {
    survey: l.survey.calls + 1,
    model: l.model.calls + L.strictModelAttempts + 2,
    data: l.data.calls + L.dataRetries + 1 + 2,
    screen: l.screen.calls + L.screenRetries + 1 + 1,
  };
}

// 会話の持ち方:
// 調査と分析モデルは別の会話にし、データはシステムごと、画面 UI は画面ごとに、それぞれ新しい会話にする。
// 理由: ソースのファイルを読むたびに会話は膨らみ (1 回の読み取りで最大 3 万文字)、1 つの会話で続けると、画面 UI の段階には文脈の
// 窓も 1 回の send の往復の上限 (MAX_STEPS) も残らない。そこで、読んだ中身は捨て、調査結果の文章 (と、
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
  /** ソースの道具の全体の予算。上限は段階に入るたびに、その段階の分だけ足す (sourceBudget と同じ合計になる) */
  budget: { calls: number; chars: number; usedCalls: number; usedChars: number };
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
    if (used >= cap.calls) return errorOutcome(`この段階でソースコードを読む回数の上限 (${cap.calls} 回) に達したので、これ以上は読めません。${next}`);
    if (chars >= cap.chars) return errorOutcome(`この段階でソースコードを読んだ量の上限 (${cap.chars} 文字) に達したので、これ以上は読めません。${next}`);
    if (ctx.budget.usedCalls >= ctx.budget.calls) {
      return errorOutcome(`ソースコードを読む回数の上限 (全体で ${ctx.budget.calls} 回) に達したので、これ以上は読めません。${next}`);
    }
    if (ctx.budget.usedChars >= ctx.budget.chars) {
      return errorOutcome(`ソースコードを読んだ量の上限 (全体で ${ctx.budget.chars} 文字) に達したので、これ以上は読めません。${next}`);
    }
    used++;
    ctx.budget.usedCalls++;
    ctx.o.onSourceTool?.(SOURCE_TOOL_LABELS[name] ?? name, sourceToolDetail(name, input));
    const outcome = await executeSourceTool(ctx.tree, name, input);
    chars += outcome.content.length;
    ctx.budget.usedChars += outcome.content.length;
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

/** 名前を 3 つまで並べる (「(A、B、C ほか)」の形。無ければ空) */
function sampleNames(names: string[]): string {
  return names.length === 0 ? "" : ` (${names.slice(0, 3).join("、")}${names.length > 3 ? " ほか" : ""})`;
}

/** 検査の結果の対象 (画面・遷移の id) から、利用者に見せる名前を作る。メッセージの文字列は読み直さない */
function designNamer(model: UntieModel, systemId: string) {
  const design = model.designs.find((d) => d.systemId === systemId);
  const screenName = (id: string): string | undefined => {
    const s = design?.screens.find((x) => x.id === id);
    return s ? designScreenName(model, s) : undefined;
  };
  return {
    /** 画面の対象の名前 */
    screen: (p: DesignProblem): string | undefined => (p.target?.kind === "screen" ? screenName(p.target.id) : undefined),
    /** 遷移の対象を「A → B」の形に */
    transition: (p: DesignProblem): string | undefined => {
      const t = p.target?.kind === "transition" ? design?.transitions.find((x) => x.id === p.target!.id) : undefined;
      const from = t && screenName(t.from);
      const to = t && screenName(t.to);
      return from && to ? `${from} → ${to}` : undefined;
    },
    /** 画面 UI がまだ無い画面の名前 */
    withoutView: (): string[] => (design?.screens ?? []).filter((s) => s.view === undefined).map((s) => designScreenName(model, s)),
  };
}

const defined = (names: (string | undefined)[]): string[] => names.filter((n): n is string => !!n);

/**
 * すでにあるデータベースと重ならない名前 (「名前 (システム名)」、それも使われていれば番号を付ける)。
 * 名前は NAME_MAX_LENGTH で切られるので、後ろに付ける部分の長さを先に数え、元の名前をその分だけ切ってからつなぐ (切り落とされて同じ名前に戻らないように)。
 * 番号は、すでにある数 + 1 回までで必ず空きが見つかる。最後は、番号だけの接尾辞で必ず一意にする
 */
function uniqueDatabaseName(model: UntieModel, base: string, systemName: string): string {
  const taken = new Set(model.databases.map((d) => d.name));
  const system = truncateText(systemName.trim(), 50);
  const join = (suffix: string): string => {
    const head = truncateText(base, Math.max(1, NAME_MAX_LENGTH - textLength(suffix)));
    return `${head}${suffix}`;
  };
  const first = join(` (${system})`);
  if (!taken.has(first)) return first;
  for (let i = 2; i <= taken.size + 2; i++) {
    const n = join(` (${system}) ${i}`);
    if (!taken.has(n)) return n;
  }
  for (let i = taken.size + 3; ; i++) {
    const n = join(` ${i}`);
    if (!taken.has(n)) return n;
  }
}

const DESIGN_WARNING_TEXT: Partial<Record<DesignProblemType, (list: DesignProblem[], names: ReturnType<typeof designNamer>) => string>> = {
  screenWithoutView: (list, names) => {
    const without = names.withoutView();
    return `画面 UI がまだ無い画面が ${without.length || list.length} 件あります${sampleNames(without)}。設計モードの画面ボードで作ってください`;
  },
  transitionViaUndecided: (list, names) =>
    `きっかけが未定の遷移が ${list.length} 件あります${sampleNames(defined(list.map(names.transition)))}。サイトマップで、ボタン・一覧の行・送信のあとなどを選んでください`,
  screenUnreachable: (list, names) =>
    `メニューにも遷移にも出てこない画面が ${list.length} 件あります${sampleNames(defined(list.map(names.screen)))}。サイトマップで遷移を足すか、ナビゲーションに加えてください`,
  bindingUnmapped: (list, names) =>
    `列の対応が無い項目のある画面が ${list.length} 件あります${sampleNames(defined(list.map(names.screen)))}。画面ボードで、項目をテーブルの列に結んでください (対応するテーブルがソースに無い項目は、そのままでかまいません)`,
};

/** 検査の「気づいたこと」を、種類ごとに件数をまとめて、利用者が次に何を直せばよいか分かる文にする */
function designWarningLines(model: UntieModel, systemId: string, warnings: DesignProblem[]): string[] {
  const names = designNamer(model, systemId);
  const lines: string[] = [];
  for (const type of DESIGN_PROBLEM_ORDER) {
    const list = warnings.filter((w) => w.type === type);
    if (list.length === 0) continue;
    lines.push(DESIGN_WARNING_TEXT[type]?.(list, names) ?? `${DESIGN_PROBLEM_TITLES[type]}が ${list.length} 件あります`);
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

/** 画面 (分析の要素) の操作に関わる状態の名前 (その操作を実行できる状態と、実行後の状態)。画面 UI の一覧の例の値に使う */
function statesOfScreen(model: UntieModel, screenId: string): string[] {
  const usecases = new Set(model.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === screenId).map((r) => r.sourceId));
  if (usecases.size === 0) return [];
  const ids = model.relations.flatMap((r) =>
    r.kind === "stateUsecase" && usecases.has(r.targetId) ? [r.sourceId] : r.kind === "usecaseState" && usecases.has(r.sourceId) ? [r.targetId] : [],
  );
  const names = new Set(ids.map((id) => elementName(model, id)).filter((n) => n !== ""));
  return [...names].slice(0, 12);
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

/** 段階の会話が失敗した理由 (kind: chat = 往復の上限・長すぎ・拒否など、api = 一時的な API のエラー) */
interface StageFailure {
  kind: "chat" | "api";
  message: string;
}

/**
 * データ・画面 UI の会話の例外を、その項目だけ飛ばしてよい失敗にする。ChatError と、一時的な API のエラー (過負荷 529・500・接続断・レート制限) は飛ばす。
 * 中断、繰り返しても直らない API のエラー (キーの誤り 401/403・モデルが無い 404・リクエストの誤り 400)、判定できないものは null (呼ぶ側が投げ直して止める)
 */
function stageFailure(e: unknown, signal: AbortSignal | undefined): StageFailure | null {
  if (signal?.aborted) return null;
  if (e instanceof ChatError) return { kind: "chat", message: e.message };
  if (isTransientApiError(e)) return { kind: "api", message: describeChatError(e) };
  return null;
}

/** 失敗が続いて残りを打ち切ったときの警告。API のエラーなら「API のエラーで途中で止まりました (残りの N 件は作れませんでした)」 */
function stoppedWarning(stage: "データ" | "画面 UI", failure: StageFailure, rest: number): string {
  const streak = REVERSE_LIMITS.screenErrorStreak;
  if (failure.kind === "api") {
    return `${stage}: API のエラーで途中で止まりました (残りの ${stage === "データ" ? `${rest} システムのデータは` : `${rest} 画面の画面 UI は`}作れませんでした。${failure.message})`;
  }
  return stage === "データ"
    ? `データ: 会話が続けて ${streak} 回失敗したので、残りの ${rest} システムのデータは作りませんでした`
    : `画面 UI: 画面の会話が続けて ${streak} 回失敗したので、残りの ${rest} 画面は作りませんでした。しばらくしてから、設計モードの画面ボードで作ってください`;
}

/** パスの区切りに使う文字 (空白は、ラベルやファイル名に空白があっても使えるよう、区切りにしない) */
const PATH_DELIMITERS = /[、。,，;；:：・→⇒←()（）「」『』【】"'`<>\n\r\t]/;

/** ラベル付きのパスが始まる直前に来てよい文字 (空白・区切り・箇条書きや強調の記号)。それ以外 (文字・`/` など) の直後は、ほかのパスの途中とみなす */
const PATH_START_BEFORE = /[\s、。,，;；・→⇒←()（）「」『』【】"'`<>*[\]{}:：=|#]/;

/**
 * 画面の説明などの文章から、ラベル付きのパス (木にあるもの) を取り出す。ソースが複数のとき、画面 UI の会話の手がかりにする。
 * ラベルやパスに空白があっても拾える (ラベルで始まる箇所から、木にあるパスのうち最も長く一致するものを取る)
 */
export function sourcePathsIn(text: string, tree: SourceTree, max = 5): string[] {
  if (!isMultiSourceTree(tree)) return [];
  const known = new Set(visibleFiles(tree).map((f) => f.path));
  const found: { at: number; path: string }[] = [];
  const labels = tree.sources!.map((x) => x.label);
  for (const s of tree.sources!) {
    const head = `${s.label}/`;
    // このラベルを末尾に持つ、ほかのラベル (「画面」に対する「フロント画面」)
    const longer = labels.filter((l) => l !== s.label && l.endsWith(s.label));
    for (let from = text.indexOf(head); from >= 0; from = text.indexOf(head, from + 1)) {
      // パスの先頭、または区切りの直後だけ (ほかのパスの途中・ほかのラベルの末尾に当たらない)
      if (from > 0 && !PATH_START_BEFORE.test(text[from - 1]!)) continue;
      if (longer.some((l) => text.slice(from - (l.length - s.label.length), from + s.label.length) === l)) continue;
      // 次の区切りまで (空白は含める)。末尾の行番号 (:12)・句読点を取り、空白で区切って短くしながら、木にあるパスを探す
      const rest = text.slice(from);
      const stop = rest.search(PATH_DELIMITERS);
      let candidate = stop < 0 ? rest : rest.slice(0, stop);
      let hit: string | undefined;
      for (;;) {
        const path = candidate.replace(/(?::\d+(?:-\d+)?)?[.:]*$/, "");
        if (known.has(path)) {
          hit = path;
          break;
        }
        const cut = candidate.lastIndexOf(" ");
        if (cut <= head.length) break;
        candidate = candidate.slice(0, cut);
      }
      if (hit && !found.some((f) => f.path === hit)) found.push({ at: from, path: hit });
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max).map((f) => f.path);
}

/**
 * ソースコードを読んで、モデルを作る。source は 1 つの木か、ラベル付きの複数のソース (LabeledSource。1 つなら木と同じ扱いで、ラベルは AI への説明にだけ使う)。
 * 複数のソースは combineSourceTrees で 1 つの木にまとめ、道具 (list_files・read_file・search_code) はそのまま、パスの先頭にラベルが付く。
 * ラベルが使えない・重なるときは、読み始める前に Error
 */
export async function reverseEngineer(source: SourceTree | readonly LabeledSource[], request: string, o: ReverseOptions): Promise<ReverseResult> {
  const tree: SourceTree = "files" in source ? source : combineSourceTrees(source);
  const multi = isMultiSourceTree(tree);
  const nSources = tree.sources?.length ?? 1;
  const lim = sourceLimits(nSources);
  const ctx: Ctx = { tree, o, budget: { ...sourceBudget(0, 0, nSources), usedCalls: 0, usedChars: 0 } };
  const system = reverseSystemPrompt(multi);

  // ---- 1. 調査 ----
  throwIfAborted(o.signal);
  o.onStep?.("survey");
  const surveyRequest = reverseSurveyRequest(request, tree.name, visibleFiles(tree).length, tree.sources);
  const surveySession = openSession(
    ctx,
    system,
    [],
    { ...lim.survey, finish: "survey" },
    {},
    [],
  );
  // 調査結果は、最後のメッセージだけでなく、会話で届いた文章のすべて (途中で本文を書いてから道具を使い、最後に「以上です。」と返す場合がある)
  const collector = surveyCollector(o.onText);
  let lastReply = "";
  let surveyNote: string | undefined;
  try {
    lastReply = (await surveySession.send(surveyRequest, collector.events, o.signal)).trim();
  } catch (e) {
    throwIfAborted(o.signal);
    // 文章を集めたあとに会話が上限・拒否などで終わったときは、集めた調査結果で進める (中断と、API のエラー、集めた文章が無いときは止める)
    if (!(e instanceof ChatError) || o.signal?.aborted || collector.text() === "") throw e;
    surveyNote = `調査: 会話が途中で終わりました (${e.message})。集まった調査結果で進めました`;
  }
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
    { ...lim.model, finish: "submit" },
    { submit_model: submitModel },
    modelSeed,
  );
  try {
    await modelSession.send(reverseModelRequest(request, multi), {}, o.signal);
    throwIfAborted(o.signal);
    if (!accepted) {
      // 提出せずに終わったら、もう一度だけ頼む
      await modelSession.send("submit_model でモデル全体を提出してください。", {}, o.signal);
      throwIfAborted(o.signal);
    }
  } catch (e) {
    throwIfAborted(o.signal);
    // 受け付けたあとに会話が上限・拒否などで終わっても、受け付けたモデルで先へ進む (中断と API のエラー、受け付ける前の失敗は止める)
    if (!(e instanceof ChatError) || o.signal?.aborted || !accepted) throw e;
  }
  const build = accepted as BuildResult | null;
  if (!build) throw new ChatError("AI がモデルを提出しませんでした。起こしたい業務を具体的にして、もう一度試してください。");

  let model = build.model;
  const warnings: string[] = [...(surveyNote ? [surveyNote] : []), ...build.warnings.map((w) => `分析モデル: ${w}`)];

  // ---- 3. データ (システムごと) ----
  // データベースを作るのは、画面を持つシステムと、画面は持たないが操作の対象になっているシステム (バッチ・API だけのシステム)。
  // 画面を持たないシステムには submit_database だけの会話をする (サイトマップ・画面 UI は無し)。
  // 仕組みは、ソースの数にもシステムの数にも関わらず同じ。順は、画面を持たないシステムが先 (データを持つバックエンドのシステムが先に写す)。
  // すでにデータベースが写されているあとのシステムの依頼には、そのデータベース (名前・テーブルと列・テーブルと情報のいまの対応) を渡し、
  // そのシステムのデータが入っているなら、新しく出さず、それを使うと答えさせる (use_database。足りない対応はこの道具で足す)。
  // システムが 1 つだけなら、すでにあるデータベースは無いので、道具も依頼文も submit_database と submit_sitemap だけ。
  // すでにあるデータベースを置き換えてよいのは、そのシステムがこの会話で自分で写したものだけ。同じ名前の提出は断り、テーブルが重なる提出は 1 回だけ確かめる。
  // 設計の databaseIds は、AI の答え (写した・使うと答えた) で決める。答えが無かったシステムは、最後に推測で補い、補ったことを気づいたことに残す
  o.onStep?.("data");
  const hasScreens = (systemId: string) => model.elements.some((s) => s.kind === "screen" && s.systemId === systemId);
  const isUsecaseTarget = (systemId: string) => model.relations.some((r) => r.kind === "usecaseSystem" && r.targetId === systemId);
  const candidates = model.elements.filter((e) => e.kind === "system" && (hasScreens(e.id) || isUsecaseTarget(e.id)));
  const dataSystems = [...candidates.filter((e) => !hasScreens(e.id)), ...candidates.filter((e) => hasScreens(e.id))];
  const screenSystems = dataSystems.filter((e) => hasScreens(e.id));
  ctx.budget.calls = sourceBudget(dataSystems.length, 0, nSources).calls;
  ctx.budget.chars = sourceBudget(dataSystems.length, 0, nSources).chars;
  /** ここまでのシステムが写したデータベースの id (あとのシステムが使えるもの) */
  const sharedDbs: string[] = [];
  /** データベースを写した・使うと答えた・答えが無くて補ったシステム (見送ったものは入れない)。サマリーのデータベースの数に数える */
  const withDb = new Set<string>();
  /** AI がデータベースについて答えなかった、画面のあるシステム (会話が失敗した・打ち切られたものを含む)。最後に補う */
  const unanswered: { id: string; name: string; failed: boolean; askedSimilar: boolean }[] = [];
  /** 複数のシステムがデータを共有しうるか (システムが 2 つ以上) */
  const shareable = dataSystems.length > 1;
  let dataStreak = 0;
  let dataStopped: StageFailure | null = null;
  let dataSkipped = 0;
  for (const sys of dataSystems) {
    throwIfAborted(o.signal);
    const withScreens = hasScreens(sys.id);
    /** 画面を持たないシステムの「データベースは無い」という答えは、警告にしない */
    let dbApplied = false;
    let dbGaveUp = false;
    let dbAttempts = 0;
    /** すでにあるデータベースを使うと答えたか */
    let usedDb = false;
    let useAttempts = 0;
    /** すでにあるデータベースと同じかもしれないと確かめた (確かめるのは 1 回だけ) */
    let similarAsked = false;
    /** すでにあるデータベースと同じ名前で断った回数 */
    let nameRefusals = 0;
    /** 受け付けた提出に添える気づいたこと (別のデータベースとして通した・名前を付け替えた) */
    let dbNotes: string[] = [];
    /** 最初に受け付けた提出のデータベースの名前 (出し直しで名前が変わって、データベースが 2 つにならないように固定する) */
    let pinnedDbName: string | undefined;
    let ownDbId: string | undefined;
    let sitemapDone = false;
    let dbWarnings: string[] = [];
    let useWarnings: string[] = [];
    let sitemapWarnings: string[] = [];
    let failure: StageFailure | null = null;
    /** 前のシステムで会話の失敗が続いたので、会話をしなかった */
    let skippedHere = false;
    /** この会話を開いたときの、すでにあるデータベース (ほかのシステムが写したもの) */
    const sharedHere = [...sharedDbs];
    const dbMaxAttempts = 1 + REVERSE_LIMITS.dataRetries;
    const afterDb = () => (withScreens ? (sitemapDone ? FINISH_NOTE : "続けて submit_sitemap を提出してください") : FINISH_NOTE);
    const dbNameOf = (id: string | undefined) => model.databases.find((d) => d.id === id)?.name ?? "";
    /**
     * 出し直しの案内に添える、対応のすきま: DSL にあるのにどの情報にも結ばれていないテーブルと、どのテーブルにも結ばれていない情報。
     * テーブルは、案内する道具で結べるものだけ (submit_database はこのシステムが自分で写したデータベース、use_database はそれ以外の、すでにあるデータベース)
     */
    const gapLines = (tool: "submit_database" | "use_database"): { lines: string[]; any: boolean } => {
      const infos = unmappedInformationIds(model, sys.id).map((id) => elementName(model, id));
      const used = (model.designs.find((d) => d.systemId === sys.id)?.databaseIds ?? [])
        .filter((id) => (tool === "submit_database" ? id === ownDbId : id !== ownDbId))
        .map((id) => model.databases.find((d) => d.id === id))
        .filter((d): d is NonNullable<typeof d> => !!d);
      const tables = used.flatMap((d) => unmappedTableNames(d).map((t) => (used.length > 1 ? `${d.name}.${t}` : t)));
      const lines: string[] = [];
      if (tables.length > 0) lines.push(`DSL にあるテーブルのうち、どの情報にも結ばれていないもの: ${tables.slice(0, 20).join("、")}${tables.length > 20 ? " ほか" : ""}`);
      if (infos.length > 0) lines.push(`どのテーブルにも結ばれていない情報: ${infos.slice(0, 20).join("、")}${infos.length > 20 ? " ほか" : ""}`);
      return { lines, any: infos.length > 0 };
    };
    const submitDatabase = (input: unknown): ToolOutcome => {
      const draft = readDatabaseDraft(input);
      if (!draft) return errorOutcome("system・dsl・tables が必要です");
      // 見送ったあとの提出は受けない (何度も組み立て直さない)
      if (dbGaveUp) return okOutcome("データベースは見送りました。これ以上は受け付けません。次へ進んでください", false);
      // 受け付けたあとの出し直しにも回数の上限がある (往復を使い切らないように)
      if (dbApplied && dbAttempts >= dbMaxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${afterDb()}`, false);
      // すでにあるデータベースとテーブルが重なるもの (同じかもしれないもの) は、1 回だけ確かめる (データベースが重複して、対応が割れないように)。
      // 同じなら use_database、本当に別のデータベースなら separate_reason を添えて出し直す。確かめたあとは、理由の有無にかかわらず受け付ける (断り切らない)
      // 気づいたことは、受け付ける前の提出のたびに作り直す (断られた提出の分を残さない)
      if (!dbApplied) dbNotes = [];
      if (!dbApplied && sharedHere.length > 0) {
        const submitted = tableNamesOf({ dsl: draft.dsl });
        let same: { name: string; common: string[] } | undefined;
        for (const id of sharedHere) {
          const db = model.databases.find((d) => d.id === id);
          const overlap = db ? tableOverlap(submitted, tableNamesOf(db)) : null;
          if (db && overlap?.similar && (!same || overlap.common.length > same.common.length)) same = { name: db.name, common: overlap.common };
        }
        if (same) {
          if (!similarAsked && draft.separate_reason === undefined) {
            similarAsked = true;
            o.onSubmit?.(false, `データベース「${same.name}」と同じかもしれないので、確かめてもらっています`);
            return errorOutcome(
              `出したテーブル (${same.common.slice(0, 8).join("、")}${same.common.length > 8 ? " ほか" : ""}) が、すでにあるデータベース「${same.name}」と重なっています。同じデータベースなら、新しく出さず use_database でそのデータベースを使い、このシステムの情報を tables で結んでください。このシステム自身のスキーマ定義にある、本当に別のデータベースなら、同じ内容に separate_reason (別のデータベースである理由) を添えて、もう一度 submit_database を提出してください。確かめるのはこの 1 回だけです`,
            );
          }
          dbNotes = [
            `データ: システム「${sys.name}」: 出したデータベースは、すでにあるデータベース「${same.name}」とテーブルが重なりますが (${same.common.slice(0, 5).join("、")})、${
              draft.separate_reason ? `別のデータベースとして受け付けました (理由: ${draft.separate_reason})` : "確かめたうえで、別のデータベースとして受け付けました (理由は添えられていません)"
            }`,
          ];
        }
      }
      const attemptNo = dbAttempts + 1;
      let databaseName = dbApplied ? pinnedDbName : draft.database_name;
      const replaceableIds = ownDbId ? [ownDbId] : [];
      // 出し直しのあとも解析エラーが残るなら、エラーを警告に残して DSL をそのまま置く。ただし、いったん受け付けたあとの出し直しでは置かない
      // (壊れた DSL で、最初の正しいテーブルと情報の対応を消さない)。すでにあるデータベースは置き換えない (replaceableIds は自分で写したものだけ)
      const apply = () =>
        applyDatabaseDraft(
          model,
          { system: sys.name, dsl: draft.dsl, tables: draft.tables, ...(databaseName !== undefined ? { database_name: databaseName } : {}) },
          { acceptDslErrors: !dbApplied && attemptNo > REVERSE_LIMITS.dataRetries, replaceableIds },
        );
      let r = apply();
      if (r.nameTaken) {
        // すでにあるデータベースと同じ名前は、置き換えずに断る。2 回断っても変わらなければ、名前を付け替えて受け付ける (断り切らない。同じ名前のデータベースは 2 つにしない)
        const taken = resolveDatabaseName(sys.name, databaseName);
        nameRefusals++;
        if (nameRefusals <= 2) {
          o.onSubmit?.(false, `データベース「${taken}」はすでにあるので、別の名前にするよう頼んでいます`);
          return errorOutcome(
            `データベース「${taken}」は、すでにモデルにあります。置き換えません。${sharedHere.length > 0 ? "同じデータベースなら、新しく出さず use_database でそのデータベースを使ってください。本当に別のデータベースなら、" : ""}別の名前 (database_name) で出し直してください`,
          );
        }
        const unique = uniqueDatabaseName(model, taken, sys.name);
        databaseName = unique;
        r = apply();
        if (r.applied) dbNotes = [...dbNotes, `データ: システム「${sys.name}」: データベース「${taken}」はすでにあったので、「${unique}」の名前で受け付けました`];
      }
      dbAttempts = attemptNo;
      if (!r.applied) {
        const retriesLeft = dbMaxAttempts - dbAttempts;
        if (dbApplied && retriesLeft <= 0) return okOutcome(`出し直しは通らなかったので、前の提出のままにします。${afterDb()}`, false);
        if (r.dslErrors.length > 0 || dbAttempts <= REVERSE_LIMITS.dataRetries) {
          const detail = r.dslErrors.slice(0, 10).map((e) => `${e.line} 行 ${e.column} 列: ${e.message}`);
          const message = r.dslErrors.length > 0 ? `DSL に解析エラーがあります。直して出し直してください:\n- ${detail.join("\n- ")}` : `${r.failure ?? "データベースを足せませんでした"}。直して出し直してください`;
          o.onSubmit?.(false, "データベースの定義を直してもらっています");
          return errorOutcome(message);
        }
        if (dbApplied) return okOutcome(`出し直しは通らなかったので、前の提出のままにします。${afterDb()}`, false);
        dbGaveUp = true;
        dbWarnings = r.warnings;
        o.onSubmit?.(false, `データ: システム「${sys.name}」のデータベースは足せませんでした`);
        return okOutcome("データベースは足せなかったので、見送ります。次へ進んでください", false);
      }
      if (!dbApplied) pinnedDbName = databaseName;
      model = r.model;
      dbApplied = true;
      ownDbId = r.databaseId;
      dbWarnings = [...dbNotes, ...r.warnings];
      const message = `受け付けました: テーブル ${r.added.tables}、情報 ${r.added.informations}${r.dslErrors.length > 0 ? ` (DSL の解析エラー ${r.dslErrors.length} 件は残っています)` : ""}`;
      o.onSubmit?.(true, message);
      const retriesLeft = dbMaxAttempts - dbAttempts;
      // 未対応の情報の警告は、下の「対応のすきま」で言い分けて示すので、ここでは除く
      const others = r.warnings.filter((w) => !/がどのテーブルにも対応していません/.test(w));
      const note = revisionNote(others, retriesLeft, "submit_database", "");
      const gap = gapLines("submit_database");
      const gapNote =
        gap.any && retriesLeft > 0
          ? `\n${gap.lines.join("\n")}\nテーブルが DSL にあるのに対応が無い情報は、tables に足して submit_database を出し直してください (あと ${retriesLeft} 回まで)。対応するテーブルがソースに無い情報だけ、直さなくてかまいません`
          : "";
      const again = note !== "" || gapNote !== "";
      return okOutcome(`${message}${note}${gapNote}${!again || retriesLeft <= 0 ? `\n${afterDb()}` : ""}`, true);
    };
    /** すでにあるデータベースを使うと答える。足りない対応を足し、未対応の情報が残れば、候補のテーブルを添えて出し直しを求める */
    const submitUse = (input: unknown): ToolOutcome => {
      const draft = readDatabaseUse(input);
      if (!draft) return errorOutcome("system・database・tables が必要です");
      if (useAttempts >= dbMaxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${afterDb()}`, false);
      const wanted = draft.database.trim();
      const target = sharedHere.map((id) => model.databases.find((d) => d.id === id)).find((d) => d && (d.id === wanted || d.name === wanted));
      if (!target) {
        const names = sharedHere.map(dbNameOf).filter((n) => n !== "");
        return errorOutcome(`データベース「${draft.database}」は、すでにあるデータベースにありません。次のどれかの名前で指してください: ${names.map((n) => `「${n}」`).join("")}`);
      }
      useAttempts++;
      const r = applyDatabaseUse(model, { ...draft, system: sys.name, database: target.id });
      if (!r.applied) return errorOutcome(`${r.failure ?? "データベースを使えませんでした"}。直して出し直してください`);
      model = r.model;
      usedDb = true;
      useWarnings = r.warnings;
      const message = `受け付けました: データベース「${target.name}」を使います (対応を足したテーブル ${r.added.tables}、情報 ${r.added.informations})`;
      o.onSubmit?.(true, message);
      const retriesLeft = dbMaxAttempts - useAttempts;
      const gap = gapLines("use_database");
      const others = r.warnings.filter((w) => !/がどのテーブルにも対応していません/.test(w));
      const note = revisionNote(others, retriesLeft, "use_database", "");
      if (gap.any && retriesLeft > 0) {
        return okOutcome(
          `${message}${note}\n${gap.lines.join("\n")}\nこのシステムの情報で、テーブルが DSL にあるのに対応が無いものは、tables に足して use_database を出し直してください (あと ${retriesLeft} 回まで。足した対応は残ります)。対応するテーブルがソースに無い情報だけ、直さなくてかまいません`,
          true,
        );
      }
      return okOutcome(`${message}${note}${note === "" || retriesLeft <= 0 ? `\n${afterDb()}` : ""}`, true);
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
      return okOutcome(`${message}。${dbApplied || usedDb || dbGaveUp ? FINISH_NOTE : "続けて submit_database か use_database を提出してください"}`, true);
    };
    if (dataStopped) {
      // 前のシステムで会話の失敗が続いたので、会話はしない。画面は設計に足す (下の空の遷移)
      dataSkipped++;
      skippedHere = true;
    } else {
      try {
        // システムが 1 つだけなら、すでにあるデータベースは無く、道具は submit_database (と submit_sitemap) だけ
        const submitTool = submitDatabaseTool({ shareable, existing: sharedHere.length > 0 });
        const dbTools = sharedHere.length > 0 ? [submitTool, USE_DATABASE_TOOL] : [submitTool];
        const handlers: Record<string, (input: unknown) => ToolOutcome> = { submit_database: submitDatabase, ...(sharedHere.length > 0 ? { use_database: submitUse } : {}) };
        const dataSession = openSession(
          ctx,
          system,
          withScreens ? [...dbTools, SUBMIT_SITEMAP_TOOL] : dbTools,
          { ...lim.data, finish: "submit" },
          withScreens ? { ...handlers, submit_sitemap: submitSitemap } : handlers,
          stageSeed,
        );
        await dataSession.send(reverseDataRequest(model, sys.id, multi, sharedHere, shareable), {}, o.signal);
        throwIfAborted(o.signal);
        // 画面を持たないシステムは、ソースにスキーマ定義が無ければ (社外のシステムなど) 提出しない答えが正しいので、頼み直さない
        // (会話が失敗したシステムも頼み直さない)。
        // 画面のあるシステムは、データベースを写すか、すでにあるデータベースを使うか、どちらかの答えが要る
        if (withScreens && !dbApplied && !usedDb && !dbGaveUp) {
          await dataSession.send(
            sharedHere.length > 0
              ? "すでにあるデータベースを使うなら use_database で、このシステムのソースに別のスキーマ定義があるなら submit_database で、データベースについて答えてください。"
              : "submit_database でデータベースを提出してください。",
            {},
            o.signal,
          );
          throwIfAborted(o.signal);
        }
      } catch (e) {
        // 中断と、繰り返しても直らない API のエラー (キーの誤りなど) は、このまま止める。
        // 会話の上限などで終わったときと、一時的な API のエラー (過負荷・接続断など) は、このシステムだけ飛ばす
        failure = stageFailure(e, o.signal);
        if (!failure) throw e;
        warnings.push(`データ: システム「${sys.name}」: ${failure.message}`);
      }
      if (failure) {
        dataStreak++;
        if (dataStreak >= REVERSE_LIMITS.screenErrorStreak) dataStopped = failure;
      } else dataStreak = 0;
    }
    if (dbApplied) {
      withDb.add(sys.id);
      if (ownDbId) sharedDbs.push(ownDbId);
    }
    if (usedDb) withDb.add(sys.id);
    // システムが 1 つだけのときは、画面の有無に関係なく、データベースが無いまま終わったことを気づいたことに残す (ほかのシステムのデータで補えず、気づけないので)
    if (dataSystems.length === 1 && !withScreens && !dbApplied && !usedDb && !dbGaveUp && !failure && !skippedHere) {
      warnings.push(`データ: システム「${sys.name}」のデータベースは作られませんでした (AI が、このシステム自身のスキーマ定義はソースに無いと答えました。ソースにあるはずなら、設計モードで足してください)`);
    }
    // 画面のあるシステムが、データベースについて答えなかったときは、最後に補う (会話が失敗したときも)
    if (withScreens && !dbApplied && !usedDb && !dbGaveUp) unanswered.push({ id: sys.id, name: sys.name, failed: !!failure || skippedHere, askedSimilar: similarAsked });
    warnings.push(...dbWarnings, ...useWarnings);
    // 画面を設計に足すため、AI が遷移を出さなくても、空の遷移で必ず足す
    if (withScreens && !sitemapDone) {
      const r = applySitemapDraft(model, { system: sys.name, transitions: [] });
      model = r.model;
      sitemapWarnings = r.warnings;
    }
    warnings.push(...sitemapWarnings);
  }
  if (dataStopped) warnings.push(stoppedWarning("データ", dataStopped, dataSkipped));

  // ---- AI がデータベースについて答えなかった画面のシステム ----
  // 設計の規則では、使うデータベースが空だと先頭のデータベース (どのシステムのものか分からない) が使われてしまう。そこで、
  // そのシステムの情報を表すテーブルを最も多く持つデータベースに結び (推測)、結んだことを気づいたことに残す。当たるものが無ければ結ばない
  for (const w of unanswered) {
    const infoIds = new Set(systemInformationIds(model, w.id));
    let best: { id: string; name: string; count: number } | null = null;
    for (const id of sharedDbs) {
      const db = model.databases.find((d) => d.id === id);
      const count = db ? db.tables.filter((t) => t.informationIds.some((i) => infoIds.has(i))).length : 0;
      if (db && count > 0 && (!best || count > best.count)) best = { id, name: db.name, count };
    }
    const r = best ? setDesignDatabases(model, { systemId: w.id, databaseIds: [best.id] }) : null;
    if (best && r?.ok) {
      model = r.model;
      withDb.add(w.id);
      warnings.push(`データ: システム「${w.name}」: AI がデータベースを答えなかったので、このシステムの情報を表すテーブルが最も多いデータベース「${best.name}」に結びました (テーブル ${best.count} 件。推測です)`);
    } else if (!w.failed) {
      warnings.push(
        w.askedSimilar
          ? `データ: システム「${w.name}」: すでにあるデータベースと同じかどうかを確かめたあと、AI がデータベースを答えなかったので、データベースは作りませんでした${sharedDbs.length > 0 ? " (すでにあるデータベースにも、このシステムの情報を表すテーブルがなく、結べません)" : ""}`
          : `データ: システム「${w.name}」: AI がデータベースを提出しなかったので、データベースは作りませんでした${sharedDbs.length > 0 ? " (すでにあるデータベースにも、このシステムの情報を表すテーブルがなく、結べません)" : ""}`,
      );
    }
  }

  // ---- ナビゲーション (メニュー) ----
  // サイトマップの業務の分け方から作る。作らないと、設計の検証に「メニューからも遷移からも辿れない画面」が残る
  for (const sys of screenSystems) {
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
  ctx.budget.calls = sourceBudget(dataSystems.length, todo.length, nSources).calls;
  ctx.budget.chars = sourceBudget(dataSystems.length, todo.length, nSources).chars;
  if (targets.length > todo.length) {
    const rest = targets.slice(todo.length);
    warnings.push(`画面 UI: 画面が ${targets.length} 件あり、上限 ${REVERSE_LIMITS.screens} 件を超えたので、後ろの ${rest.length} 件は作りませんでした (${rest.slice(0, 5).map((t) => `「${t.name}」`).join("")}${rest.length > 5 ? " ほか" : ""})`);
  }
  let done = 0;
  let placed = 0;
  let errorStreak = 0;
  let lastFailure: StageFailure | null = null;
  for (const t of todo) {
    throwIfAborted(o.signal);
    // 画面の会話の失敗 (拒否・返答なし・長すぎ・一時的な API のエラー) が続くなら、同じ失敗を繰り返さずに終える
    if (errorStreak >= REVERSE_LIMITS.screenErrorStreak && lastFailure) {
      warnings.push(stoppedWarning("画面 UI", lastFailure, todo.length - done));
      break;
    }
    let applied = false;
    let gaveUp = false;
    let failure: StageFailure | null = null;
    let attempt = 0;
    let screenWarnings: string[] = [];
    const sysName = elementName(model, t.systemId);
    const screenMaxAttempts = 1 + REVERSE_LIMITS.screenRetries;
    const submitScreen = (input: unknown): ToolOutcome => {
      const draft = readScreenDraft(input);
      if (!draft) return errorOutcome("screen・view・bindings が必要です");
      if (draft.screen.trim() !== t.name) return errorOutcome(`この会話で作る画面は「${t.name}」だけです (「${draft.screen}」ではありません)`);
      // 見送ったあとの提出は受けない (何度も組み立て直さない)
      if (gaveUp) return okOutcome(`この画面の画面 UI は見送りました。これ以上は受け付けません。${FINISH_NOTE}`, false);
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
        { ...lim.screen, finish: "submit" },
        { submit_screen: submitScreen },
        stageSeed,
      );
      const design = model.designs.find((d) => d.systemId === t.systemId)!;
      const screen = design.screens.find((s) => s.id === t.id)!;
      const description = model.elements.find((e) => e.id === t.analysisId)?.description ?? "";
      const hint = multi ? { labels: tree.sources!.map((x) => x.label), paths: sourcePathsIn(description, tree) } : undefined;
      await screenSession.send(reverseScreenRequest(screenRequest(model, t.systemId, design, screen), t.name, hint, statesOfScreen(model, t.analysisId)), {}, o.signal);
      throwIfAborted(o.signal);
      errorStreak = 0;
    } catch (e) {
      failure = stageFailure(e, o.signal);
      if (!failure) throw e;
      errorStreak++;
      lastFailure = failure;
      warnings.push(`画面 UI: 画面「${t.name}」: ${failure.message}`);
    }
    // 会話が失敗したときは、その警告だけ (同じことを 2 件に分けない)
    if (!applied && !gaveUp && !failure && screenWarnings.length === 0) warnings.push(`画面 UI: 画面「${t.name}」: AI が画面 UI を提出しなかったので、作りませんでした`);
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
    for (const line of designWarningLines(model, c.systemId, c.warnings)) warnings.push(`設計の検証: ${prefix}${line}`);
  }
  const summary = `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}からモデル「${model.meta.name}」を作成しました (${summarizeCounts(build.counts)})。データベース ${withDb.size}/${dataSystems.length} システム、画面 UI ${placed}/${allTargets.length} 画面。${
    warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    build: result,
    survey,
    warnings,
    summary,
    seed: [
      { role: "user", text: `次のソースコードから業務モデルを作ってください。\n\n<ソースコードのフォルダ>${multi ? `\n${tree.sources!.map((x) => `${x.label}: ${x.folder}`).join("\n")}\n` : tree.name}</ソースコードのフォルダ>\n<モデルに起こしたい業務>\n${request}\n</モデルに起こしたい業務>` },
      { role: "assistant", text: `${stageSeed[1]!.text}\n\n${summary}` },
    ],
  };
}
