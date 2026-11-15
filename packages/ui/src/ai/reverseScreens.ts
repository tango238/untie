// 「ソースコードから作成」の段階 2: 画面。AI が登録したソースの画面 (ルーティング・ページ・テンプレート・コンポーネント) を調べ、
// 開いているモデルに、システム・画面・画面遷移・ナビゲーション (メニュー)・使うデータベース・画面 UI (項目と、テーブルの列への対応) を足す。
// 操作 (ユースケース) はまだ作らない (業務の段階が、ここで作った画面を材料にして結ぶ)。
//
// 画面は担い手 (システム) に属するので、操作に結ばれていなくても、担い手まで辿る検証 (traceToActors) では途切れにならない。
// システムは、画面を 1 つ以上持つものだけ作る (どの操作の対象にもならず画面も無いシステムは途切れになるため)。
// 失敗・中断したときは、この段階で足したものを残さない (結果は最後に 1 回で返す。呼ぶ側が 1 件の履歴として反映する)。
// ただし画面 UI は画面ごとに独立しているので、1 つの会話の失敗 (拒否・一時的な API のエラー) はその画面だけ飛ばし、できた分を残して、残りを気づいたことに出す。
import { addElement, setDesignDatabases, setDesignNavigation } from "@untie/core/model/commands";
import { checkDesign } from "@untie/core/model/designCheck";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { newUniqueId } from "@untie/core/model/id";
import { NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, truncateText } from "@untie/core/model/limits";
import { designScreenName, navigationFromSitemap } from "@untie/core/model/sitemap";
import { usedDesignIds } from "@untie/core/model/design";
import type { UntieModel } from "@untie/core/model/types";
import { ChatError, type SeedTurn } from "./chat";
import {
  elementName,
  errorOutcome,
  designWarningLines,
  okOutcome,
  openSession,
  REVERSE_LIMITS,
  revisionNote,
  screensBudget,
  sourceLimits,
  sourcePathsIn,
  statesOfScreen,
  stoppedWarning,
  stageFailure,
  surveyCollector,
  throwIfAborted,
  type Ctx,
  type StageFailure,
  type StageOptions,
} from "./reverse";
import {
  applyScreenDraft,
  applySitemapDraft,
  readScreenDraft,
  SUBMIT_SCREEN_DRAFT_TOOL,
} from "./designDraft";
import { screenRequest } from "./designScreen";
import { describeTablesForRequest, executeGetTable, GET_TABLE_TOOL, screenHint } from "./reverseTables";
import {
  clipSurvey,
  FINISH_NOTE,
  reverseScreenRequest,
  reverseScreensStructureRequest,
  reverseScreensSurveyRequest,
  reverseSystemPrompt,
  wrapSurvey,
} from "./reversePrompts";
import { nameKey, SPEC_LIMITS } from "./spec";
import { combineSourceTrees, isMultiSourceTree, sourcesTitle, visibleFiles, type LabeledSource, type SourceTree } from "./sourceTree";
import type { ToolDef, ToolOutcome } from "./tools";
import { TRANSITION_VIAS } from "@untie/core/model/sitemap";

export interface ScreensOptions extends StageOptions {
  /** 対象の画面の範囲 (任意の文章。空なら全部) */
  scope?: string;
  /** 画面 UI を作り直す画面 (すでに画面 UI がある画面のうち、選んだもの)。ここに無い画面の画面 UI は、まだ無いものだけ作る */
  rebuild?: { system: string; screen: string }[];
  /** 画面 UI を 1 つ終えたとき (done / total は件数、name は画面の名前、ok は置けたか) */
  onScreen?: (done: number, total: number, name: string, ok: boolean) => void;
}

export interface ScreensAdded {
  systems: number;
  screens: number;
  transitions: number;
  /** 画面 UI を置いた画面の数 */
  ui: number;
}

export interface ScreensResult {
  /** 足したあとのモデル (失敗・中断なら、この関数は例外を投げ、モデルは返らない) */
  model: UntieModel;
  added: ScreensAdded;
  /** 調査結果の文章 */
  survey: string;
  warnings: string[];
  /** このあとエージェントの会話に引き継ぐ履歴 */
  seed: SeedTurn[];
  summary: string;
}

// ---------------------------------------------------------------- 構成の下書き (名前で参照する)

export interface ScreensDraftSystem {
  name: string;
  description?: string;
  /** 使うデータベースの名前 (すでにあるもの) */
  databases?: string[];
  screens: { name: string; description?: string }[];
  transitions?: { from: string; to: string; via?: string; label?: string }[];
  navigation?: { group: string; screens: string[] }[];
}

export interface ScreensDraft {
  systems: ScreensDraftSystem[];
}

const SUBMIT_SCREENS_TOOL: ToolDef = {
  name: "submit_screens",
  description:
    "画面の構成 (システム・画面・画面遷移・メニュー・使うデータベース) を提出する。名前で参照する (id は作らない)。すでにあるシステム・画面は同じ名前で書くと、作り直されずにそのまま使われる。提出すると検査結果が返る。問題があれば直して提出し直す。",
  parameters: {
    type: "object",
    properties: {
      systems: {
        type: "array",
        description: "システム。画面を 1 つ以上持つものだけ",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "システムの名前 (利用者から見て別のものとして使われている単位)" },
            description: { type: "string", description: "システムの説明 (使う人・入口)" },
            databases: { type: "array", items: { type: "string" }, description: "このシステムが使うデータベースの名前 (依頼の「すでにあるデータベース」にあるもの)。すでにあるデータベースが 1 つだけなら省いてよい" },
            screens: {
              type: "array",
              description: "このシステムの画面 (すでにある画面も、同じ名前で書く)",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "画面の名前 (日本語の業務の言葉)" },
                  description: { type: "string", description: "何をする画面か。ソースのファイルのパスを含める" },
                },
                required: ["name"],
                additionalProperties: false,
              },
            },
            transitions: {
              type: "array",
              description: "このシステムの画面遷移 (ソースから読み取れたもの)。画面は名前で書く",
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
            navigation: {
              type: "array",
              description: "メニュー (ナビゲーション) のグループと、並んでいる画面 (名前)。ソースから読み取れるときだけ。省くと画面遷移から作る",
              items: {
                type: "object",
                properties: { group: { type: "string" }, screens: { type: "array", items: { type: "string" } } },
                required: ["group", "screens"],
                additionalProperties: false,
              },
            },
          },
          required: ["name", "screens"],
          additionalProperties: false,
        },
      },
    },
    required: ["systems"],
    additionalProperties: false,
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const nameOf = (text: string): string => truncateText(text.trim(), NAME_MAX_LENGTH);

/** 提出された内容を取り出す。形が違えば null */
export function readScreensDraft(raw: unknown): ScreensDraft | null {
  if (!isObject(raw) || !Array.isArray(raw.systems)) return null;
  const systems = raw.systems.flatMap((s): ScreensDraftSystem[] => {
    if (!isObject(s) || typeof s.name !== "string") return [];
    const screens = (Array.isArray(s.screens) ? s.screens : []).flatMap((x) => (isObject(x) && typeof x.name === "string" ? [{ name: x.name, ...(str(x.description) !== undefined ? { description: str(x.description) } : {}) }] : []));
    const transitions = (Array.isArray(s.transitions) ? s.transitions : []).flatMap((t) =>
      isObject(t) && typeof t.from === "string" && typeof t.to === "string" ? [{ from: t.from, to: t.to, ...(str(t.via) !== undefined ? { via: str(t.via) } : {}), ...(str(t.label) !== undefined ? { label: str(t.label) } : {}) }] : [],
    );
    const navigation = (Array.isArray(s.navigation) ? s.navigation : []).flatMap((g) => (isObject(g) && typeof g.group === "string" ? [{ group: g.group, screens: strings(g.screens) }] : []));
    return [
      {
        name: s.name,
        ...(str(s.description) !== undefined ? { description: str(s.description) } : {}),
        ...(Array.isArray(s.databases) ? { databases: strings(s.databases) } : {}),
        screens,
        ...(transitions.length > 0 ? { transitions } : {}),
        ...(navigation.length > 0 ? { navigation } : {}),
      },
    ];
  });
  return { systems };
}

export interface ScreensApplyResult {
  model: UntieModel;
  /** 落とした部分・気づいたこと */
  warnings: string[];
  /** AI に直してもらえる問題 (画面の無いシステム・見つからない画面の名前を持つ遷移・使うデータベースが決まらない、など) */
  issues: string[];
  added: { systems: number; screens: number; transitions: number };
  /** 下書きに書かれていた画面 (システムの名前と画面の名前)。画面 UI を作る対象の元 */
  named: { system: string; screen: string }[];
  /** この下書きで新しく足した分析の画面の id */
  newScreenIds: string[];
}

/**
 * 画面の構成の下書きを、モデルに足す (純粋関数。モデルを渡して新しいモデルを返す)。
 * システム (同じ名前があればそれを使う)・画面 (同じシステムの同じ名前があればそれを使う) を足し、設計の画面 (サイトマップ)・遷移・ナビゲーションを足す。
 * ナビゲーションは、設計にまだ無いときだけ作る (AI の答え、無ければ画面遷移から)。すでにあるときは、新しい画面だけを「その他」のグループへ足す。
 * 使うデータベースは、設計がまだ明示していないときだけ決める (AI の答え、無ければ、データベースが 1 つならそれ)
 */
export function applyScreensDraft(base: UntieModel, draft: ScreensDraft): ScreensApplyResult {
  let model = base;
  const warnings: string[] = [];
  const issues: string[] = [];
  const added = { systems: 0, screens: 0, transitions: 0 };
  const named: { system: string; screen: string }[] = [];
  const newScreenIds: string[] = [];
  const systems = draft.systems.slice(0, SPEC_LIMITS.systems);
  if (draft.systems.length > systems.length) warnings.push(`システムは先頭 ${SPEC_LIMITS.systems} 件だけ使いました (${draft.systems.length} 件ありました)`);
  let screenBudget: number = SPEC_LIMITS.screens;
  for (let sys of systems) {
    const sysName = nameOf(sys.name);
    if (sysName === "") continue;
    // 同じ名前の画面は 1 つ (同じシステムの中。綴りの違い (全角半角・空白・大文字小文字) は同じ名前とみなす)
    const seen = new Set<string>();
    const screens = sys.screens.flatMap((s) => {
      const n = nameOf(s.name);
      if (n === "" || seen.has(nameKey(n))) return [];
      seen.add(nameKey(n));
      return [{ name: n, ...(s.description ? { description: truncateText(s.description, DESCRIPTION_MAX_LENGTH) } : {}) }];
    });
    if (screens.length === 0) {
      issues.push(`システム「${sysName}」に画面がありません (画面を 1 つも持たないシステムは書かないでください)`);
      continue;
    }
    let system = model.elements.find((e) => e.kind === "system" && nameKey(e.name) === nameKey(sysName));
    if (!system) {
      const person = model.elements.find((e) => (e.kind === "actor" || e.kind === "externalActor") && nameKey(e.name) === nameKey(sysName));
      if (person) {
        warnings.push(`システム「${sysName}」と同じ名前の${person.kind === "actor" ? "アクター" : "外部アクター"}がいます。人とは別のシステムとして作りました (名前が重なるので、あとで見分けやすい名前にしてください)`);
      }
      const r = addElement(model, { kind: "system", name: sysName, init: { ...(sys.description ? { description: truncateText(sys.description, DESCRIPTION_MAX_LENGTH) } : {}) } });
      if (!r.ok) {
        warnings.push(`システム「${sysName}」を作れません: ${r.reason}`);
        continue;
      }
      model = r.model;
      system = model.elements.find((e) => e.id === r.id)!;
      added.systems++;
    }
    for (const sc of screens) {
      const existing = model.elements.find((e) => e.kind === "screen" && e.systemId === system!.id && nameKey(e.name) === nameKey(sc.name));
      if (existing) {
        named.push({ system: system.name, screen: existing.name });
        continue;
      }
      if (screenBudget <= 0) {
        warnings.push(`画面は先頭 ${SPEC_LIMITS.screens} 件だけ足しました`);
        break;
      }
      const r = addElement(model, { kind: "screen", name: sc.name, init: { systemId: system.id, ...(sc.description ? { description: sc.description } : {}) } });
      if (!r.ok) {
        warnings.push(`画面「${sc.name}」を作れません: ${r.reason}`);
        continue;
      }
      model = r.model;
      screenBudget--;
      added.screens++;
      newScreenIds.push(r.id);
      named.push({ system: system.name, screen: sc.name });
    }
    // 遷移・メニューの画面の名前は、モデルにある画面の名前 (綴りの違いを吸収したもの) に直してから渡す
    const canon = new Map(model.elements.flatMap((e) => (e.kind === "screen" && e.systemId === system!.id ? ([[nameKey(e.name), e.name]] as const) : [])));
    const canonical = (n: string): string => canon.get(nameKey(nameOf(n))) ?? n;
    sys = {
      ...sys,
      transitions: (sys.transitions ?? []).map((t) => ({ ...t, from: canonical(t.from), to: canonical(t.to) })),
      navigation: (sys.navigation ?? []).map((g) => ({ ...g, screens: g.screens.map(canonical) })),
    };
    // サイトマップ: 分析の画面を設計の画面にし、遷移を足す
    const sm = applySitemapDraft(model, { system: system.name, transitions: sys.transitions ?? [] });
    model = sm.model;
    added.transitions += sm.added.transitions + sm.added.derivedTransitions;
    for (const w of sm.warnings) {
      warnings.push(w);
      issues.push(w);
    }
    // ナビゲーション
    model = applyNavigation(model, system.id, sys, newScreenIds, warnings);
    // 使うデータベース
    model = applyDatabases(model, system.id, system.name, sys, warnings, issues);
  }
  return { model, warnings, issues, added, named, newScreenIds };
}

/**
 * 分析の画面 (newScreenIds) を、システムの設計 (サイトマップ・ナビゲーション) に足す。設計がまだ無いシステムには何もしない。
 * 業務の段階が新しい画面を足したとき、画面の段階で作った設計に載せるために使う
 */
export function addScreensToDesign(model: UntieModel, systemId: string, newScreenIds: readonly string[], warnings: string[]): UntieModel {
  const sys = model.elements.find((e) => e.id === systemId);
  if (!sys || !model.designs.some((d) => d.systemId === systemId)) return model;
  const sm = applySitemapDraft(model, { system: sys.name, transitions: [] });
  warnings.push(...sm.warnings);
  return applyNavigation(sm.model, systemId, { name: sys.name, screens: [] }, newScreenIds, warnings);
}

function applyNavigation(model: UntieModel, systemId: string, sys: ScreensDraftSystem, newScreenIds: readonly string[], warnings: string[]): UntieModel {
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) return model;
  const byName = new Map<string, string>();
  for (const s of design.screens) {
    const n = nameKey(designScreenName(model, s));
    if (!byName.has(n)) byName.set(n, s.id);
  }
  const used = usedDesignIds(model);
  const newGroupId = (): string => {
    const id = newUniqueId("navGroup", used);
    used.add(id);
    return id;
  };
  if (design.layout.navigation.length === 0) {
    let groups: { id: string; group: string; items: { screenId: string }[] }[];
    const asked = (sys.navigation ?? []).map((g) => ({ group: truncateText(g.group.trim(), NAME_MAX_LENGTH), ids: [...new Set(g.screens.flatMap((n) => byName.get(nameKey(nameOf(n))) ?? []))] })).filter((g) => g.group !== "" && g.ids.length > 0);
    if (asked.length > 0) {
      const placed = new Set(asked.flatMap((g) => g.ids));
      const rest = design.screens.filter((s) => !placed.has(s.id)).map((s) => s.id);
      const all = rest.length > 0 ? [...asked, { group: "その他", ids: rest }] : asked;
      groups = all.map((g) => ({ id: newGroupId(), group: g.group, items: g.ids.map((screenId) => ({ screenId })) }));
    } else groups = navigationFromSitemap(model, systemId);
    if (groups.length === 0) return model;
    const r = setDesignNavigation(model, { systemId, navigation: groups });
    if (r.ok) return r.model;
    warnings.push(`ナビゲーション: システム「${elementName(model, systemId)}」のナビゲーションを作れませんでした (${r.reason})`);
    return model;
  }
  // すでにナビゲーションがある (利用者が直したかもしれない): 新しい画面だけを、「その他」のグループへ足す
  const inNav = new Set(design.layout.navigation.flatMap((g) => g.items.map((i) => i.screenId)));
  const fresh = design.screens.filter((s) => s.source.kind === "screen" && newScreenIds.includes(s.source.screenId) && !inNav.has(s.id)).map((s) => ({ screenId: s.id }));
  if (fresh.length === 0) return model;
  const groups = design.layout.navigation.map((g) => ({ id: g.id, group: g.group, items: g.items.map((i) => ({ screenId: i.screenId, ...(i.label ? { label: i.label } : {}) })) }));
  const other = groups.find((g) => g.group === "その他");
  if (other) other.items.push(...fresh);
  else groups.push({ id: newGroupId(), group: "その他", items: fresh });
  const r = setDesignNavigation(model, { systemId, navigation: groups });
  return r.ok ? r.model : model;
}

function applyDatabases(model: UntieModel, systemId: string, sysName: string, sys: ScreensDraftSystem, warnings: string[], issues: string[]): UntieModel {
  const design = model.designs.find((d) => d.systemId === systemId);
  // 利用者や前の実行が決めた、使うデータベースは変えない
  if (!design || design.databaseIds.length > 0) return model;
  const real = model.databases.filter((d) => d.dsl.trim() !== "");
  const asked = (sys.databases ?? []).flatMap((n) => {
    const db = model.databases.find((d) => d.name === n.trim() || d.id === n.trim());
    if (!db) warnings.push(`データ: システム「${sysName}」が使うデータベース「${n}」が、すでにあるデータベースにありません`);
    return db ? [db.id] : [];
  });
  const ids = asked.length > 0 ? asked : real.length === 1 ? [real[0]!.id] : [];
  if (ids.length === 0) {
    if (real.length > 1 && (sys.databases ?? []).length === 0) issues.push(`システム「${sysName}」が使うデータベースが決まっていません (すでにあるデータベースのどれを使うか、databases に名前で書いてください)`);
    return model;
  }
  const r = setDesignDatabases(model, { systemId, databaseIds: ids });
  return r.ok ? r.model : model;
}

// ---------------------------------------------------------------- 段階の本体

/**
 * 画面の段階を実行する。base は今のモデル (これに足した新しいモデルを返す。base は変えない)。source は 1 つの木か、ラベル付きの複数のソース。
 * 失敗・中断は例外 (ChatError・AbortError・API のエラー) で、そのとき足したものは返らない。
 * 画面 UI の会話の失敗は、その画面だけ飛ばして warnings に残し、できた分を返す
 */
export async function reverseScreens(base: UntieModel, source: SourceTree | readonly LabeledSource[], o: ScreensOptions): Promise<ScreensResult> {
  const tree: SourceTree = "files" in source ? source : combineSourceTrees(source);
  const multi = isMultiSourceTree(tree);
  const nSources = tree.sources?.length ?? 1;
  const lim = sourceLimits(nSources);
  const scope = (o.scope ?? "").trim();
  const ctx: Ctx = { tree, o, budget: { ...screensBudget(0, nSources), usedCalls: 0, usedChars: 0 } };
  const system = reverseSystemPrompt(multi, "screens");
  const warnings: string[] = [];

  // ---- 1. 調査 ----
  throwIfAborted(o.signal);
  o.onStep?.("survey");
  const surveyRequest = reverseScreensSurveyRequest(scope, base, tree.name, visibleFiles(tree).length, tree.sources);
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

  // ---- 2. 画面の構成 (システム・画面・遷移・メニュー・使うデータベース) ----
  throwIfAborted(o.signal);
  o.onStep?.("structure");
  let accepted: ScreensApplyResult | null = null;
  let attempts = 0;
  /** 形の違う・空の提出を断った数 (出し直しの回数 attempts とは別に数え、上限で打ち切る。往復の上限まで同じ断りを続けさせない) */
  let rejected = 0;
  let gaveUp = false;
  const reject = (message: string): ToolOutcome => {
    rejected++;
    if (rejected > REVERSE_LIMITS.submitRejections) {
      gaveUp = true;
      return okOutcome(`提出が続けて受け付けられなかったので、見送ります。これ以上は受け付けません。${FINISH_NOTE}`, false);
    }
    return errorOutcome(message);
  };
  const submitScreens = (input: unknown): ToolOutcome => {
    if (accepted) return okOutcome(`すでに受け付けました。${FINISH_NOTE}`, false);
    if (gaveUp) return okOutcome(`提出は見送りました。これ以上は受け付けません。${FINISH_NOTE}`, false);
    const draft = readScreensDraft(input);
    if (!draft) return reject("systems の一覧が必要です");
    attempts++;
    // 毎回、受け取ったときのモデルから組み立てる (出し直しで二重に足さない)
    const r = applyScreensDraft(base, draft);
    if (r.issues.length > 0 && attempts <= REVERSE_LIMITS.strictModelAttempts) {
      o.onSubmit?.(false, `画面の構成を直してもらっています (${r.issues[0]!.length > 40 ? `${r.issues[0]!.slice(0, 40)}…` : r.issues[0]}${r.issues.length > 1 ? ` など ${r.issues.length} 件` : ""})`);
      return errorOutcome(`次の点を直して、もう一度提出してください:\n- ${r.issues.slice(0, 20).join("\n- ")}`);
    }
    if (r.added.systems + r.added.screens === 0 && r.named.length === 0) return reject("画面が 1 つもありません。ソースにある画面を書いてください (本当に画面が無ければ、そのことを答えて終わってください)");
    accepted = r;
    const message = `受け付けました: システム ${r.added.systems}、画面 ${r.added.screens}、遷移 ${r.added.transitions}${r.issues.length > 0 ? ` (気づいたこと ${r.issues.length} 件は残っています)` : ""}`;
    o.onSubmit?.(true, message);
    return okOutcome(`${message}。${FINISH_NOTE}`, true);
  };
  const structureSession = openSession(ctx, system, [SUBMIT_SCREENS_TOOL], { ...lim.model, finish: "submit" }, { submit_screens: submitScreens }, modelSeed);
  try {
    await structureSession.send(reverseScreensStructureRequest(scope, multi), {}, o.signal);
    throwIfAborted(o.signal);
    if (!accepted && !gaveUp) {
      await structureSession.send("submit_screens で画面の構成を提出してください。", {}, o.signal);
      throwIfAborted(o.signal);
    }
  } catch (e) {
    throwIfAborted(o.signal);
    if (!(e instanceof ChatError) || o.signal?.aborted || !accepted) throw e;
  }
  const structure = accepted as ScreensApplyResult | null;
  if (!structure) throw new ChatError("AI が画面の構成を提出しませんでした。対象の範囲を具体的にして、もう一度試してください。");
  let model = structure.model;
  warnings.push(...structure.warnings.map((w) => (w.startsWith("画面") || w.startsWith("システム") ? `画面: ${w}` : w)));
  for (const w of structure.issues.filter((i) => !structure.warnings.includes(i))) warnings.push(`画面: ${w}`);

  // ---- 3. 画面 UI (画面ごと) ----
  throwIfAborted(o.signal);
  o.onStep?.("ui");
  const rebuild = new Set((o.rebuild ?? []).map((r) => `${r.system}\n${r.screen}`));
  const namedKeys = new Set(structure.named.map((n) => `${n.system}\n${n.screen}`));
  const allTargets = model.designs.flatMap((d) =>
    d.screens.flatMap((s) => {
      if (s.source.kind !== "screen") return [];
      const sysName = elementName(model, d.systemId);
      const name = designScreenName(model, s);
      // 下書きに書かれた画面のうち、画面 UI がまだ無いもの。作り直しに選ばれた画面は、書かれていなくても作り直す
      const wanted = (namedKeys.has(`${sysName}\n${name}`) && s.view === undefined) || rebuild.has(`${sysName}\n${name}`);
      return wanted ? [{ systemId: d.systemId, id: s.id, analysisId: s.source.screenId, name }] : [];
    }),
  );
  const todo = allTargets.slice(0, REVERSE_LIMITS.screens);
  ctx.budget.calls = screensBudget(todo.length, nSources).calls;
  ctx.budget.chars = screensBudget(todo.length, nSources).chars;
  if (allTargets.length > todo.length) {
    const rest = allTargets.slice(todo.length);
    warnings.push(`画面 UI: 画面が ${allTargets.length} 件あり、上限 ${REVERSE_LIMITS.screens} 件を超えたので、後ろの ${rest.length} 件は作りませんでした (${rest.slice(0, 5).map((t) => `「${t.name}」`).join("")}${rest.length > 5 ? " ほか" : ""})。もう一度実行すると、続きを作ります`);
  }
  let done = 0;
  let placed = 0;
  let errorStreak = 0;
  let lastFailure: StageFailure | null = null;
  for (const t of todo) {
    throwIfAborted(o.signal);
    if (errorStreak >= REVERSE_LIMITS.screenErrorStreak && lastFailure) {
      warnings.push(stoppedWarning(lastFailure, todo.length - done));
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
      const d = readScreenDraft(input);
      if (!d) return errorOutcome("screen・view・bindings が必要です");
      if (nameKey(d.screen) !== nameKey(t.name)) return errorOutcome(`この会話で作る画面は「${t.name}」だけです (「${d.screen}」ではありません)`);
      if (gaveUp) return okOutcome(`この画面の画面 UI は見送りました。これ以上は受け付けません。${FINISH_NOTE}`, false);
      if (applied && attempt >= screenMaxAttempts) return okOutcome(`これ以上は出し直せません。このまま受け付けています。${FINISH_NOTE}`, false);
      attempt++;
      const r = applyScreenDraft(model, { ...d, screen: t.name, system: sysName });
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
        o.onSubmit?.(false, `画面「${t.name}」の形を直してもらっています`);
        return errorOutcome(`view が mokkun の検証に通りませんでした。直して出し直してください: ${r.viewError}`);
      }
      gaveUp = true;
      screenWarnings = r.warnings;
      o.onSubmit?.(false, `画面「${t.name}」の画面 UI は置けませんでした`);
      return okOutcome("この画面の画面 UI は置けなかったので、見送ります。次へ進んでください", false);
    };
    try {
      const design = model.designs.find((d) => d.systemId === t.systemId)!;
      const screen = design.screens.find((s) => s.id === t.id)!;
      const description = model.elements.find((e) => e.id === t.analysisId)?.description ?? "";
      const hint = multi ? { labels: tree.sources!.map((x) => x.label), paths: sourcePathsIn(description, tree) } : undefined;
      // テーブルは、この画面の説明・調査結果のこの画面の行・使う操作と情報の名前に出るものと、その関連先だけを列つきで入れる。残りは名前だけで、get_table で調べさせる
      const dbIds = effectiveDatabaseIds(model, design);
      const databases = describeTablesForRequest(model, dbIds, screenHint(model, t.analysisId, t.name, description, survey));
      const screenSession = openSession(
        ctx,
        system,
        [SUBMIT_SCREEN_DRAFT_TOOL, GET_TABLE_TOOL],
        { ...lim.screen, finish: "submit" },
        { submit_screen: submitScreen, get_table: (input) => executeGetTable(model, dbIds, input) },
        stageSeed,
        ["get_table"],
      );
      await screenSession.send(reverseScreenRequest(screenRequest(model, t.systemId, design, screen, { databases }), t.name, hint, statesOfScreen(model, t.analysisId), databases.narrowed), {}, o.signal);
      throwIfAborted(o.signal);
      errorStreak = 0;
    } catch (e) {
      failure = stageFailure(e, o.signal);
      if (!failure) throw e;
      errorStreak++;
      lastFailure = failure;
      warnings.push(`画面 UI: 画面「${t.name}」: ${failure.message}`);
    }
    if (!applied && !gaveUp && !failure && screenWarnings.length === 0) warnings.push(`画面 UI: 画面「${t.name}」: AI が画面 UI を提出しなかったので、作りませんでした`);
    warnings.push(...screenWarnings);
    done++;
    if (applied) placed++;
    o.onScreen?.(done, todo.length, t.name, applied);
  }

  // ---- 検証 ----
  o.onStep?.("done");
  const touched = new Set(structure.named.map((n) => model.elements.find((e) => e.kind === "system" && e.name === n.system)?.id).filter((id): id is string => !!id));
  for (const systemId of touched) {
    const c = checkDesign(model, systemId);
    const prefix = touched.size > 1 ? `システム「${elementName(model, systemId)}」: ` : "";
    if (c.problems.length > 0) warnings.push(`設計の検証: ${prefix}エラー ${c.problems.length} 件 (${c.problems[0]!.message}${c.problems.length > 1 ? " ほか" : ""})`);
    for (const line of designWarningLines(model, systemId, c.warnings)) warnings.push(`設計の検証: ${prefix}${line}`);
  }
  const unlinked = model.elements.filter((e) => e.kind === "screen" && !model.relations.some((r) => r.kind === "usecaseScreen" && r.targetId === e.id));
  if (unlinked.length > 0) warnings.push(`操作にまだ結ばれていない画面が ${unlinked.length} 件あります。業務の段階で、画面を使う操作を作って結びます`);

  const added: ScreensAdded = { systems: structure.added.systems, screens: structure.added.screens, transitions: structure.added.transitions, ui: placed };
  const summary = `${sourcesTitle(tree.sources ?? [{ label: "", folder: tree.name }])}から画面を足しました (システム ${added.systems}、画面 ${added.screens}、遷移 ${added.transitions}、画面 UI ${added.ui})。${
    warnings.length > 0 ? `気づいたこと ${warnings.length} 件: ${warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    model,
    added,
    survey,
    warnings,
    summary,
    seed: [
      { role: "user", text: `次のソースコードから、画面の構成を作ってください。\n\n<ソースコードのフォルダ>${multi ? `\n${tree.sources!.map((x) => `${x.label}: ${x.folder}`).join("\n")}\n` : tree.name}</ソースコードのフォルダ>${scope !== "" ? `\n<対象の画面の範囲>\n${scope}\n</対象の画面の範囲>` : ""}` },
      { role: "assistant", text: `${stageSeed[1]!.text}\n\n${summary}` },
    ],
  };
}

