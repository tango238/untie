// ドメインボードの図を React Flow のノード・エッジに直す。位置は保存せず、毎回ここで決める。
//   集約とイベント: 5 列 (きっかけ (外のイベント) → コマンド → 集約 → イベント → 受け手 (外の操作・作業))。distill-ddd の集約⇄イベントの図と同じ並び。
//                   行はコンテキストごとの帯に分け、帯の中で各列を上から積む
//   業務の流れ:     操作とイベントを「次に」「発生」「きっかけ」でつなぎ、入ってくる線の無いものから幅優先で層を決めて左から右へ並べる
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { resolvedCommandContextKey, type ResolvedDomain } from "@untie/core/model/domainResolve";
import type { DesignDomainSelection, DomainScope } from "@untie/core/model/domainScope";
import type { UntieModel } from "@untie/core/model/types";

export type DomainNodeKind = "trigger" | "command" | "query" | "aggregate" | "event" | "consumer" | "activity";

/** ノードの中身 (選択と薄くするかは finish で足す) */
export interface DomainNodeBase {
  kind: DomainNodeKind;
  label: string;
  /** 下に小さく出す補足 (コンテキスト・対象・担い手など) */
  sub?: string;
  /** 印 (取得だけ・外・定期・候補など) */
  badges: string[];
  /** まだ保存していない候補 (破線の枠で見せる) */
  candidate?: boolean;
  /** 問いの数 (0 なら出さない) */
  questions: number;
  /** 押したときに選ぶもの (選べないノードは undefined) */
  selection?: DesignDomainSelection;
}

export type DomainNodeData = DomainNodeBase & { selected: boolean; dim: boolean } & Record<string, unknown>;
export type DomainBandData = { label: string } & Record<string, unknown>;

export type DomainFlowNode = Node<DomainNodeData, "domain"> | Node<DomainBandData, "band">;

export const DOMAIN_NODE_WIDTH = 200;
export const DOMAIN_NODE_HEIGHT = 52;
const GAP_Y = 14;
const COLUMN_GAP = 70;
const COLUMN_X = (i: number) => i * (DOMAIN_NODE_WIDTH + COLUMN_GAP);
/** 帯の見出しの高さと、帯どうしの間 */
const BAND_HEAD = 30;
const BAND_GAP = 18;
const BAND_PAD = 10;

interface RawEdge {
  source: string;
  target: string;
  label?: string;
  /** ポリシー (イベント → 操作)。強調では、選んだノードから 1 歩だけ辿る (輪になって全部が残るのを避ける) */
  policy?: boolean;
  /** 線の出どころの操作 (コマンド → 集約 → イベント)。集約を通るとき、同じ操作の線だけを辿る */
  via?: string;
  /** 破線で描く (ポリシーと、外の受け手への線) */
  dashed?: boolean;
}

interface RawNode {
  id: string;
  x: number;
  y: number;
  data: DomainNodeBase;
  /** 属するコンテキスト (コンテキストを選んだときの当たり。undefined は当たらない) */
  context?: string | null;
}

const sameSelection = (a: DesignDomainSelection | undefined, b: DesignDomainSelection | undefined) =>
  !!a && !!b && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

/** 問いの数を、主役の要素 id ごとに数える */
function questionCounts(scope: DomainScope): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of scope.notices) {
    if (n.level !== "question") continue;
    const id = n.elementIds[0];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * 選んだノードから、線を下流と上流へそれぞれ辿って届くノード。
 * ポリシーの線は選んだノードから 1 歩だけ辿る。集約を通るときは、入ってきた線と同じ操作の線だけを辿る (集約が束ねる別の操作のイベントまで広げない)
 */
function reachable(starts: Set<string>, edges: RawEdge[]): Set<string> {
  const out = new Map<string, RawEdge[]>();
  const into = new Map<string, RawEdge[]>();
  for (const e of edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
    (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e);
  }
  const lit = new Set(starts);
  for (const dir of ["down", "up"] as const) {
    const adj = dir === "down" ? out : into;
    const queue: { id: string; via: string | null; first: boolean }[] = [...starts].map((id) => ({ id, via: null, first: true }));
    const seen = new Set(queue.map((q) => `${q.id}|`));
    for (let i = 0; i < queue.length; i++) {
      const { id, via, first } = queue[i]!;
      for (const e of adj.get(id) ?? []) {
        if (e.policy && !first) continue;
        if (via && e.via && e.via !== via) continue;
        const next = dir === "down" ? e.target : e.source;
        const nextVia = e.via ?? null;
        const key = `${next}|${nextVia ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lit.add(next);
        queue.push({ id: next, via: nextVia, first: false });
      }
    }
  }
  return lit;
}

function finish(raw: RawNode[], edges: RawEdge[], bands: Node<DomainBandData, "band">[], selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  // 選んだものに当たるノード (コンテキストを選んだら、そのコンテキストの集約・コマンド・イベント)
  const hits = new Set(raw.filter((n) => (selected?.kind === "context" ? n.context !== undefined && n.context === selected.id : sameSelection(n.data.selection, selected))).map((n) => n.id));
  const lit = selected && hits.size > 0 ? reachable(hits, edges) : null;
  const nodes: DomainFlowNode[] = [
    ...bands,
    ...raw.map((n) => ({
      id: n.id,
      type: "domain" as const,
      position: { x: n.x, y: n.y },
      width: DOMAIN_NODE_WIDTH,
      height: DOMAIN_NODE_HEIGHT,
      data: { ...n.data, selected: hits.has(n.id), dim: !!lit && !lit.has(n.id) },
    })),
  ];
  const seenEdge = new Set<string>();
  const outEdges: Edge[] = [];
  for (const e of edges) {
    const id = `${e.source}->${e.target}${e.via ? `@${e.via}` : ""}`;
    if (seenEdge.has(id)) continue;
    seenEdge.add(id);
    outEdges.push({
      id,
      source: e.source,
      target: e.target,
      ...(e.label ? { label: e.label } : {}),
      markerEnd: { type: MarkerType.ArrowClosed },
      ...(e.policy || e.dashed ? { style: { strokeDasharray: "5 4" } } : {}),
      className: lit && !(lit.has(e.source) && lit.has(e.target)) ? "is-dim" : undefined,
    });
  }
  return { nodes, edges: outEdges };
}

/** 集約とイベント: きっかけ → コマンド → 集約 → イベント → 受け手。行はコンテキストごとの帯 */
export function buildAggregateFlow(r: ResolvedDomain, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(r.scope);
  const contextByKey = new Map(r.contexts.map((c) => [c.key, c]));
  const eventByKey = new Map(r.events.map((e) => [e.key, e]));
  // 帯の順: コンテキストの順 (自分 → 上流)。どのコンテキストにも入らないものは最後 (band = undefined)
  type Band = string | null | undefined;
  type Cell = { id: string; band: Band; col: number; data: DomainNodeBase; context?: string | null };
  const cells: Cell[] = [];
  const edges: RawEdge[] = [];
  const has = new Set<string>();
  const push = (cell: Cell) => {
    if (has.has(cell.id)) return;
    has.add(cell.id);
    cells.push(cell);
  };
  const bandOf = (key: string | null | undefined): Band => (key !== undefined && contextByKey.has(key) ? key : undefined);

  // コマンド
  const commandBand = new Map<string, Band>();
  for (const c of r.commands) {
    const band = bandOf(resolvedCommandContextKey(r, c));
    commandBand.set(c.key, band);
    const cand = c.candidate;
    const usecaseId = cand?.usecase.id;
    const split = usecaseId && !cand?.activity ? r.scope.splitCommands.filter((x) => x.usecase.id === usecaseId).length : 1;
    push({
      id: `command:${c.key}`,
      band,
      col: 1,
      context: band ?? null,
      data: {
        kind: "command",
        label: c.name,
        sub: !cand ? "あるべき姿" : cand.auto ? "自動" : cand.actors.map((a) => a.name).join("・") || (cand.activities.length === 0 ? "(作業なし)" : "(担当なし)"),
        badges: [...(cand?.readOnly ? ["取得だけ"] : []), ...(split > 1 ? [`作業 ${split}`] : []), ...(cand?.activity ? [`作業: ${cand.activity.name}`] : [])],
        questions: usecaseId ? (questions.get(usecaseId) ?? 0) : 0,
        selection: { kind: "command", id: c.key },
        candidate: !c.saved,
      },
    });
  }

  // 集約: このシステムが書くもの、コマンドの集約、保存した集約
  const shownAggregates = new Set<string>();
  for (const a of r.aggregates) if (a.writtenHere || (a.saved && contextByKey.get(a.contextKey)?.role === "own")) shownAggregates.add(a.key);
  for (const c of r.commands) if (c.aggregateKey !== null) shownAggregates.add(c.aggregateKey);
  for (const e of r.events) if (e.aggregateKey !== null && e.origin === "inside") shownAggregates.add(e.aggregateKey);
  for (const a of r.aggregates) {
    if (!shownAggregates.has(a.key)) continue;
    push({
      id: `aggregate:${a.key}`,
      band: bandOf(a.contextKey),
      col: 2,
      context: a.contextKey,
      data: {
        kind: "aggregate",
        label: a.name,
        sub: [a.members.length > 0 ? `中: ${a.members.map((m) => m.name).join("・")}` : "", a.stateGroups.join("・")].filter(Boolean).join(" ・ ") || undefined,
        badges: [...(a.writtenHere ? [] : ["参照"]), ...(a.otherWriterSystems.length > 0 ? ["ほかでも書く"] : [])],
        questions: [a.root, ...a.members].reduce((n, i) => n + (questions.get(i.id) ?? 0), 0),
        selection: { kind: "aggregate", id: a.key },
        candidate: !a.saved,
      },
    });
  }
  /** 情報 id → その情報が入っている集約のノード */
  const aggregateNodeOfInfo = new Map<string, string>();
  for (const a of r.aggregates) {
    if (!shownAggregates.has(a.key)) continue;
    for (const i of [a.root, ...a.members]) if (!aggregateNodeOfInfo.has(i.id)) aggregateNodeOfInfo.set(i.id, `aggregate:${a.key}`);
  }
  for (const c of r.commands) {
    const from = `command:${c.key}`;
    const targets = new Set<string>();
    // 書く情報の集約すべてへ線を引く。読むだけのコマンド・あるべき姿のコマンドは、その集約へ
    for (const w of c.candidate?.writes ?? []) {
      const node = aggregateNodeOfInfo.get(w.id);
      if (node) targets.add(node);
    }
    if (c.aggregateKey !== null && shownAggregates.has(c.aggregateKey)) targets.add(`aggregate:${c.aggregateKey}`);
    for (const t of targets) edges.push({ source: from, target: t, via: c.key });
  }

  // イベント (内) と、きっかけ (外)
  const firstCommandOf = new Map<string, string>();
  for (const p of r.policies) if (!firstCommandOf.has(p.eventKey)) firstCommandOf.set(p.eventKey, p.commandKey);
  for (const e of r.events) {
    const inside = e.origin === "inside";
    const scoped = e.scoped;
    const band = inside ? bandOf(e.contextKey) : (commandBand.get(firstCommandOf.get(e.key) ?? "") ?? bandOf(e.contextKey));
    const scheduled = scoped?.row.timed ?? false;
    const sub = !scoped
      ? "あるべき姿"
      : inside
        ? scoped.otherSources.length > 0
          ? `ほかにも: ${scoped.otherSources.map((s) => s.name).join("・")}`
          : undefined
        : scoped.sources.length > 0
          ? `発生元: ${scoped.sources.map((s) => s.name).join("・")}`
          : scheduled
            ? "定期 (発生元なし)"
            : "発生元なし";
    push({
      id: `event:${e.key}`,
      band,
      col: inside ? 3 : 0,
      context: e.contextKey,
      data: {
        kind: inside ? "event" : "trigger",
        label: e.name,
        sub: !inside && e.contextKey !== null && contextByKey.get(e.contextKey)?.saved ? `${contextByKey.get(e.contextKey)!.name}${sub ? ` ・ ${sub}` : ""}` : sub,
        badges: [...(scheduled ? ["定期"] : []), ...(inside ? [] : ["外"])],
        questions: scoped ? (questions.get(scoped.row.event.id) ?? 0) : 0,
        selection: { kind: "event", id: e.key },
        candidate: !e.saved,
      },
    });
  }
  for (const c of r.commands) {
    const primary = c.aggregateKey !== null && shownAggregates.has(c.aggregateKey) ? `aggregate:${c.aggregateKey}` : `command:${c.key}`;
    for (const key of c.eventKeys) if (eventByKey.get(key)?.origin === "inside") edges.push({ source: primary, target: `event:${key}`, via: c.key });
  }
  for (const p of r.policies) if (eventByKey.has(p.eventKey)) edges.push({ source: `event:${p.eventKey}`, target: `command:${p.commandKey}`, policy: true });

  // 受け手 (このシステムの外の操作と、イベントを起点にする作業)。帯はつながるイベントの帯
  for (const e of r.events) {
    if (e.origin !== "inside" || !e.scoped) continue;
    const band = cells.find((x) => x.id === `event:${e.key}`)?.band;
    for (const oc of e.scoped.outsideConsumers) {
      const id = `consumer:${oc.usecase.id}`;
      push({ id, band, col: 4, data: { kind: "consumer", label: oc.usecase.name, sub: oc.place ? `対象: ${oc.place.name}` : "(対象なし)", badges: ["外"], questions: 0 } });
      // 外の受け手は先へ続かないので、強調では辿る (破線だけ)
      edges.push({ source: `event:${e.key}`, target: id, dashed: true });
    }
    for (const a of e.scoped.row.consumers.activities) {
      const id = `activity:${a.id}`;
      push({ id, band, col: 4, data: { kind: "activity", label: a.name, sub: "作業の起点", badges: [], questions: 0 } });
      edges.push({ source: `event:${e.key}`, target: id });
    }
  }

  // 帯ごとに、各列を上から積む。どのコンテキストにも入らないものは最後
  const order: Band[] = [...r.contexts.map((c) => c.key as Band), undefined];
  const raw: RawNode[] = [];
  const bands: Node<DomainBandData, "band">[] = [];
  let top = 0;
  for (const band of order) {
    const inBand = cells.filter((c) => c.band === band);
    if (inBand.length === 0) continue;
    const rows = Math.max(...[0, 1, 2, 3, 4].map((col) => inBand.filter((c) => c.col === col).length));
    const height = BAND_HEAD + rows * (DOMAIN_NODE_HEIGHT + GAP_Y) - GAP_Y + BAND_PAD;
    const ctx = band !== undefined ? contextByKey.get(band) : undefined;
    const label = !ctx ? "コンテキストなし" : `${ctx.name}${ctx.saved ? "" : " (候補)"}${ctx.role === "upstream" ? " (読むだけ・上流)" : ""}${ctx.unassigned ? " (未割り当て)" : ""}`;
    bands.push({
      id: `band:${band === undefined ? "?" : (band ?? "none")}`,
      type: "band",
      position: { x: -BAND_PAD, y: top },
      width: COLUMN_X(4) + DOMAIN_NODE_WIDTH + BAND_PAD * 2,
      height,
      zIndex: -1,
      selectable: false,
      data: { label },
    });
    for (const col of [0, 1, 2, 3, 4]) {
      inBand
        .filter((c) => c.col === col)
        .forEach((c, i) => raw.push({ id: c.id, x: COLUMN_X(col), y: top + BAND_HEAD + i * (DOMAIN_NODE_HEIGHT + GAP_Y), data: c.data, context: c.context }));
    }
    top += height + BAND_GAP;
  }
  return finish(raw, edges, bands, selected);
}

/** 業務の流れ: 操作 (コマンド・問い合わせ) とイベントを、次に・発生・きっかけでつなぎ、幅優先で層を決めて並べる */
export function buildBusinessFlow(model: UntieModel, r: ResolvedDomain, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(r.scope);
  const items: RawNode[] = [];
  /** 操作 id → コマンドのノード (作業で分けたコマンドは複数) */
  const nodesOfUsecase = new Map<string, string[]>();
  for (const c of r.commands) {
    const id = `command:${c.key}`;
    const cand = c.candidate;
    if (cand) nodesOfUsecase.set(cand.usecase.id, [...(nodesOfUsecase.get(cand.usecase.id) ?? []), id]);
    items.push({
      id,
      x: 0,
      y: 0,
      context: resolvedCommandContextKey(r, c),
      data: {
        kind: "command",
        label: c.name,
        sub: !cand ? "あるべき姿" : cand.auto ? "自動" : cand.actors.map((a) => a.name).join("・") || undefined,
        badges: cand?.readOnly ? ["取得だけ"] : [],
        questions: cand ? (questions.get(cand.usecase.id) ?? 0) : 0,
        selection: { kind: "command", id: c.key },
        candidate: !c.saved,
      },
    });
  }
  for (const q of r.scope.queries) {
    nodesOfUsecase.set(q.usecase.id, [`command:${q.usecase.id}`]);
    items.push({
      id: `command:${q.usecase.id}`,
      x: 0,
      y: 0,
      data: { kind: "query", label: q.usecase.name, sub: q.screen ? `画面: ${q.screen.name}` : undefined, badges: ["問い合わせ"], questions: questions.get(q.usecase.id) ?? 0, selection: { kind: "query", id: q.usecase.id } },
    });
  }
  for (const e of r.events) {
    items.push({
      id: `event:${e.key}`,
      x: 0,
      y: 0,
      context: e.contextKey,
      data: {
        kind: e.origin === "inside" ? "event" : "trigger",
        label: e.name,
        sub: e.scoped ? undefined : "あるべき姿",
        badges: [...(e.scoped?.row.timed ? ["定期"] : []), ...(e.origin === "outside" ? ["外"] : [])],
        questions: e.scoped ? (questions.get(e.scoped.row.event.id) ?? 0) : 0,
        selection: { kind: "event", id: e.key },
        candidate: !e.saved,
      },
    });
  }
  const edges: RawEdge[] = [];
  for (const rel of model.relations) {
    if (rel.kind !== "usecaseNext") continue;
    for (const from of nodesOfUsecase.get(rel.sourceId) ?? []) for (const to of nodesOfUsecase.get(rel.targetId) ?? []) edges.push({ source: from, target: to, label: "次に" });
  }
  for (const c of r.commands) for (const key of c.eventKeys) edges.push({ source: `command:${c.key}`, target: `event:${key}` });
  for (const p of r.policies) edges.push({ source: `event:${p.eventKey}`, target: `command:${p.commandKey}`, policy: true });

  // 層: 入ってくる線の無いものから幅優先。輪だけのまとまりは、残った最初のものから始める。線の無いものは最後の列
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(items.map((n) => [n.id, 0]));
  const known = new Set(items.map((n) => n.id));
  const valid = edges.filter((e) => known.has(e.source) && known.has(e.target));
  for (const e of valid) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const connected = new Set(valid.flatMap((e) => [e.source, e.target]));
  const layer = new Map<string, number>();
  const bfs = (roots: string[]) => {
    const queue = roots.filter((x) => !layer.has(x));
    for (const x of queue) layer.set(x, 0);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const next of out.get(id) ?? []) {
        if (layer.has(next)) continue;
        layer.set(next, layer.get(id)! + 1);
        queue.push(next);
      }
    }
  };
  bfs(items.filter((n) => connected.has(n.id) && indeg.get(n.id) === 0).map((n) => n.id));
  for (const n of items) if (connected.has(n.id) && !layer.has(n.id)) bfs([n.id]);
  const maxLayer = Math.max(-1, ...layer.values());
  for (const n of items) if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1);
  const rows = new Map<number, number>();
  for (const n of items) {
    const l = layer.get(n.id)!;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    n.x = COLUMN_X(l);
    n.y = row * (DOMAIN_NODE_HEIGHT + GAP_Y);
  }
  return finish(items, valid, [], selected);
}
