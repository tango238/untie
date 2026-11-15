import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { designScreenName } from "@untie/core/model/sitemap";
import type { UntieModel } from "@untie/core/model/types";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError, isAbortError } from "../../ai/chat";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { AGENT_BUSY_REASON, commitStageModel } from "../../ai/reverseCommit";
import { applyMappingSuggestions, mappingGap, reverseLogic, reverseMapping, suggestMappings } from "../../ai/reverseLogic";
import { trackUsage, usageLine } from "../../ai/reverse";
import { reverseScreens } from "../../ai/reverseScreens";
import { recallSources, rememberSources } from "../../ai/sourceRegistry";
import { forgetScreenSurvey, recallScreenSurvey, rememberScreenSurvey } from "../../ai/surveyMemory";
import {
  MAX_SOURCES,
  MAX_SOURCE_LABEL_CHARS,
  MAX_TREE_FILES,
  labelKey,
  looksSameSource,
  sourceLabelProblems,
  sourcesTitle,
  tidySourceLabel,
  visibleFiles,
  type LabeledSource,
  type SourceTree,
} from "../../ai/sourceTree";
import { getPlatform } from "../../platform";
import { useUntieStore } from "../../store";
import { SourceDataCard, type StageDone } from "./SourceDataCard";

/** 段階 (カードの並び) */
export type StageId = "data" | "screens" | "logic" | "mapping";

/** AI を使う段階の中の手順 (順に進む)。進み具合の表示に使う */
const STAGE_STEPS: Record<"screens" | "logic" | "mapping", { step: string; label: string }[]> = {
  mapping: [{ step: "tables", label: "テーブルと情報を結ぶ" }],
  screens: [
    { step: "survey", label: "ソースコードを調べる" },
    { step: "structure", label: "画面の構成を作る" },
    { step: "ui", label: "画面 UI を作る" },
  ],
  logic: [
    { step: "survey", label: "ソースコードを調べる" },
    { step: "model", label: "業務のモデルを作る" },
    { step: "tables", label: "テーブルと情報を結ぶ" },
  ],
};

const STAGE_LABELS: Record<StageId, string> = { data: "データ", screens: "画面", logic: "業務", mapping: "テーブルと情報の対応" };

/** 画面に出す、読んだ場所の件数 */
const RECENT_READS = 5;

/** ラベルの候補 (足した行に、使っていないものを順に入れる。自由に書き換えられる) */
export const SOURCE_LABEL_CANDIDATES = ["バックエンド", "管理画面", "フロント画面", "バッチ", "共通ライブラリ", "モバイルアプリ"] as const;

/** 行の番号 (0 始まり) に合う候補。使われていれば、使っていない候補の先頭 (すべて使っていれば空)。1 つ目のラベルがフォルダ名でも、2 つ目が「管理画面」から始まらないように、番号を先に見る */
const nextCandidate = (used: readonly string[], index: number): string => {
  const keys = new Set(used.map(labelKey));
  const byIndex = SOURCE_LABEL_CANDIDATES[index];
  if (byIndex !== undefined && !keys.has(labelKey(byIndex))) return byIndex;
  return SOURCE_LABEL_CANDIDATES.find((c) => !keys.has(labelKey(c))) ?? "";
};

/** 空のラベルへ自動で入れる値。フォルダ名を規則に合う形に整えたもの (ほかの行と重なる・整えて空になるなら、使っていない候補) */
const autoLabel = (folderName: string | undefined, used: readonly string[], index: number): string => {
  const tidy = folderName ? tidySourceLabel(folderName) : "";
  return tidy !== "" && !used.some((u) => labelKey(u) === labelKey(tidy)) ? tidy : nextCandidate(used, index);
};

/**
 * 畳んだ要約に出す、ソースの呼び名。1 つだけのときは「ソースコード「フォルダ名」」 (ラベルは出さない。sourcesTitle と同じ)。
 * 複数のときは「ソースコード N か所 (ラベル・ラベル…)」で、ラベルが空の行はフォルダ名、フォルダも選んでいなければ「未選択」
 */
const summaryTitle = (rows: readonly SourceRow[]): string =>
  rows.length === 1 ? sourcesTitle([{ label: rows[0]!.label.trim(), folder: rows[0]!.tree?.name ?? "" }]) : `ソースコード ${rows.length} か所 (${rows.map((r) => r.label.trim() || r.tree?.name || "未選択").join("・")})`;

/** 登録したソース (ソースコードのフォルダ) の 1 行 */
interface SourceRow {
  key: number;
  label: string;
  tree: SourceTree | null;
  /** 読めるファイルの数 (選んだときに 1 度だけ数える。2 万件で約 22ms) */
  fileCount: number;
  /** フォルダを選んだ回数 (同じ名前の別のフォルダに選び直したときも、同じフォルダの警告を見直すきっかけにする) */
  picks: number;
}

/** 段階の進み具合 (いまのモデルの状態から導く) */
export function stageProgress(model: UntieModel): Record<StageId, { text: string; done: boolean }> {
  const dbs = model.databases.map((d) => parsePrismaDslCached(d.dsl).models.length).filter((n) => n > 0);
  const tables = dbs.reduce((a, b) => a + b, 0);
  const screens = model.elements.filter((e) => e.kind === "screen").length;
  const withView = model.designs.reduce((n, d) => n + d.screens.filter((s) => s.source.kind === "screen" && s.view !== undefined).length, 0);
  const businesses = model.elements.filter((e) => e.kind === "business").length;
  const gap = mappingGap(model);
  return {
    mapping: { text: gap.informations > 0 ? `未対応の情報 ${gap.informations}・テーブル ${gap.tables}` : tables > 0 ? "未対応の情報はありません" : "まだ", done: tables > 0 && gap.informations === 0 },
    data: { text: dbs.length > 0 ? `データベース ${dbs.length} つ・テーブル ${tables}` : "まだ", done: dbs.length > 0 },
    screens: { text: screens > 0 ? `画面 ${screens} (画面 UI ${withView})` : "まだ", done: screens > 0 },
    logic: { text: businesses > 0 ? `業務 ${businesses}` : "まだ", done: businesses > 0 },
  };
}

/**
 * 終わった段階のあとに勧める段階 (無ければ null)。前の段階が無いと精度が落ちるので、その順で勧める (止めはしない)。
 * どの段階のあとでも、どのテーブルにも対応していない情報と、どの情報にも対応していないテーブルの両方があれば、最後に「テーブルと情報の対応」を勧める
 * (データを後から取り込んだとき・業務のあとにデータを取り込んだときなど、業務の段階の最後の対応付けが走らなかった組み合わせのため)
 */
export function recommendNext(model: UntieModel, justDone: StageId): { stage: StageId; reason: string } | null {
  const p = stageProgress(model);
  const missingUi = model.designs.some((d) => d.screens.some((s) => s.source.kind === "screen" && s.view === undefined)) || model.elements.some((e) => e.kind === "screen" && !model.designs.some((d) => d.screens.some((s) => s.source.kind === "screen" && s.source.screenId === e.id)));
  const gap = mappingGap(model);
  const mapping = gap.informations > 0 && gap.tables > 0 ? { stage: "mapping" as const, reason: `どのテーブルにも対応していない情報が ${gap.informations} 件、どの情報にも対応していないテーブルが ${gap.tables} 件あります。業務のカードの「テーブルと情報を結ぶ」で対応を付けられます` } : null;
  if (justDone === "data") {
    if (!p.screens.done) return { stage: "screens", reason: "画面の項目を、取り込んだテーブルの列に結べます" };
    if (!p.logic.done) return { stage: "logic", reason: "業務を作ると、テーブルと情報の対応も付きます" };
    return mapping;
  }
  if (justDone === "screens") {
    if (!p.logic.done) return { stage: "logic", reason: "画面を使う操作と、業務を作ります" };
    return mapping;
  }
  if (justDone === "logic") {
    if (!p.data.done) return { stage: "data", reason: "データベースがまだ無いので、テーブルと情報の対応を付けられていません" };
    if (missingUi) return { stage: "screens", reason: "画面 UI がまだ無い画面があります" };
    return mapping;
  }
  return missingUi && p.data.done ? { stage: "screens", reason: "画面 UI がまだ無い画面があります" } : null;
}

/** 画面 UI を作り直す画面の候補 (画面 UI がすでにあるもの) */
function rebuildCandidates(model: UntieModel): { key: string; system: string; screen: string }[] {
  return model.designs.flatMap((d) => {
    const system = model.elements.find((e) => e.id === d.systemId)?.name ?? "";
    return d.screens.flatMap((s) => (s.source.kind === "screen" && s.view !== undefined ? [{ key: `${system}\n${designScreenName(model, s)}`, system, screen: designScreenName(model, s) }] : []));
  });
}

/** 画面に出す、段階の結果 (終わったあとに、閉じずに見せる) */
interface StageResultView {
  stage: StageId;
  summary: string;
  /** AI の使用量の 1 行 (段階が AI を使ったときだけ) */
  usage: string;
  warnings: string[];
  next: { stage: StageId; reason: string } | null;
}

const NEW_ROW = (key: number): SourceRow => ({ key, label: "", tree: null, fileCount: 0, picks: 0 });

/** ファイル > ソースコードから作成: ソースコードを、データ → 画面 → 業務 の 3 つの段階で、開いているモデルに足していく */
export function CreateFromSourceDialog({ onClose }: { onClose: () => void }) {
  const settings = useAgentStore((s) => s.settings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const agentRunning = useAgentStore((s) => s.running);
  const agentBase = useUntieStore((s) => s.agentBase);
  const model = useUntieStore((s) => s.model);
  const docSeq = useUntieStore((s) => s.docSeq);
  const nextKey = useRef(1);
  // 登録したソースは、このアプリを開いている間は覚えている (別のモデルを開いたら忘れる)。開き直したら、覚えているものを出す
  const [rows, setRows] = useState<SourceRow[]>(() => {
    const remembered = recallSources(useUntieStore.getState().docSeq);
    if (remembered.length === 0) return [NEW_ROW(0)];
    return remembered.map((r, i) => {
      nextKey.current = i + 1;
      return { key: i, label: r.label, tree: r.tree, fileCount: r.fileCount, picks: r.tree ? 1 : 0 };
    });
  });
  /** 同じフォルダを重ねて登録しているらしい行 (key → 先に登録した行の番号 (1 始まり)) */
  const [duplicates, setDuplicates] = useState<Map<number, number>>(new Map());
  /** 足した行のラベルの入力欄へフォーカスを移す (行の key) */
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /** ラベルの欄を一度離れた行 (空のラベルのエラーは、離れてから出す。足した直後から読み上げられないように) */
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const labelInputs = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const datalistId = useId();
  const [request, setRequest] = useState("");
  const [scope, setScope] = useState("");
  const [rebuild, setRebuild] = useState<ReadonlySet<string>>(new Set());
  /** いま実行している AI の段階 (データの段階は、その場で終わるので入らない) */
  const [running, setRunning] = useState<"screens" | "logic" | "mapping" | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [survey, setSurvey] = useState("");
  const [reads, setReads] = useState<string[]>([]);
  const [readCount, setReadCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [screen, setScreen] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<StageResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickingKey, setPickingKey] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** 段階を始めている最中か (「進める」の二度押しで 2 本走らせない) */
  const starting = useRef(false);
  const mounted = useRef(true);
  // ダイアログが外れたら段階を止める (結果が届いても、今のモデルに反映しない)
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  // 登録したソースを、覚えておく (ファイルにもモデルにも保存しない。メモリの中だけ)
  useEffect(() => {
    rememberSources(
      docSeq,
      rows.map((r) => ({ label: r.label, tree: r.tree, fileCount: r.fileCount })),
    );
  }, [rows, docSeq]);
  const provider = PROVIDERS[settings.provider];
  const aiModel = settings.models[settings.provider] || provider.defaultModel;
  const multi = rows.length > 1;
  const busy = running !== null;
  // ラベルの検査: ソースが 1 つならラベルは任意 (あれば形だけ見る)、2 つ以上なら必須で、重複も見る
  const labelProblems: (string | null)[] = multi
    ? sourceLabelProblems(rows.map((r) => r.label.trim()))
    : rows.map((r) => (r.label.trim() === "" ? null : sourceLabelProblems([r.label.trim()])[0]!));
  const totalFiles = rows.reduce((n, r) => n + r.fileCount, 0);
  const anyDepthTruncated = rows.some((r) => r.tree?.depthTruncated);
  const emptyRow = rows.some((r) => r.tree && r.fileCount === 0);
  // 同じフォルダを 2 回登録していないか。確かなのは isSameEntry (Chrome・Edge)。使えなければ、フォルダ名とファイルの一覧が同じかで見る (警告だけで、実行は止めない)
  useEffect(() => {
    let cancelled = false;
    const picked = rows.filter((r): r is SourceRow & { tree: SourceTree } => r.tree !== null);
    void (async () => {
      const found = new Map<number, number>();
      for (let j = 1; j < picked.length; j++) {
        for (let i = 0; i < j; i++) {
          const sure = await picked[j]!.tree.sameFolderAs?.(picked[i]!.tree).catch(() => null);
          if (sure ?? looksSameSource(picked[i]!.tree, picked[j]!.tree)) {
            found.set(picked[j]!.key, rows.findIndex((r) => r.key === picked[i]!.key) + 1);
            break;
          }
        }
      }
      if (!cancelled) setDuplicates((prev) => (prev.size === found.size && [...found].every(([k, v]) => prev.get(k) === v) ? prev : found));
    })();
    return () => {
      cancelled = true;
    };
    // 木の組が替わったときだけ見直す (ラベルの入力では見直さない)。同じ名前の別のフォルダに選び直したときも見直すよう、選んだ回数を入れる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => (r.tree ? `${r.key}:${r.picks}` : "-")).join(",")]);
  useEffect(() => {
    if (focusRow === null) return;
    labelInputs.current.get(focusRow)?.focus();
    setFocusRow(null);
  }, [focusRow]);
  // 調査結果の文章の枠は、文章が届くたびに末尾までスクロールして最新の文を見せる。利用者が上へスクロールしているときは戻さない
  const surveyBox = useRef<HTMLPreElement | null>(null);
  const followSurvey = useRef(true);
  useEffect(() => {
    const el = surveyBox.current;
    if (el && followSurvey.current) el.scrollTop = el.scrollHeight;
  }, [survey]);
  // 提出と画面ごとの結果の行は、画面の数だけ本文の下へ伸びる。調査結果の枠と同じく、利用者が上へスクロールしていない限り、本文の末尾 (最新の行) を追いかける
  const bodyBox = useRef<HTMLDivElement | null>(null);
  const followBody = useRef(true);
  useLayoutEffect(() => {
    const el = bodyBox.current;
    if (el && followBody.current) el.scrollTop = el.scrollHeight;
  }, [log, screen, readCount]);
  // 段階が終わったら、結果の見出しへフォーカスを移す (押していたボタンは外れるので。読み上げと、キー操作の続きのため)
  const resultHeading = useRef<HTMLDivElement | null>(null);
  const hasResult = result !== null;
  useEffect(() => {
    if (hasResult) resultHeading.current?.focus();
  }, [hasResult, result]);
  // 段階を始めたら、押したボタンは (畳んだ本文の中で) 見えなくなるので、「中断」ボタンへ。失敗したら、エラーへ (フォーカスが body に落ちないように)
  const abortButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (running !== null) abortButton.current?.focus();
  }, [running]);
  const errorBox = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);

  const patchRow = (key: number, patch: Partial<SourceRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pick = async (key: number) => {
    setPickingKey(key);
    setError(null);
    try {
      const picked = await getPlatform().pickSourceFolder();
      if (picked && mounted.current) {
        const fileCount = visibleFiles(picked).length;
        // ソースが 2 つ以上のとき (ラベルが必須) だけ、空のラベルへフォルダ名を規則に合う形に整えて入れる。1 つだけのときは任意なので、自動では入れない
        setRows((rs) =>
          rs.map((r, i) =>
            r.key === key
              ? { ...r, tree: picked, fileCount, picks: r.picks + 1, label: rs.length > 1 && r.label.trim() === "" ? autoLabel(picked.name, rs.map((x) => x.label.trim()), i) : r.label }
              : r,
          ),
        );
      }
    } catch (e) {
      setError(`フォルダを読めませんでした。(${String(e)})`);
    } finally {
      setPickingKey(null);
    }
  };

  const addRow = () => {
    if (rows.length >= MAX_SOURCES) return;
    const key = nextKey.current++;
    setRows((rs) => {
      // 1 つ目のラベルが空なら、2 つ目を足すときに入れる (ソースが 2 つ以上のときは、ラベルが必須)。フォルダを選んでいれば規則に合う形に整えたフォルダ名、無ければ候補
      const first = rs[0]!.label.trim() === "" ? { ...rs[0]!, label: autoLabel(rs[0]!.tree?.name, [], 0) } : rs[0]!;
      const base = [first, ...rs.slice(1)];
      return [...base, { key, label: nextCandidate(base.map((r) => r.label), base.length), tree: null, fileCount: 0, picks: 0 }];
    });
    setFocusRow(key);
  };

  const removeRow = (key: number) => {
    // 最後の 1 行を外したら、空の行に戻す
    setRows((rs) => (rs.length <= 1 ? [NEW_ROW(nextKey.current++)] : rs.filter((r) => r.key !== key)));
    // 外した行のフォーカスは、行を足すボタンへ
    requestAnimationFrame(() => addButton.current?.focus());
  };

  /**
   * 段階の結果を見せ、AI のペインの会話へ反映する。AI のペインに会話がまだ無ければ、その段階の会話 (調査結果つき) でペインを始める。
   * すでに会話があれば、置き換えずに、段階の要約を会話に足す (AI への次の発言の文脈に入る。データの段階とテーブルの対応は、短い知らせだけ)
   */
  const finish = (done: StageDone, seedForAgent: { role: "user" | "assistant"; text: string }[]) => {
    const latest = useUntieStore.getState().model;
    const note = `${STAGE_LABELS[done.stage]}の段階が終わりました。`;
    const shown = [
      { role: "user" as const, text: `ソースコードから作成 (${STAGE_LABELS[done.stage]})` },
      { role: "assistant" as const, text: done.summary },
    ];
    const agent = useAgentStore.getState();
    let added = true;
    if (agent.items.length > 0) {
      const brief = done.brief ?? [
        { role: "user" as const, text: `ソースコードから「${STAGE_LABELS[done.stage]}」の段階を実行しました。` },
        { role: "assistant" as const, text: done.summary },
      ];
      // 深掘り・ヒアリング・ドメインの対話の会話が続いているとき (と作業中) は、その会話には足されない
      added = agent.appendContext(brief, [...shown, { role: "info", text: "ここまでの会話は残しています。続けて、モデルを直せます。" }]);
    } else {
      agent.continueFrom(seedForAgent, [...shown, { role: "info", text: "このまま会話を続けて、モデルを直せます。" }]);
    }
    // 画面に出す文には、気づいたことを含めない (下の一覧に出すので、同じ文が重なる)
    setResult({ stage: done.stage, summary: `${note}${done.headline ?? done.summary}${added ? "" : " (AI のペインは作業中か、別の会話 (深掘り・ヒアリング・ドメインの対話) の途中なので、その会話には足していません)"}`, usage: done.usage ?? "", warnings: done.warnings, next: recommendNext(latest, done.stage) });
    setRunning(null);
    setStep(null);
  };

  const sourcesNow = (): LabeledSource[] => rows.map((r) => ({ label: r.label.trim(), tree: r.tree! }));
  const allPicked = rows.every((r) => r.tree !== null);
  // フォルダをたどっている間 (選び直し中) は押せない (たどり終えるまで、古い木のまま始めてしまわないように)
  const sourcesReady = allPicked && !emptyRow && labelProblems.every((p) => p === null) && pickingKey === null;

  /** AI を使う段階を始める (画面・業務)。今のモデルに足し、結果は最後に 1 件の履歴として反映する */
  const startStage = async (stage: "screens" | "logic" | "mapping") => {
    if (starting.current || busy || !sourcesReady) return;
    starting.current = true;
    try {
      setError(null);
      setSurvey("");
      followSurvey.current = true;
      setReads([]);
      setReadCount(0);
      setLog([]);
      setScreen(null);
      setResult(null);
      followBody.current = true;
      let apiKey: string | null;
      try {
        apiKey = await getApiKey(settings.provider);
      } catch (e) {
        setError(`${provider.label} の API キーをキーチェーンから読み出せませんでした。「AI の設定」で保存し直してください。(${String(e)})`);
        return;
      }
      if (!apiKey) {
        setError(`${provider.label} の API キーが設定されていません。「AI の設定」で入れてください。`);
        return;
      }
      if (!mounted.current) return;
      const st = useUntieStore.getState();
      const base = st.model;
      const seq = st.docSeq;
      const sources = sourcesNow();
      const ctl = new AbortController();
      controller.current = ctl;
      setRunning(stage);
      setStep("survey");
      // 画面の段階を始めたら、前の調査結果は忘れる (やり直しが失敗・中断したとき、前の範囲の調査結果が残って、業務の段階に渡らないように)
      if (stage === "screens") forgetScreenSurvey();
      // 使用量は、失敗・中断した段階でも、使った分があれば出す (段階の本体は、失敗すると結果を返さないので、ここでも数える)
      const tracked = trackUsage({
        provider: settings.provider,
        model: aiModel,
        apiKey,
        signal: ctl.signal,
        onStep: setStep,
        onText: (d: string) => setSurvey((a) => a + d),
        onSourceTool: (name: string, detail: string) => {
          setReadCount((n) => n + 1);
          setReads((r) => [...r, `${name} ${detail}`].slice(-RECENT_READS));
        },
        onSubmit: (accepted: boolean, message: string) => setLog((l) => [...l, `${accepted ? "✓" : "↻"} ${message}`]),
      });
      const common = tracked.options;
      /** 失敗・中断・反映できなかったときの文。この段階で使った分があれば、使用量を添える */
      const failure = (message: string): string => {
        const used = usageLine(tracked.summary());
        return used === "" ? message : `${message} (${used})`;
      };
      try {
        const res =
          stage === "screens"
            ? await reverseScreens(base, sources, {
                ...common,
                scope,
                rebuild: rebuildCandidates(base).filter((c) => rebuild.has(c.key)).map((c) => ({ system: c.system, screen: c.screen })),
                onScreen: (done, total, name, ok) => {
                  setScreen({ done, total });
                  setLog((l) => [...l, `${ok ? "✓" : "×"} 画面 ${done}/${total}: ${name}`]);
                },
              })
            : stage === "mapping"
              ? await reverseMapping(base, sources, common)
              : // 画面の段階の調査結果を覚えているとき (同じソースで、画面の段階を実行したあと) は、渡す。覚えていなければ (別のソース・開き直し)、今までどおり調べる
                await reverseLogic(base, sources, request, { ...common, previousSurvey: recallScreenSurvey(seq, sources) });
        // 中断された・ダイアログが外れたあとに届いた結果は、モデルに反映しない
        if (!mounted.current) return;
        if (ctl.signal.aborted) {
          setError(failure("中断しました。"));
          setRunning(null);
          setStep(null);
          return;
        }
        const committed = commitStageModel(base, res.model, seq);
        if (!committed.ok) {
          setError(failure(committed.reason));
          setRunning(null);
          setStep(null);
          return;
        }
        if (stage === "screens") {
          setRebuild(new Set());
          // 画面の段階の調査結果は、このアプリを開いている間は覚える (業務の段階が、同じソースを読み直さないように。保存はしない)
          const done = res as Awaited<ReturnType<typeof reverseScreens>>;
          // 調査の会話が途中で終わっていたら、そのことも覚える (業務の段階が、足りないところを読み直す)
          rememberScreenSurvey(seq, sources, { survey: done.survey, files: done.readFiles, scope: done.scope, ...(done.surveyIncomplete ? { incomplete: true } : {}) });
        }
        finish({ stage, summary: res.summary, headline: res.headline, usage: usageLine(res.usage), warnings: res.warnings, seed: res.seed }, res.seed);
      } catch (e) {
        if (!mounted.current) return;
        setError(failure(ctl.signal.aborted || isAbortError(e) ? "中断しました。" : describeChatError(e)));
        setRunning(null);
        setStep(null);
      } finally {
        if (controller.current === ctl) controller.current = null;
      }
    } finally {
      starting.current = false;
    }
  };

  const progress = stageProgress(model);
  const hasScreenUi = rebuildCandidates(model);
  const logicReady = !!request.trim();
  // AI のペインが作業中 (または編集の途中) の間は、段階の結果をモデルに反映できない (ペインの履歴にまとまってしまう)
  const agentBusy = agentRunning || agentBase !== null;
  const aiDisabledReason = agentBusy ? AGENT_BUSY_REASON : null;
  const stageSteps = running ? STAGE_STEPS[running] : [];
  const stageIndex = running && step ? stageSteps.findIndex((s) => s.step === step) : -1;
  const gap = mappingGap(model);
  const suggestions = suggestMappings(model);
  const aiStageBlock = (stage: "screens" | "logic") => {
    const ok = sourcesReady && !busy && !agentBusy && (stage === "screens" || logicReady);
    const done = progress[stage].done;
    return { ok, label: done ? "もう一度" : "進める" };
  };

  /** 名前が合うテーブルと情報を、AI を使わずに結ぶ */
  const applySuggestions = () => {
    const st = useUntieStore.getState();
    const base = st.model;
    const found = suggestMappings(base);
    if (found.length === 0) return;
    const r = applyMappingSuggestions(base, found);
    const c = commitStageModel(base, r.model, st.docSeq);
    if (!c.ok) {
      setError(c.reason);
      return;
    }
    setError(null);
    const summary = `名前が合うテーブルと情報 ${r.applied} 組を結びました (AI は使っていません)。`;
    finish({ stage: "mapping", summary, warnings: [], seed: [], brief: [{ role: "user", text: "名前が合うテーブルと情報を結んでください。" }, { role: "assistant", text: summary }] }, []);
  };

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <div className="dialog prompt-dialog source-dialog" role="dialog" aria-modal="true" aria-label="ソースコードから作成">
        <h2>ソースコードから作成</h2>
        {/* 失敗は、本文のスクロールの外 (見出しの下) に出す。本文の末尾に置くと、長い本文の下端で切れて読めない */}
        {error && (
          <p className="prompt-error source-error" role="alert" tabIndex={-1} ref={errorBox}>
            {error}
          </p>
        )}
        <div
          className="source-dialog-body"
          ref={bodyBox}
          onScroll={(e) => {
            const el = e.currentTarget;
            followBody.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
          }}
        >
          {busy && (
            <div className="source-summary" title={summaryTitle(rows)}>
              <div className="source-summary-sources">{summaryTitle(rows)}</div>
              <div className="source-summary-request">
                {STAGE_LABELS[running!]}の段階{running === "logic" ? `: ${request.trim()}` : running === "screens" && scope.trim() ? `: ${scope.trim()}` : ""}
              </div>
            </div>
          )}
          {/* 実行中は畳むだけで、外さない (データの段階で選んだ候補・直接選んだファイル・変換の結果が、段階の実行で消えないように) */}
          <div hidden={busy} style={busy ? { display: "none" } : undefined}>
              <p className="hint">
                既存のソースコードを、データ → 画面 → 業務の 3 つの段階で、いま開いているモデルに足していきます (置き換えません)。どの段階も、どの順でも、何度でも実行できます。おすすめはこの順です (前の段階が無いと、精度が落ちます)。実行した段階は 1 件の履歴になり、元に戻す (Ctrl+Z) でまとめて戻せます。
              </p>
              <div className="stage-sub">ソースコードの場所</div>
              <datalist id={datalistId}>
                {SOURCE_LABEL_CANDIDATES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <ul className="source-rows" aria-label="ソースコードの場所">
                {rows.map((row, i) => {
                  const titleId = `${datalistId}-title-${row.key}`;
                  const problemId = `${datalistId}-problem-${row.key}`;
                  // 空のラベルのエラーは、欄を離れてから出す (行を足した直後から、入力のたびに読み上げられないように)
                  const problem = labelProblems[i] && (row.label.trim() !== "" || touched.has(row.key)) ? labelProblems[i] : null;
                  const duplicateOf = duplicates.get(row.key);
                  const shown = row.label.trim() || row.tree?.name || "未選択";
                  return (
                    <li key={row.key} className="source-row">
                      <div className="source-row-head">
                        <strong id={titleId}>ソース {i + 1}</strong>
                        {(multi || row.tree) && (
                          <button type="button" className="link-plain" aria-label={`ソース ${i + 1}「${shown}」を外す`} onClick={() => removeRow(row.key)}>
                            外す
                          </button>
                        )}
                      </div>
                      <label className="source-label-field">
                        <span>{multi ? "ラベル" : "ラベル (任意)"}</span>
                        <input
                          ref={(el) => {
                            if (el) labelInputs.current.set(row.key, el);
                            else labelInputs.current.delete(row.key);
                          }}
                          list={datalistId}
                          value={row.label}
                          maxLength={MAX_SOURCE_LABEL_CHARS + 20}
                          placeholder="例: バックエンド"
                          aria-label={multi ? `ソース ${i + 1} のラベル` : undefined}
                          aria-invalid={problem ? true : undefined}
                          aria-describedby={problem ? problemId : undefined}
                          onChange={(e) => patchRow(row.key, { label: e.target.value })}
                          onBlur={() => setTouched((t) => (t.has(row.key) ? t : new Set(t).add(row.key)))}
                        />
                      </label>
                      {problem && (
                        <p className="prompt-error source-row-problem" id={problemId} aria-live="polite">
                          {problem}
                        </p>
                      )}
                      <div className="source-folder">
                        <button type="button" disabled={pickingKey !== null} aria-describedby={titleId} onClick={() => void pick(row.key)}>
                          {row.tree ? "選び直す…" : "フォルダを選ぶ…"}
                        </button>
                        {row.tree ? (
                          <span className="source-folder-name">
                            <strong>{row.tree.name}</strong>
                            <span className="source-folder-count">読めるファイル {row.fileCount} 件</span>
                          </span>
                        ) : (
                          <span className="source-folder-count">ソースコードのフォルダを選んでください (読み取りだけで、書き換えません)</span>
                        )}
                      </div>
                      {row.tree && row.fileCount === 0 && <p className="prompt-error">このフォルダには、AI が読めるファイルがありません。別のフォルダを選ぶか、この行を外してください。</p>}
                      {row.tree?.truncated && <p className="source-note">ファイルが多すぎるため、途中までしか数えていません。数えていないファイルは、AI が読み取りも検索もできません。</p>}
                      {row.tree?.depthTruncated && <p className="source-note">深すぎるフォルダは読んでいません。その下のファイルは AI に見えません。</p>}
                      {duplicateOf !== undefined && <p className="source-note source-duplicate">同じフォルダを、ソース {duplicateOf} と重ねて登録していませんか? (フォルダ名とファイルの一覧が同じです)</p>}
                    </li>
                  );
                })}
              </ul>
              <div className="source-add">
                <button type="button" ref={addButton} disabled={rows.length >= MAX_SOURCES} onClick={addRow}>
                  ソースコードの場所を足す
                </button>
                <span className="source-folder-count">
                  {rows.length >= MAX_SOURCES ? `${MAX_SOURCES} か所まで登録できます` : multi ? `${rows.length}/${MAX_SOURCES} か所` : "別のフォルダにあるソースコードも、あわせて読めます"}
                </span>
                {multi && (
                  <span className="source-total" aria-live="polite">
                    合計 読めるファイル {totalFiles} 件
                  </span>
                )}
              </div>
              {multi && totalFiles > MAX_TREE_FILES && (
                <p className="source-note">
                  合計が上限 ({MAX_TREE_FILES.toLocaleString("ja-JP")} 件) を超えるため、ソースごとに上限を分け合います。多いソースの一部のファイルは、一覧に出ず、AI は読み取りも検索もできません (フォルダごとに少しずつ残します)。
                </p>
              )}
              {multi && anyDepthTruncated && <p className="source-note">深すぎるフォルダがあるソースがあります。</p>}
              <p className="source-note">
                登録したソースは、このアプリを開いている間は覚えています (保存はしません。別のモデルを開くと忘れます)。<code>.env</code> や鍵のファイル、<code>node_modules</code> などの依存・生成物は、どの段階でも読みません。
                {multi ? " ソースを複数登録すると、ラベルが、どのソースのファイルかを示すパスの先頭 (例: バックエンド/src/routes/orders.ts) として AI に渡ります。" : ""}
              </p>

              {result && (
                <div className="source-warnings stage-result">
                  <div className="prompt-step source-warnings-heading" role="status" tabIndex={-1} ref={resultHeading}>
                    {result.summary}
                    {result.warnings.length > 0 ? ` 気づいたことが ${result.warnings.length} 件あります。` : " 気づいたことはありません。"}
                  </div>
                  {result.usage !== "" && <p className="stage-usage">{result.usage}</p>}
                  {result.warnings.length > 0 && (
                    <ul>
                      {result.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  {result.next ? (
                    <p className="stage-next">
                      次に勧める段階: <strong>{STAGE_LABELS[result.next.stage]}</strong> ({result.next.reason})
                    </p>
                  ) : (
                    <p className="stage-next">続けて、ほかの段階を (もう一度) 進めることもできます。</p>
                  )}
                </div>
              )}

              <SourceDataCard
                rows={rows}
                progress={progress.data.text}
                disabled={busy}
                importBlocked={aiDisabledReason}
                onError={(m) => setError(m === "" ? null : m)}
                onDone={(d) => {
                  setError(null);
                  finish(d, d.seed);
                }}
              />

              <section className="stage-card" aria-labelledby={`${datalistId}-screens`}>
                <div className="stage-card-head">
                  <h3 id={`${datalistId}-screens`}>2. 画面</h3>
                  <span className="stage-progress">進み具合: {progress.screens.text}</span>
                </div>
                <p className="source-note">
                  AI が画面 (ルーティング・ページ・テンプレート・コンポーネント) を調べて、システム・画面・画面遷移・メニュー・画面 UI (項目を、データの段階で取り込んだテーブルの列に結ぶ) を足します。業務と操作はまだ作りません (業務の段階が、画面を使う操作を結びます)。すでにある画面は作り直さず、足りない画面だけ足します。
                </p>
                {!progress.data.done && <p className="source-note stage-advice">データの段階がまだです。先に進めると、画面の項目をテーブルの列に結べます (このまま進めることもできます)。</p>}
                <label className="stage-field stage-field-top">
                  <span>対象の画面の範囲 (任意)</span>
                  <textarea
                    aria-label="対象の画面の範囲 (任意)"
                    className="prompt-input"
                    placeholder="例: 管理画面の注文まわり。空なら、ソースにある画面すべて"
                    value={scope}
                    rows={2}
                    onChange={(e) => setScope(e.target.value)}
                  />
                </label>
                {hasScreenUi.length > 0 && (
                  <details className="stage-rebuild">
                    <summary>画面 UI を作り直す画面を選ぶ (任意)</summary>
                    <p className="source-note">選んだ画面の画面 UI は、作り直して置き換えます。選ばなかった画面の画面 UI は、そのまま残します。</p>
                    <ul className="stage-list">
                      {hasScreenUi.map((c) => (
                        <li key={c.key}>
                          <label className="candidate-row">
                            <input
                              type="checkbox"
                              checked={rebuild.has(c.key)}
                              onChange={() =>
                                setRebuild((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(c.key)) next.delete(c.key);
                                  else next.add(c.key);
                                  return next;
                                })
                              }
                            />
                            <span className="candidate-path">
                              {c.system} / {c.screen}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <ul className="source-notes">
                  <li>
                    選んでいる AI ({provider.label}) の API に送られるのは、フォルダ名とラベル、ファイルの一覧 (名前と大きさ)、AI が開いたファイルの中身、検索で見つかった行、対象の範囲の文、すでにモデルにあるシステム・画面 (名前と説明、使う操作の名前)・データベース (テーブルと列の名前)・業務・情報・登場人物の名前です。画面 UI を作る依頼には、さらに、その画面を使う操作・扱う情報・条件・状態の名前と説明、画面遷移、使うデータベースのテーブルと列の名前と型 (その画面に関わるテーブルだけ列を付け、残りは名前だけ。AI が必要なテーブルの列を道具で調べます)、調査結果の文章が入ります。フォルダ全体は送りません。
                  </li>
                  <li>ふつうのソースファイルに直接書かれたキーや個人情報は、送られることがあります。画面の数だけ AI を呼ぶので、数分かかり、API の利用料がかかります (画面 UI は 1 回に 30 画面まで。残りは、もう一度進めると続きを作ります)。</li>
                </ul>
                <div className="stage-actions">
                  <button type="button" className="primary" disabled={!aiStageBlock("screens").ok} onClick={() => void startStage("screens")}>
                    {aiStageBlock("screens").label}
                  </button>
                  {!sourcesReady && <span className="source-folder-count">ソースを登録してください</span>}
                  {aiDisabledReason && <span className="source-folder-count">{aiDisabledReason}</span>}
                </div>
              </section>

              <section className="stage-card" aria-labelledby={`${datalistId}-logic`}>
                <div className="stage-card-head">
                  <h3 id={`${datalistId}-logic`}>3. 業務</h3>
                  <span className="stage-progress">進み具合: {progress.logic.text}</span>
                </div>
                <p className="source-note">
                  起こしたい業務を書くと、AI が処理のソース (ハンドラー・サービス・ジョブ) を調べて、すでにあるシステム・画面・データベースのテーブルを材料に、業務・活動・作業・操作・登場人物・情報・状態・条件・イベントを足します。操作と画面を結び、テーブルと情報の対応も付けます。業務を変えてもう一度進めると、別の業務が足されます (同じ登場人物・情報・画面は共有します)。
                </p>
                {(!progress.data.done || !progress.screens.done) && (
                  <p className="source-note stage-advice">
                    {!progress.data.done && !progress.screens.done
                      ? "データと画面の段階がまだです。先に進めると精度が上がります (このまま進めることもできます。画面は、業務に関わるものだけを足します)。"
                      : !progress.data.done
                        ? "データの段階がまだです。このまま進めると、テーブルとの対応は付けません。"
                        : "画面の段階がまだです。このまま進めると、業務に関わる画面だけを足します (画面 UI は作りません)。"}
                  </p>
                )}
                <textarea
                  aria-label="モデルに起こしたい業務"
                  className="prompt-input"
                  placeholder="例: 受注から出荷まで"
                  value={request}
                  rows={3}
                  onChange={(e) => setRequest(e.target.value)}
                />
                <ul className="source-notes">
                  <li>
                    選んでいる AI ({provider.label}) の API に送られるのは、フォルダ名とラベル、ファイルの一覧 (名前と大きさ)、AI が開いたファイルの中身、検索で見つかった行、起こしたい業務の文、すでにモデルにあるシステム・画面 (名前と説明、使う操作の名前)・データベース (テーブルと列の名前)・業務・情報・登場人物の名前です。テーブルと情報の対応を付けるときは、さらに、システムが使う情報と画面の名前と説明、使うデータベースのテーブルと列の名前と型、いま結んである情報の名前、調査結果の文章が入ります。業務の段階の調査の依頼には、画面の段階の調査結果の文章と読んだファイルのパス (このアプリを開いている間だけ覚えているもの) も入ります。フォルダ全体は送りません。
                  </li>
                  <li>対象の業務のほか、関係する業務も調べます。数分かかり、API の利用料がかかります。</li>
                </ul>
                <div className="stage-actions">
                  <button type="button" className="primary" disabled={!aiStageBlock("logic").ok} onClick={() => void startStage("logic")}>
                    {aiStageBlock("logic").label}
                  </button>
                  {!sourcesReady && <span className="source-folder-count">ソースを登録してください</span>}
                  {sourcesReady && !logicReady && <span className="source-folder-count">起こしたい業務を入力してください</span>}
                  {aiDisabledReason && <span className="source-folder-count">{aiDisabledReason}</span>}
                </div>
                <div className="stage-sub">テーブルと情報を結ぶ</div>
                <p className="source-note">
                  業務の段階の最後には、どのテーブルにも対応していない情報を、テーブルに結ぶ会話があります。それだけを単独で行えます (業務のあとにデータを取り込んだときなど)。
                  {gap.informations > 0 || gap.tables > 0
                    ? ` いま、どのテーブルにも対応していない情報が ${gap.informations} 件、どの情報にも対応していないテーブルが ${gap.tables} 件あります。`
                    : " いま、対応を付ける情報はありません。"}
                </p>
                {suggestions.length > 0 && (
                  <details className="stage-rebuild">
                    <summary>名前が合うものを、AI を使わずに結ぶ ({suggestions.length} 組)</summary>
                    <ul className="stage-notes" aria-label="名前が合うテーブルと情報">
                      {suggestions.slice(0, 20).map((x) => (
                        <li key={`${x.databaseId}:${x.table}:${x.informationId}`}>
                          {x.databaseName} / {x.table} ↔ 情報「{x.informationName}」 ({x.via}が一致)
                        </li>
                      ))}
                      {suggestions.length > 20 && <li>ほか {suggestions.length - 20} 組</li>}
                    </ul>
                    <button type="button" disabled={busy || agentBusy} onClick={applySuggestions}>
                      名前が合うものを結ぶ
                    </button>
                  </details>
                )}
                <div className="stage-actions">
                  <button type="button" disabled={busy || agentBusy || !sourcesReady || gap.informations === 0 || gap.tables === 0} onClick={() => void startStage("mapping")}>
                    AI でテーブルと情報を結ぶ
                  </button>
                  {gap.informations === 0 || gap.tables === 0 ? <span className="source-folder-count">結ぶ情報とテーブルの両方が要ります</span> : null}
                  {!sourcesReady && <span className="source-folder-count">ソースを登録してください</span>}
                </div>
              </section>

              <div className="prompt-ai">
                使う AI (画面・業務の段階): {provider.label} ({aiModel})
                <button type="button" className="link-plain context-apply" onClick={() => setSettingsOpen(true)}>
                  変える
                </button>
              </div>
          </div>
          {busy && (
            <div className="prompt-progress">
              <div className="visually-hidden" role="status">
                {stageIndex >= 0 ? `${STAGE_LABELS[running!]}の段階 ${stageIndex + 1}/${stageSteps.length} ${stageSteps[stageIndex]!.label}` : "完了"}
              </div>
              <ol className="source-stages">
                {stageSteps.map((s, i) => {
                  const state = step === "done" || i < stageIndex ? "done" : i === stageIndex ? "now" : "next";
                  return (
                    <li key={s.step} className={`source-stage is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                      <span aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "▶" : "・"}</span> {i + 1}/{stageSteps.length} {s.label}
                    </li>
                  );
                })}
              </ol>
              {readCount > 0 && (
                <div className="source-reads">
                  <div className="prompt-step">読んだ場所 ({readCount} 件)</div>
                  {reads.map((r, i) => (
                    <div key={`${readCount}-${i}`} className="prompt-log">
                      {r}
                    </div>
                  ))}
                </div>
              )}
              {survey && (
                <pre
                  ref={surveyBox}
                  className="prompt-analysis source-survey"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    followSurvey.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                  }}
                >
                  {survey}
                </pre>
              )}
              {screen && (
                <div className="prompt-step">
                  画面 {screen.done}/{screen.total}
                </div>
              )}
              {log.map((l, i) => (
                <div key={i} className="prompt-log">
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          {busy ? (
            <>
              <span className="source-folder-count">
                中断すると、この段階でできた分も反映されません (結果は、全部できてから 1 回でモデルに反映します。画面 UI を途中まで作っていても同じです)。
              </span>
              <button type="button" ref={abortButton} onClick={() => controller.current?.abort()}>
                中断
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose}>
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

