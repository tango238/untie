// ドメインボードの図を React Flow のノード・エッジに直す。位置は保存せず、毎回ここで決める。
//   集約とイベント: 5 列 (きっかけ (外のイベント) → コマンド → 集約 → イベント → 受け手 (外の操作・作業))。distill-ddd の集約⇄イベントの図と同じ並び。
//                   行はコンテキストごとの帯に分け、帯の中で各列を上から積む
//   業務の流れ:     操作とイベントを「次に」「発生」「きっかけ」でつなぎ、入ってくる線の無いものから幅優先で層を決めて左から右へ並べる
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { commandContextId, type DesignDomainSelection, type DomainScope } from "@untie/core/model/domainScope";
import type { UntieModel } from "@untie/core/model/types";

export type DomainNodeKind = "trigger" | "command" | "query" | "aggregate" | "event" | "consumer" | "activity";

/** ノードの中身 (選択と薄くするかは finish で足す) */
export interface DomainNodeBase {
  kind: DomainNodeKind;
  label: string;
  /** 下に小さく出す補足 (コンテキスト・対象・担い手など) */
  sub?: string;
  /** 印 (取得だけ・外・定期など) */
  badges: string[];
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
export function buildAggregateFlow(scope: DomainScope, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(scope);
  const contextName = new Map<string | null, string>(scope.contexts.map((c) => [c.context?.id ?? null, c.context?.name ?? "未分類"]));
  for (const e of scope.events) if (e.row.context && !contextName.has(e.row.context.id)) contextName.set(e.row.context.id, e.row.context.name);
  const upstream = new Set(scope.contexts.filter((c) => c.role === "upstream").map((c) => c.context?.id ?? null));
  // 帯の順: しぼった範囲のコンテキストの順 (自分 → 上流)、その後に出てきた順。未分類は最後
  const bandOrder: (string | null)[] = scope.contexts.map((c) => c.context?.id ?? null).filter((id) => id !== null);
  const bandOf = (cid: string | null | undefined): string | null => {
    const id = cid ?? null;
    if (id !== null && !bandOrder.includes(id)) bandOrder.push(id);
    return id;
  };
  type Cell = { id: string; band: string | null; col: number; data: DomainNodeBase; context?: string | null };
  const cells: Cell[] = [];
  const edges: RawEdge[] = [];
  const has = new Set<string>();
  const push = (cell: Cell) => {
    if (has.has(cell.id)) return;
    has.add(cell.id);
    cells.push(cell);
  };

  // コマンド
  const splitCount = new Map<string, number>();
  for (const c of scope.splitCommands) splitCount.set(c.usecase.id, (splitCount.get(c.usecase.id) ?? 0) + 1);
  const commandBand = new Map<string, string | null>();
  for (const c of scope.commands) {
    const band = bandOf(commandContextId(c));
    commandBand.set(c.usecase.id, band);
    const split = splitCount.get(c.usecase.id) ?? 1;
    push({
      id: `command:${c.usecase.id}`,
      band,
      col: 1,
      context: band,
      data: {
        kind: "command",
        label: c.usecase.name,
        sub: c.auto ? "自動" : c.actors.map((a) => a.name).join("・") || (c.activities.length === 0 ? "(作業なし)" : "(担当なし)"),
        badges: [...(c.readOnly ? ["取得だけ"] : []), ...(split > 1 ? [`作業 ${split}`] : [])],
        questions: questions.get(c.usecase.id) ?? 0,
        selection: { kind: "command", id: c.usecase.id },
      },
    });
  }

  // 集約: このシステムが書く情報すべてと、読むだけで状態を変えるコマンドの持ち主
  const aggregates = scope.contexts.flatMap((c) => c.aggregates);
  const aggregateIds = new Set<string>();
  for (const c of scope.commands) {
    for (const w of c.writes) aggregateIds.add(w.id);
    if (c.aggregate) aggregateIds.add(c.aggregate.id);
  }
  for (const a of aggregates) {
    const info = a.candidate.information;
    if (!aggregateIds.has(info.id)) continue;
    const band = bandOf(info.contextId);
    push({
      id: `aggregate:${info.id}`,
      band,
      col: 2,
      context: band,
      data: {
        kind: "aggregate",
        label: info.name,
        sub: a.candidate.stateGroups.length > 0 ? a.candidate.stateGroups.join("・") : undefined,
        badges: [...(a.writtenHere ? [] : ["参照"]), ...(a.otherWriterSystems.length > 0 ? ["ほかでも書く"] : [])],
        questions: questions.get(info.id) ?? 0,
        selection: { kind: "aggregate", id: info.id },
      },
    });
  }
  for (const c of scope.commands) {
    const from = `command:${c.usecase.id}`;
    // 書く情報すべてへ線を引く。読むだけのコマンドは、変える状態の持ち主へ
    const targets = c.writes.length > 0 ? c.writes : c.aggregate ? [c.aggregate] : [];
    for (const t of targets) if (aggregateIds.has(t.id)) edges.push({ source: from, target: `aggregate:${t.id}`, via: c.usecase.id });
  }

  // イベント (内) と、きっかけ (外)
  const eventIds = new Set(scope.events.map((e) => e.row.event.id));
  const firstCommandOf = new Map<string, string>();
  for (const c of scope.commands) for (const ev of c.triggeredBy) if (!firstCommandOf.has(ev.id)) firstCommandOf.set(ev.id, c.usecase.id);
  const emitterOf = new Map<string, string>();
  for (const c of scope.commands) for (const ev of c.events) if (!emitterOf.has(ev.id)) emitterOf.set(ev.id, c.usecase.id);
  for (const e of scope.events) {
    const ev = e.row.event;
    const inside = e.origin === "inside";
    const band = inside
      ? bandOf(ev.contextId ?? (emitterOf.has(ev.id) ? commandBand.get(emitterOf.get(ev.id)!) : null))
      : bandOf(firstCommandOf.has(ev.id) ? commandBand.get(firstCommandOf.get(ev.id)!) : ev.contextId);
    const scheduled = e.row.timed;
    push({
      id: `event:${ev.id}`,
      band,
      col: inside ? 3 : 0,
      context: ev.contextId ?? null,
      data: {
        kind: inside ? "event" : "trigger",
        label: ev.name,
        sub: inside
          ? e.otherSources.length > 0
            ? `ほかにも: ${e.otherSources.map((s) => s.name).join("・")}`
            : undefined
          : e.sources.length > 0
            ? `発生元: ${e.sources.map((s) => s.name).join("・")}`
            : scheduled
              ? "定期 (発生元なし)"
              : "発生元なし",
        badges: [...(scheduled ? ["定期"] : []), ...(inside ? [] : ["外"])],
        questions: questions.get(ev.id) ?? 0,
        selection: { kind: "event", id: ev.id },
      },
    });
  }
  for (const c of scope.commands) {
    const primary = c.aggregate && aggregateIds.has(c.aggregate.id) ? `aggregate:${c.aggregate.id}` : c.writes[0] && aggregateIds.has(c.writes[0].id) ? `aggregate:${c.writes[0].id}` : `command:${c.usecase.id}`;
    for (const ev of c.events) if (eventIds.has(ev.id)) edges.push({ source: primary, target: `event:${ev.id}`, via: c.usecase.id });
    for (const ev of c.triggeredBy) if (eventIds.has(ev.id)) edges.push({ source: `event:${ev.id}`, target: `command:${c.usecase.id}`, policy: true });
  }

  // 受け手 (このシステムの外の操作と、イベントを起点にする作業)。帯は最初につながるイベントの帯
  for (const e of scope.events) {
    if (e.origin !== "inside") continue;
    const band = cells.find((x) => x.id === `event:${e.row.event.id}`)?.band ?? null;
    for (const oc of e.outsideConsumers) {
      const id = `consumer:${oc.usecase.id}`;
      push({ id, band, col: 4, data: { kind: "consumer", label: oc.usecase.name, sub: oc.place ? `対象: ${oc.place.name}` : "(対象なし)", badges: ["外"], questions: 0 } });
      // 外の受け手は先へ続かないので、強調では辿る (破線だけ)
      edges.push({ source: `event:${e.row.event.id}`, target: id, dashed: true });
    }
    for (const a of e.row.consumers.activities) {
      const id = `activity:${a.id}`;
      push({ id, band, col: 4, data: { kind: "activity", label: a.name, sub: "作業の起点", badges: [], questions: 0 } });
      edges.push({ source: `event:${e.row.event.id}`, target: id });
    }
  }

  // 帯ごとに、各列を上から積む。未分類は最後
  const order = [...bandOrder.filter((b) => b !== null), ...(cells.some((c) => c.band === null) ? [null] : [])];
  const raw: RawNode[] = [];
  const bands: Node<DomainBandData, "band">[] = [];
  let top = 0;
  for (const band of order) {
    const inBand = cells.filter((c) => c.band === band);
    if (inBand.length === 0) continue;
    const rows = Math.max(...[0, 1, 2, 3, 4].map((col) => inBand.filter((c) => c.col === col).length));
    const height = BAND_HEAD + rows * (DOMAIN_NODE_HEIGHT + GAP_Y) - GAP_Y + BAND_PAD;
    const label = `${contextName.get(band) ?? "未分類"}${upstream.has(band) ? " (読むだけ・上流)" : ""}`;
    bands.push({
      id: `band:${band ?? "none"}`,
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
export function buildBusinessFlow(model: UntieModel, scope: DomainScope, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(scope);
  const items: RawNode[] = [];
  const usecaseIds = new Set<string>();
  for (const c of scope.commands) {
    usecaseIds.add(c.usecase.id);
    items.push({
      id: `command:${c.usecase.id}`,
      x: 0,
      y: 0,
      context: commandContextId(c),
      data: {
        kind: "command",
        label: c.usecase.name,
        sub: c.auto ? "自動" : c.actors.map((a) => a.name).join("・") || undefined,
        badges: c.readOnly ? ["取得だけ"] : [],
        questions: questions.get(c.usecase.id) ?? 0,
        selection: { kind: "command", id: c.usecase.id },
      },
    });
  }
  for (const q of scope.queries) {
    usecaseIds.add(q.usecase.id);
    items.push({
      id: `command:${q.usecase.id}`,
      x: 0,
      y: 0,
      context: q.reads[0]?.contextId ?? null,
      data: { kind: "query", label: q.usecase.name, sub: q.screen ? `画面: ${q.screen.name}` : undefined, badges: ["問い合わせ"], questions: questions.get(q.usecase.id) ?? 0, selection: { kind: "query", id: q.usecase.id } },
    });
  }
  const eventIds = new Set<string>();
  for (const e of scope.events) {
    eventIds.add(e.row.event.id);
    items.push({
      id: `event:${e.row.event.id}`,
      x: 0,
      y: 0,
      context: e.row.event.contextId ?? null,
      data: {
        kind: e.origin === "inside" ? "event" : "trigger",
        label: e.row.event.name,
        badges: [...(e.row.timed ? ["定期"] : []), ...(e.origin === "outside" ? ["外"] : [])],
        questions: questions.get(e.row.event.id) ?? 0,
        selection: { kind: "event", id: e.row.event.id },
      },
    });
  }
  const edges: RawEdge[] = [];
  for (const r of model.relations) {
    if (r.kind === "usecaseNext" && usecaseIds.has(r.sourceId) && usecaseIds.has(r.targetId)) edges.push({ source: `command:${r.sourceId}`, target: `command:${r.targetId}`, label: "次に" });
    else if (r.kind === "usecaseEvent" && usecaseIds.has(r.sourceId) && eventIds.has(r.targetId)) edges.push({ source: `command:${r.sourceId}`, target: `event:${r.targetId}` });
    else if (r.kind === "eventUsecase" && eventIds.has(r.sourceId) && usecaseIds.has(r.targetId)) edges.push({ source: `event:${r.sourceId}`, target: `command:${r.targetId}`, policy: true });
  }

  // 層: 入ってくる線の無いものから幅優先。輪だけのまとまりは、残った最初のものから始める。線の無いものは最後の列
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(items.map((n) => [n.id, 0]));
  for (const e of edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
  const layer = new Map<string, number>();
  const bfs = (roots: string[]) => {
    const queue = roots.filter((r) => !layer.has(r));
    for (const r of queue) layer.set(r, 0);
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
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    n.x = COLUMN_X(l);
    n.y = r * (DOMAIN_NODE_HEIGHT + GAP_Y);
  }
  return finish(items, edges, [], selected);
}
