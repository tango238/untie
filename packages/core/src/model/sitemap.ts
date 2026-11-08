// 設計モードのサイトマップ (5.7)。分析の業務 → 活動 → 作業 → 操作 → 画面から、サイトマップの画面と遷移を導く。
// 純粋関数だけを置く。保存するのは設計 (designs[].screens・transitions) だけで、チェックの状態・入口・注記は毎回導く。
import { produce } from "immer";
import { addDesignScreens, ensureDesign, removeDesignScreensById, type CommandResult } from "./commands";
import { usedDesignIds } from "./design";
import { newUniqueId } from "./id";
import type { DesignScreen, Element, SystemDesign, Transition, UntieModel } from "./types";

type Builtin = Extract<DesignScreen["source"], { kind: "builtin" }>["builtin"];
type Via = NonNullable<Transition["via"]>;

/** 画面の実際のレイアウト (枠)。画面の上書きがあればそれ、無ければ設計のレイアウト */
export function effectiveShell(design: Pick<SystemDesign, "layout">, screen: Pick<DesignScreen, "shell">): "shell" | "plain" {
  return screen.shell ?? design.layout.shell;
}

/** 画面のレイアウトの説明 (画面ボードの select と、サイトマップのプロパティで共有する) */
export const SHELL_LABELS: Record<"shell" | "plain", string> = {
  shell: "ヘッダー + グローバルナビ + パンくず (shell)",
  plain: "枠なし (plain)",
};

/** 短い呼び名 (読み取りの表示用) */
export const SHELL_SHORT_LABELS: Record<"shell" | "plain", string> = { shell: "ヘッダー + グローバルナビ + パンくず", plain: "枠なし" };

/** メニューが出る画面 (レイアウトが shell の画面) が 1 つでもあるか。設計のレイアウトと、画面ごとの上書きで決まる */
export function hasMenuScreen(design: Pick<SystemDesign, "layout" | "screens">): boolean {
  return design.screens.some((s) => effectiveShell(design, s) === "shell");
}

/** 組み込みの画面の名前 */
export const BUILTIN_SCREEN_LABELS: Record<Builtin, string> = {
  signIn: "サインイン",
  top: "トップページ",
  home: "ホーム",
  signUp: "サインアップ",
  passwordReminder: "パスワードリマインダー",
};

/** 左の木のチェックボックスに出す組み込みの画面 (サインアップ・パスワードリマインダーは出さない)。トップページは未ログインの最初の画面、ホームはサインインしたあとの最初の画面 */
export const SITEMAP_BUILTINS: readonly Builtin[] = ["top", "signIn", "home"];

/** 遷移のきっかけの表示 (未定は via が無いとき) */
export const TRANSITION_VIA_LABELS: Record<Via, string> = {
  button: "ボタン",
  row: "一覧の行",
  nav: "メニュー",
  afterSubmit: "送信のあと",
};
export const TRANSITION_VIAS: readonly Via[] = ["button", "row", "nav", "afterSubmit"];

/** 設計の画面の名前 (分析の画面なら画面の名前、組み込みならその名前) */
export function designScreenName(model: UntieModel, screen: DesignScreen): string {
  if (screen.source.kind === "builtin") return BUILTIN_SCREEN_LABELS[screen.source.builtin];
  const sourceId = screen.source.screenId;
  return model.elements.find((e) => e.id === sourceId)?.name || "(名前なし)";
}

const nameOf = (e: Element | undefined): string => e?.name || "(名前なし)";

// ---------------------------------------------------------------- 関係の索引

interface Index {
  byId: Map<string, Element>;
  /** 作業 → 使う操作 (関係の並び順) */
  usecasesOf: Map<string, string[]>;
  /** 操作 → 使う作業 */
  activitiesOf: Map<string, string[]>;
  /** 作業 → 担当のアクター・外部アクター */
  actorsOf: Map<string, Set<string>>;
  /** 操作 → 画面 (分析の画面の id) */
  screenOf: Map<string, string>;
  /** 操作 → 対象のシステム・帳票 */
  targetOf: Map<string, string>;
  /** 操作 → 次の操作 (「次に」と、イベントをはさんだ「きっかけ」) */
  nextOf: Map<string, string[]>;
  /** イベント → 発生させる操作 */
  emittersOf: Map<string, string[]>;
  /** イベント → 発生させるシステム */
  systemEmittersOf: Map<string, string[]>;
  /** 作業 → 起点の作業 */
  originActivitiesOf: Map<string, string[]>;
  /** 作業 → 起点のイベント */
  originEventsOf: Map<string, string[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function buildIndex(model: UntieModel): Index {
  const idx: Index = {
    byId: new Map(model.elements.map((e) => [e.id, e])),
    usecasesOf: new Map(),
    activitiesOf: new Map(),
    actorsOf: new Map(),
    screenOf: new Map(),
    targetOf: new Map(),
    nextOf: new Map(),
    emittersOf: new Map(),
    systemEmittersOf: new Map(),
    originActivitiesOf: new Map(),
    originEventsOf: new Map(),
  };
  const triggersOf = new Map<string, string[]>();
  const emitsOf = new Map<string, string[]>();
  for (const r of model.relations) {
    switch (r.kind) {
      case "activityUsecase":
        push(idx.usecasesOf, r.sourceId, r.targetId);
        push(idx.activitiesOf, r.targetId, r.sourceId);
        break;
      case "actorActivity": {
        // 外部アクター (お客さまなど) は担当の比較に数えない
        if (idx.byId.get(r.sourceId)?.kind !== "actor") break;
        const set = idx.actorsOf.get(r.targetId) ?? new Set<string>();
        set.add(r.sourceId);
        idx.actorsOf.set(r.targetId, set);
        break;
      }
      case "usecaseScreen":
        if (!idx.screenOf.has(r.sourceId)) idx.screenOf.set(r.sourceId, r.targetId);
        break;
      case "usecaseSystem":
        if (!idx.targetOf.has(r.sourceId)) idx.targetOf.set(r.sourceId, r.targetId);
        break;
      case "usecaseNext":
        push(idx.nextOf, r.sourceId, r.targetId);
        break;
      case "usecaseEvent":
        push(emitsOf, r.sourceId, r.targetId);
        push(idx.emittersOf, r.targetId, r.sourceId);
        break;
      case "systemEvent":
        push(idx.systemEmittersOf, r.targetId, r.sourceId);
        break;
      case "eventUsecase":
        push(triggersOf, r.sourceId, r.targetId);
        break;
      case "activityTrigger":
        push(idx.originActivitiesOf, r.targetId, r.sourceId);
        break;
      case "eventActivity":
        push(idx.originEventsOf, r.targetId, r.sourceId);
        break;
    }
  }
  // 操作 A → イベント → 操作 B も「次」として足す
  for (const [a, events] of emitsOf) for (const ev of events) for (const b of triggersOf.get(ev) ?? []) push(idx.nextOf, a, b);
  return idx;
}

// ---------------------------------------------------------------- 導出

interface Analysis {
  /** 作業の連鎖・起点から導いた遷移 (設計の画面 id。重複なし) */
  edges: { from: string; to: string }[];
  /** 入口の画面 (設計の画面 id。設計の画面の並び順) と、その注記 */
  entries: Map<string, string[]>;
}

/**
 * サイトマップにある画面 (screens) どうしの、分析から導ける遷移と、入口の画面・注記を集める。
 * 作業の中 (操作の「次に」・イベントをはさんだ連鎖) と作業の間 (起点) を辿り、担当のアクターが違う・システムが違うものは遷移にせず注記にする。
 * 入口は作業ごとに判定する: 作業の最初の画面のうち、その作業の起点から遷移で入れないもの。いずれかの作業で入口なら、画面として入口
 */
function analyze(model: UntieModel, systemId: string, screens: readonly DesignScreen[]): Analysis {
  const idx = buildIndex(model);
  const dsOfScreen = new Map<string, string>();
  for (const s of screens) {
    if (s.source.kind !== "screen") continue;
    const el = idx.byId.get(s.source.screenId);
    if (el?.kind === "screen" && el.systemId === systemId) dsOfScreen.set(el.id, s.id);
  }
  /** 操作の画面 (サイトマップにあるものだけ) */
  const dsOfUsecase = (uc: string): string | undefined => {
    const screenId = idx.screenOf.get(uc);
    return screenId === undefined ? undefined : dsOfScreen.get(screenId);
  };
  /** 操作が別のシステム (対象の画面か、対象のシステム) のものなら、その名前 */
  const otherSystemName = (uc: string): string | undefined => {
    const screenId = idx.screenOf.get(uc);
    const screen = screenId === undefined ? undefined : idx.byId.get(screenId);
    const sysId = screen?.kind === "screen" ? screen.systemId : idx.targetOf.get(uc);
    const sys = sysId === undefined ? undefined : idx.byId.get(sysId);
    return sys?.kind === "system" && sys.id !== systemId ? nameOf(sys) : undefined;
  };
  const actorsOfUsecase = (uc: string): Set<string> => {
    const out = new Set<string>();
    for (const a of idx.activitiesOf.get(uc) ?? []) for (const actor of idx.actorsOf.get(a) ?? []) out.add(actor);
    return out;
  };
  const actorsOfActivity = (a: string): Set<string> => idx.actorsOf.get(a) ?? new Set();
  /** 担当 (アクターのみ。外部アクターは数えない) が交わる。どちらかが空なら、違うとは言えないので通す */
  const sameActors = (x: Set<string>, y: Set<string>): boolean => x.size === 0 || y.size === 0 || [...x].some((a) => y.has(a));
  const handoffOf = (uc: string): string | undefined => {
    const a = idx.activitiesOf.get(uc)?.[0];
    return a === undefined ? undefined : `作業「${nameOf(idx.byId.get(a))}」から引き継ぎ`;
  };
  const fromSystem = (name: string) => `${name}から`;

  const edges: { from: string; to: string }[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const key = `${from}\n${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };

  /**
   * 操作 fromUc (画面 fromDs) の次に、サイトマップの画面 toDs が来る。遷移にできれば "edge"、同じ画面なら "same"、
   * 遷移にできなかった入り方は注記を note に足して "none"
   */
  const link = (
    fromUc: string,
    fromDs: string | undefined,
    toDs: string,
    actorsOfFrom: Set<string>,
    actorsOfTo: Set<string>,
    handoff: string | undefined,
    note: (text: string | undefined) => void,
  ): "edge" | "same" | "none" => {
    if (fromDs !== undefined) {
      if (fromDs === toDs) return "same";
      if (sameActors(actorsOfFrom, actorsOfTo)) {
        addEdge(fromDs, toDs);
        return "edge";
      }
      note(handoff);
      return "none";
    }
    const other = otherSystemName(fromUc);
    if (other !== undefined) note(fromSystem(other));
    return "none";
  };

  // 1. 作業の中・作業をまたぐ操作の連鎖
  for (const [a, nexts] of idx.nextOf) {
    for (const b of nexts) {
      const toDs = dsOfUsecase(b);
      if (toDs === undefined || a === b) continue;
      link(a, dsOfUsecase(a), toDs, actorsOfUsecase(a), actorsOfUsecase(b), handoffOf(a), () => {});
    }
  }

  /** 作業の中の、操作の前後 (「次に」・イベントをはさんだ連鎖のうち、同じ作業の操作どうし) */
  const chainOf = (activityId: string) => {
    const ucs = idx.usecasesOf.get(activityId) ?? [];
    const inside = new Set(ucs);
    const next = new Map<string, string[]>();
    const prev = new Map<string, string[]>();
    for (const u of ucs) {
      for (const n of idx.nextOf.get(u) ?? []) {
        if (!inside.has(n) || n === u) continue;
        push(next, u, n);
        push(prev, n, u);
      }
    }
    return { ucs, next, prev };
  };
  /** 輪 (自分に戻れる操作) の中で、作業の中の並びが最初の操作 */
  const firstInCycle = (ucs: string[], next: Map<string, string[]>): string[] => {
    const onCycle = (u: string): boolean => {
      const seen = new Set<string>();
      const stack = [...(next.get(u) ?? [])];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === u) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...(next.get(cur) ?? []));
      }
      return false;
    };
    const pick = ucs.find(onCycle) ?? ucs[0];
    return pick === undefined ? [] : [pick];
  };
  /** 画面のある操作まで、連鎖を (次または前へ) 辿る。端の操作に画面が無いとき、その先の操作を使う */
  const withScreen = (starts: string[], step: Map<string, string[]>): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      if (dsOfUsecase(u) !== undefined) out.push(u);
      else queue.push(...(step.get(u) ?? []));
    }
    return out;
  };
  /** 作業の最初・最後の操作 (画面のあるもの)。前・次が無い操作から始め、輪だけのときは輪の中で並びが最初の操作 */
  const endsOf = (activityId: string): { firsts: string[]; lasts: string[] } => {
    const { ucs, next, prev } = chainOf(activityId);
    const noPrev = ucs.filter((u) => !(prev.get(u)?.length));
    const noNext = ucs.filter((u) => !(next.get(u)?.length));
    return {
      firsts: withScreen(noPrev.length > 0 ? noPrev : firstInCycle(ucs, next), next),
      lasts: withScreen(noNext.length > 0 ? noNext : firstInCycle(ucs, next), prev),
    };
  };

  // 2. 作業の間 (起点) と、作業ごとの入口の判定
  const entries = new Map<string, string[]>();
  for (const activity of model.elements) {
    if (activity.kind !== "activity") continue;
    const firsts = [...new Set(endsOf(activity.id).firsts.map(dsOfUsecase).filter((d): d is string => d !== undefined))];
    if (firsts.length === 0) continue;
    const actorsB = actorsOfActivity(activity.id);
    // 最初の画面ごと: 起点から遷移で入れたか、入れなかった理由
    const entered = new Set<string>();
    const notes = new Map<string, string[]>(firsts.map((d) => [d, []]));
    const noteFor = (toDs: string) => (text: string | undefined) => {
      const list = notes.get(toDs)!;
      if (text !== undefined && !list.includes(text)) list.push(text);
    };
    const record = (toDs: string, result: "edge" | "same" | "none") => {
      if (result !== "none") entered.add(toDs);
    };
    for (const originId of idx.originActivitiesOf.get(activity.id) ?? []) {
      const actorsA = actorsOfActivity(originId);
      for (const u of endsOf(originId).lasts) {
        for (const toDs of firsts) {
          record(toDs, link(u, dsOfUsecase(u), toDs, actorsA, actorsB, `作業「${nameOf(idx.byId.get(originId))}」から引き継ぎ`, noteFor(toDs)));
        }
      }
      // 起点の作業の最後の操作に画面が無い (別システムなど) ときの、別システムの注記
      const { ucs } = chainOf(originId);
      if (endsOf(originId).lasts.length === 0) {
        for (const u of ucs) for (const toDs of firsts) if (otherSystemName(u) !== undefined) noteFor(toDs)(fromSystem(otherSystemName(u)!));
      }
    }
    for (const eventId of idx.originEventsOf.get(activity.id) ?? []) {
      const emitters = idx.emittersOf.get(eventId) ?? [];
      for (const u of emitters) {
        for (const toDs of firsts) record(toDs, link(u, dsOfUsecase(u), toDs, actorsOfUsecase(u), actorsB, handoffOf(u), noteFor(toDs)));
      }
      // システムだけが出すイベント (操作が出さないイベントも) は遷移にならない
      if ((idx.systemEmittersOf.get(eventId)?.length ?? 0) > 0 || emitters.length === 0) {
        for (const toDs of firsts) noteFor(toDs)(`イベント「${nameOf(idx.byId.get(eventId))}」から`);
      }
    }
    if (activity.triggerNote) for (const toDs of firsts) noteFor(toDs)(`起点: ${activity.triggerNote}`);
    for (const toDs of firsts) {
      if (entered.has(toDs)) continue;
      const list = entries.get(toDs) ?? [];
      for (const n of notes.get(toDs)!) if (!list.includes(n)) list.push(n);
      entries.set(toDs, list);
    }
  }
  const order = new Map(screens.map((s, i) => [s.id, i]));
  return { edges, entries: new Map([...entries].sort((x, y) => (order.get(x[0]) ?? 0) - (order.get(y[0]) ?? 0))) };
}

/** 入口の画面 (設計の画面の id。設計の画面の並び順)。作業ごとの判定は analyze (5.7) */
export function entryScreenIds(model: UntieModel, systemId: string, design: Pick<SystemDesign, "screens">): string[] {
  return [...analyze(model, systemId, design.screens).entries.keys()];
}

export interface DerivedTransition {
  from: string;
  to: string;
  /** 組み込みの画面からのもの (入口へのメニュー nav・サインインのあと afterSubmit・トップページからサインインへのボタン button) だけ。ほかは未定 */
  via?: Extract<Via, "nav" | "afterSubmit" | "button">;
}

/**
 * サイトマップの画面 (screens。設計の画面の全体) から、足すべき遷移を導く。from ≠ to、重複なし。
 * existing (設計にすでにある遷移) と同じ from / to は足さない。
 * 規則は docs/design.md 5.7: 作業の中の連鎖、作業の間 (起点)、担当・システムが違うものは遷移にしない、
 * 組み込みの画面からの遷移 (builtinTransitions)。
 */
export function deriveTransitions(
  model: UntieModel,
  systemId: string,
  screens: readonly DesignScreen[],
  existing: readonly Pick<Transition, "from" | "to">[] = [],
): DerivedTransition[] {
  const { edges, entries } = analyze(model, systemId, screens);
  const seen = new Set(existing.map((t) => `${t.from}\n${t.to}`));
  const out: DerivedTransition[] = [];
  const add = (from: string, to: string, via?: DerivedTransition["via"]) => {
    const key = `${from}\n${to}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, ...(via ? { via } : {}) });
  };
  for (const e of edges) add(e.from, e.to);
  for (const b of builtinTransitions(screens, [...entries.keys()])) add(b.from, b.to, b.via);
  return out;
}

/**
 * 組み込みの画面からの遷移の、今の入口に合う形 (docs/design.md 5.7):
 * ホームがあれば: トップページ (未ログインの最初の画面) とサインインの両方があれば トップ → サインイン (button)、
 * サインイン → ホーム (afterSubmit)・ホーム → 入口 (nav)、サインインが無くトップページがあれば トップ → ホーム (nav)。
 * ホームが無ければトップページが起点: トップ → 入口 (nav)・サインイン → トップ (afterSubmit)。トップも無ければ サインイン → 入口 (afterSubmit)
 */
function builtinTransitions(screens: readonly DesignScreen[], entries: readonly string[]): (Required<Pick<DerivedTransition, "via">> & DerivedTransition)[] {
  const find = (b: Builtin) => screens.find((s) => s.source.kind === "builtin" && s.source.builtin === b);
  const top = find("top");
  const signIn = find("signIn");
  const home = find("home");
  const out: (Required<Pick<DerivedTransition, "via">> & DerivedTransition)[] = [];
  if (home) {
    if (top && signIn) out.push({ from: top.id, to: signIn.id, via: "button" });
    if (top && !signIn) out.push({ from: top.id, to: home.id, via: "nav" });
    if (signIn) out.push({ from: signIn.id, to: home.id, via: "afterSubmit" });
    for (const e of entries) out.push({ from: home.id, to: e, via: "nav" });
    return out;
  }
  if (top) for (const e of entries) out.push({ from: top.id, to: e, via: "nav" });
  if (signIn) {
    if (top) out.push({ from: signIn.id, to: top.id, via: "afterSubmit" });
    else for (const e of entries) out.push({ from: signIn.id, to: e, via: "afterSubmit" });
  }
  return out;
}

/**
 * 入口の画面ごとの注記。遷移にできなかった入り方を示す:
 * 「作業「○○」から引き継ぎ」(担当が違う)、「○○から」(別のシステムの画面・対象の操作からの連鎖)、
 * 「イベント「○○」から」(システムが出すイベント)、「起点: ○○」(作業の `triggerNote`)。
 * キーが入口の画面で、注記が無い入口は空の配列
 */
export function entryNotes(model: UntieModel, systemId: string, design: Pick<SystemDesign, "screens" | "transitions">): Map<string, string[]> {
  return analyze(model, systemId, design.screens).entries;
}

// ---------------------------------------------------------------- 木

export interface SitemapTreeNode {
  id: string;
  kind: "business" | "buc" | "activity" | "usecase";
  name: string;
  /** この節の部分木が届く、対象の分析の画面 (id。重複なし) */
  screenIds: string[];
  /** 操作だけ: その操作の画面名 (対象の画面のみ) */
  screenNames: string[];
  children: SitemapTreeNode[];
}

/**
 * 左の木: 業務 → 活動 (既定の活動は出さず、その作業を業務の直下に) → 作業 → 操作。
 * 活動に入っていない作業は最後に並べる。操作に結ばれていない操作 (作業に使われない操作) は出さない
 */
export function sitemapTree(model: UntieModel, systemId: string): SitemapTreeNode[] {
  const idx = buildIndex(model);
  const usecaseNode = (id: string): SitemapTreeNode | null => {
    const uc = idx.byId.get(id);
    if (uc?.kind !== "usecase") return null;
    const screenId = idx.screenOf.get(id);
    const screen = screenId === undefined ? undefined : idx.byId.get(screenId);
    const mine = screen?.kind === "screen" && screen.systemId === systemId ? screen : undefined;
    return { id, kind: "usecase", name: nameOf(uc), screenIds: mine ? [mine.id] : [], screenNames: mine ? [nameOf(mine)] : [], children: [] };
  };
  const union = (nodes: SitemapTreeNode[]): string[] => [...new Set(nodes.flatMap((n) => n.screenIds))];
  const activityNode = (a: Element): SitemapTreeNode => {
    const children = (idx.usecasesOf.get(a.id) ?? []).map(usecaseNode).filter((n): n is SitemapTreeNode => n !== null);
    return { id: a.id, kind: "activity", name: nameOf(a), screenIds: union(children), screenNames: [], children };
  };
  const activities = model.elements.filter((e) => e.kind === "activity");
  const bucs = model.elements.filter((e) => e.kind === "buc");
  const inBuc = (bucId: string) => activities.filter((a) => a.bucId === bucId).map(activityNode);
  const out: SitemapTreeNode[] = [];
  for (const biz of model.elements) {
    if (biz.kind !== "business") continue;
    const direct: SitemapTreeNode[] = [];
    const groups: SitemapTreeNode[] = [];
    for (const buc of bucs) {
      if (buc.businessId !== biz.id) continue;
      if (buc.isDefault) direct.push(...inBuc(buc.id));
      else {
        const children = inBuc(buc.id);
        groups.push({ id: buc.id, kind: "buc", name: nameOf(buc), screenIds: union(children), screenNames: [], children });
      }
    }
    const children = [...direct, ...groups];
    out.push({ id: biz.id, kind: "business", name: nameOf(biz), screenIds: union(children), screenNames: [], children });
  }
  const placed = new Set(bucs.map((b) => b.id));
  for (const a of activities) if (a.bucId === null || !placed.has(a.bucId)) out.push(activityNode(a));
  return out;
}

export type CheckState = "checked" | "indeterminate" | "unchecked";

/** 節 (届く画面の集合) のチェックの状態。サイトマップにある画面 (分析の画面の id) から導く。届く画面が無ければ unchecked (チェックできない節) */
export function checkStateOf(screenIds: readonly string[], present: ReadonlySet<string>): CheckState {
  if (screenIds.length === 0) return "unchecked";
  const n = screenIds.filter((s) => present.has(s)).length;
  return n === 0 ? "unchecked" : n === screenIds.length ? "checked" : "indeterminate";
}

/** 設計の画面のうち分析の画面を指すものの、分析の画面の id の集合 */
export function presentScreenIds(design: Pick<SystemDesign, "screens"> | undefined): Set<string> {
  return new Set((design?.screens ?? []).flatMap((s) => (s.source.kind === "screen" ? [s.source.screenId] : [])));
}

/** 分析の画面 (id の列) に当たる設計の画面 */
export function designScreensOf(design: Pick<SystemDesign, "screens"> | undefined, screenIds: readonly string[]): DesignScreen[] {
  const set = new Set(screenIds);
  return (design?.screens ?? []).filter((s) => s.source.kind === "screen" && set.has(s.source.screenId));
}

/** 組み込みの画面に当たる設計の画面 */
export function builtinDesignScreen(design: Pick<SystemDesign, "screens"> | undefined, builtin: Builtin): DesignScreen | undefined {
  return design?.screens.find((s) => s.source.kind === "builtin" && s.source.builtin === builtin);
}

/** 消すと失われる画面の設計 (画面 UI・項目の対応) を持つ画面 */
export function screensWithDesign(screens: readonly DesignScreen[]): DesignScreen[] {
  return screens.filter((s) => s.view !== undefined || (s.bindings?.length ?? 0) > 0);
}

/**
 * 組み込みの画面 (トップページ・サインイン・ホーム) からの遷移を、今の入口と組み込みの画面の有無に合わせて付け直す。
 * 対象は via が nav / afterSubmit のまま (トップページ → サインインの button も) で label が無いもの: 足りないものを足し、入口でなくなった先のものを消す。
 * label を付けるなど手を入れた遷移は残す
 */
export function syncBuiltinTransitions(model: UntieModel, systemId: string): UntieModel {
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) return model;
  const builtinIds = new Set(design.screens.filter((s) => s.source.kind === "builtin" && SITEMAP_BUILTINS.includes(s.source.builtin)).map((s) => s.id));
  if (builtinIds.size === 0) return model;
  const wanted = builtinTransitions(design.screens, entryScreenIds(model, systemId, design));
  const wantedKeys = new Set(wanted.map((t) => `${t.from}\n${t.to}`));
  // 自動で付けたもの: 組み込みの画面から、nav / afterSubmit のまま、または トップページ → サインインの button で、label が無い
  const top = builtinDesignScreen(design, "top");
  const signIn = builtinDesignScreen(design, "signIn");
  const managed = (t: Transition) =>
    builtinIds.has(t.from) && !t.label && (t.via === "nav" || t.via === "afterSubmit" || (t.via === "button" && top !== undefined && signIn !== undefined && t.from === top.id && t.to === signIn.id));
  const stale = design.transitions.filter((t) => managed(t) && !wantedKeys.has(`${t.from}\n${t.to}`));
  const have = new Set(design.transitions.map((t) => `${t.from}\n${t.to}`));
  const missing = wanted.filter((t) => !have.has(`${t.from}\n${t.to}`));
  if (stale.length === 0 && missing.length === 0) return model;
  const staleIds = new Set(stale.map((t) => t.id));
  const used = usedDesignIds(model);
  const added: Transition[] = missing.map((t) => {
    const id = newUniqueId("transition", used);
    used.add(id);
    return { id, from: t.from, to: t.to, via: t.via };
  });
  return produce(model, (draft) => {
    const d = draft.designs.find((x) => x.systemId === systemId)!;
    d.transitions = [...d.transitions.filter((t) => !staleIds.has(t.id)), ...added];
  });
}

/**
 * 画面をサイトマップに足し、あわせて遷移を導いて足す (1 回の変更)。設計が無ければ作る。すでにある画面は足さない。
 * 足すのは、足した画面にかかわる遷移だけ (ユーザーが消した遷移を、別の画面を足すたびに戻さない)。
 * そのあと、組み込みの画面からの遷移を今の入口に合わせて付け直す。足す画面が無ければ何も変えない
 */
export function addSitemapScreens(model: UntieModel, systemId: string, sources: readonly DesignScreen["source"][]): CommandResult {
  const ensured = ensureDesign(model, { systemId });
  if (!ensured.ok) return ensured;
  const base = ensured.model;
  const design = base.designs.find((d) => d.systemId === systemId)!;
  const keyOf = (s: DesignScreen["source"]) => (s.kind === "screen" ? `screen:${s.screenId}` : `builtin:${s.builtin}`);
  const have = new Set(design.screens.map((s) => keyOf(s.source)));
  const used = usedDesignIds(base);
  const fresh: DesignScreen[] = [];
  for (const source of sources) {
    if (have.has(keyOf(source))) continue;
    have.add(keyOf(source));
    const id = newUniqueId("designScreen", used);
    used.add(id);
    fresh.push({ id, source });
  }
  if (fresh.length === 0) return { ok: true, model };
  const freshIds = new Set(fresh.map((s) => s.id));
  const transitions = deriveTransitions(base, systemId, [...design.screens, ...fresh], design.transitions).filter((t) => freshIds.has(t.from) || freshIds.has(t.to));
  const added = addDesignScreens(base, { systemId, screens: fresh, transitions });
  return added.ok ? { ok: true, model: syncBuiltinTransitions(added.model, systemId) } : added;
}

/** 画面 (設計の画面の id) をサイトマップから外し、組み込みの画面からの遷移を今の入口に合わせて付け直す */
export function removeSitemapScreens(model: UntieModel, systemId: string, ids: readonly string[]): CommandResult {
  const removed = removeDesignScreensById(model, { systemId, ids: [...ids] });
  return removed.ok ? { ok: true, model: syncBuiltinTransitions(removed.model, systemId) } : removed;
}

// ---------------------------------------------------------------- ナビゲーション

/** 「サイトマップから作る」で「その他」に入れる画面のグループ名と、ホーム (無ければトップページ) のグループ名 */
export const NAV_HOME_GROUP = "ホーム";
export const NAV_OTHER_GROUP = "その他";

/**
 * サイトマップの画面から、ナビゲーションを作る (AI 不要)。画面を、その画面を使う操作の業務ごとにグループ化する (業務の並び順、画面は木の順)。
 * ホームは「ホーム」グループの先頭 (ホームが無ければトップページ。どちらも無ければ「ホーム」は作らない)。トップページ (ホームがあるとき) とサインインは入れない。
 * 業務に入らない画面 (使う操作が無い・活動に入っていない作業の操作) は最後の「その他」。グループの id は新しく作る (設計をまたいで一意)。
 * 設計が無ければ空
 */
export function navigationFromSitemap(model: UntieModel, systemId: string): { id: string; group: string; items: { screenId: string }[] }[] {
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) return [];
  const designOf = new Map<string, string>();
  for (const s of design.screens) if (s.source.kind === "screen") designOf.set(s.source.screenId, s.id);
  const placed = new Set<string>();
  const groups: { group: string; screenIds: string[] }[] = [];
  const take = (id: string | undefined, into: string[]) => {
    if (id === undefined || placed.has(id)) return;
    placed.add(id);
    into.push(id);
  };

  // ホームがあればホームが「ホーム」グループの先頭。無ければトップページ。トップページ (未ログインの画面) がホームと並ぶときは入れない
  const top = builtinDesignScreen(design, "top");
  const signIn = builtinDesignScreen(design, "signIn");
  const home = builtinDesignScreen(design, "home");
  if (signIn) placed.add(signIn.id);
  if (home && top) placed.add(top.id);
  const first = home ?? top;
  if (first) {
    const into: string[] = [];
    take(first.id, into);
    groups.push({ group: NAV_HOME_GROUP, screenIds: into });
  }
  const walk = (node: SitemapTreeNode): string[] => [...node.screenIds, ...node.children.flatMap(walk)];
  for (const node of sitemapTree(model, systemId)) {
    const into: string[] = [];
    for (const analysisId of walk(node)) take(designOf.get(analysisId), into);
    if (into.length > 0) groups.push({ group: node.kind === "business" ? node.name : NAV_OTHER_GROUP, screenIds: into });
  }
  const rest: string[] = [];
  for (const s of design.screens) take(s.id, rest);
  if (rest.length > 0) groups.push({ group: NAV_OTHER_GROUP, screenIds: rest });

  // 同じ名前のグループ (業務の名前が重なる・「その他」) は 1 つにまとめる
  const merged: typeof groups = [];
  for (const g of groups) {
    const same = merged.find((m) => m.group === g.group);
    if (same) same.screenIds.push(...g.screenIds);
    else merged.push({ group: g.group, screenIds: [...g.screenIds] });
  }
  const used = usedDesignIds(model);
  return merged.map((g) => {
    const id = newUniqueId("navGroup", used);
    used.add(id);
    return { id, group: g.group, items: g.screenIds.map((screenId) => ({ screenId })) };
  });
}
