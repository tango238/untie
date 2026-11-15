// 「ソースコードから作成」の段階 (データ・画面・業務) が共有する土台: 上限・ソースの道具の実行・会話の開き方・失敗の扱い・設計の検証の文。
// 段階ごとの処理は reverseData.ts (データ。AI なし)・reverseScreens.ts (画面)・reverseLogic.ts (業務) にある。
import { DESIGN_PROBLEM_ORDER, DESIGN_PROBLEM_TITLES, type DesignProblem, type DesignProblemType } from "@untie/core/model/designCheck";
import { designScreenName } from "@untie/core/model/sitemap";
import type { UntieModel } from "@untie/core/model/types";
import { ChatError, createChatSession, describeChatError, isTransientApiError, type ChatEvents, type ChatSession, type SeedTurn } from "./chat";
import type { ProviderId } from "./providers";
import { executeSourceTool, isSourceTool, SOURCE_TOOLS } from "./sourceTools";
import { isMultiSourceTree, visibleFiles, type SourceTree } from "./sourceTree";
import type { ToolDef, ToolOutcome } from "./tools";

/** 段階の実行の共通の設定 */
export interface StageOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
  /** 段階の中の手順が替わったとき (step は段階ごとの名前) */
  onStep?: (step: string) => void;
  /** 調査結果の文章が届いたとき */
  onText?: (delta: string) => void;
  /** AI がソースコードを読む道具を使ったとき (name は「読む」「探す」「一覧」の短い日本語、detail は読んだファイルやフォルダ、検索なら検索語。画面には「name detail」と出す) */
  onSourceTool?: (name: string, detail: string) => void;
  /** 提出と検査の結果 (message は利用者に見せる短い文。AI に返す文とは別) */
  onSubmit?: (accepted: boolean, message: string) => void;
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
 * 画面の段階 (調査 1 + 画面の構成 1 + 画面ごとの画面 UI) の 1 回の実行で、ソースの道具を呼べる回数と、道具が返す文字数の合計の上限。
 * 段階ごとの上限の合計から決める。固定の数にすると、画面が多いとき、後ろの画面の分が残らない
 */
export function screensBudget(screens: number, sources = 1): { calls: number; chars: number } {
  const l = sourceLimits(sources);
  return { calls: l.survey.calls + l.model.calls + l.screen.calls * screens, chars: l.survey.chars + l.model.chars + l.screen.chars * screens };
}

/** 業務の段階 (調査 1 + 業務のモデル 1 + 対応を付けるシステムごとの会話) の、ソースの道具の合計の上限 */
export function logicBudget(systems: number, sources = 1): { calls: number; chars: number } {
  const l = sourceLimits(sources);
  return { calls: l.survey.calls + l.model.calls + l.data.calls * systems, chars: l.survey.chars + l.model.chars + l.data.chars * systems };
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

export const ABORT_MESSAGE = "中断しました。";
/** 中断されていたら例外を投げる (どの段階でも、道具の呼び出しと会話の切れ目で見る) */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException(ABORT_MESSAGE, "AbortError");
}

export const errorOutcome = (message: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: message }), changed: false });
export const okOutcome = (message: string, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify({ result: message }), changed });

/** 通知に出す、道具の名前 (画面に「name detail」と出るので、短い日本語にする) */
const SOURCE_TOOL_LABELS: Record<string, string> = { list_files: "一覧", read_file: "読む", search_code: "探す" };

/** 通知に出す、道具の対象 (読むパス・探す語) */
export function sourceToolDetail(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = name === "search_code" ? i.pattern : name === "list_files" ? i.path || "/" : i.path;
  return typeof text === "string" ? text.slice(0, 200) : "";
}

export interface Ctx {
  tree: SourceTree;
  o: StageOptions;
  /** ソースの道具の全体の予算。上限は段階に入るたびに、その段階の分だけ足す (sourceBudget と同じ合計になる) */
  budget: { calls: number; chars: number; usedCalls: number; usedChars: number };
}

/** 会話ごとのソースの道具の上限と、上限に達したときに AI へ伝えること (調査は「まとめる」、提出のある段階は「提出する」) */
export interface SourceCap {
  calls: number;
  chars: number;
  finish: "survey" | "submit";
}

/** ソースの道具の実行。回数・文字数の上限を超えたら、実行せずに「まとめる・分かった範囲で提出する」よう結果で伝える */
export function sourceRunner(ctx: Ctx, cap: SourceCap): (name: string, input: unknown) => Promise<ToolOutcome> {
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
export function openSession(
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

export const elementName = (model: UntieModel, id: string) => model.elements.find((e) => e.id === id)?.name ?? "";

/** 提出を受け付けたあとの気づいたこと (先頭 REVERSE_LIMITS.revisionWarnings 件) を、AI に返す文にする。残りの出し直しの回数があれば、直せるなら出し直してよいと伝える */
export function revisionNote(warnings: string[], retriesLeft: number, tool: string, ignorable: string): string {
  if (warnings.length === 0) return "";
  const shown = warnings.slice(0, REVERSE_LIMITS.revisionWarnings);
  const list = `気づいたこと ${warnings.length} 件${warnings.length > shown.length ? ` (先頭 ${shown.length} 件)` : ""}:\n- ${shown.join("\n- ")}`;
  return retriesLeft > 0
    ? `\n${list}\n直せるものがあれば、${tool} を出し直してよい (あと ${retriesLeft} 回まで)。${ignorable}`
    : `\n${list}\n(出し直しの回数の上限に達したので、このまま受け付けました)`;
}

// ---------------------------------------------------------------- 設計の検証の警告を、利用者向けの文にする

/** 名前を 3 つまで並べる (「(A、B、C ほか)」の形。無ければ空) */
export function sampleNames(names: string[]): string {
  return names.length === 0 ? "" : ` (${names.slice(0, 3).join("、")}${names.length > 3 ? " ほか" : ""})`;
}

/** 検査の結果の対象 (画面・遷移の id) から、利用者に見せる名前を作る。メッセージの文字列は読み直さない */
export function designNamer(model: UntieModel, systemId: string) {
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
export function designWarningLines(model: UntieModel, systemId: string, warnings: DesignProblem[]): string[] {
  const names = designNamer(model, systemId);
  const lines: string[] = [];
  for (const type of DESIGN_PROBLEM_ORDER) {
    const list = warnings.filter((w) => w.type === type);
    if (list.length === 0) continue;
    lines.push(DESIGN_WARNING_TEXT[type]?.(list, names) ?? `${DESIGN_PROBLEM_TITLES[type]}が ${list.length} 件あります`);
  }
  return lines;
}

/** 画面 (分析の要素) の操作に関わる状態の名前 (その操作を実行できる状態と、実行後の状態)。画面 UI の一覧の例の値に使う */
export function statesOfScreen(model: UntieModel, screenId: string): string[] {
  const usecases = new Set(model.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === screenId).map((r) => r.sourceId));
  if (usecases.size === 0) return [];
  const ids = model.relations.flatMap((r) =>
    r.kind === "stateUsecase" && usecases.has(r.targetId) ? [r.sourceId] : r.kind === "usecaseState" && usecases.has(r.sourceId) ? [r.targetId] : [],
  );
  const names = new Set(ids.map((id) => elementName(model, id)).filter((n) => n !== ""));
  return [...names].slice(0, 12);
}

/** 調査の会話で届いた文章を、段落の区切りを保ってすべて貯める (道具を使った前後は段落を分ける) */
export function surveyCollector(onText: ((delta: string) => void) | undefined): { events: ChatEvents; text: () => string } {
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
export interface StageFailure {
  kind: "chat" | "api";
  message: string;
}

/**
 * データ・画面 UI の会話の例外を、その項目だけ飛ばしてよい失敗にする。ChatError と、一時的な API のエラー (過負荷 529・500・接続断・レート制限) は飛ばす。
 * 中断、繰り返しても直らない API のエラー (キーの誤り 401/403・モデルが無い 404・リクエストの誤り 400)、判定できないものは null (呼ぶ側が投げ直して止める)
 */
export function stageFailure(e: unknown, signal: AbortSignal | undefined): StageFailure | null {
  if (signal?.aborted) return null;
  if (e instanceof ChatError) return { kind: "chat", message: e.message };
  if (isTransientApiError(e)) return { kind: "api", message: describeChatError(e) };
  return null;
}

/** 失敗が続いて残りを打ち切ったときの警告。API のエラーなら「API のエラーで途中で止まりました (残りの N 件は作れませんでした)」 */
export function stoppedWarning(stage: "データ" | "画面 UI", failure: StageFailure, rest: number): string {
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