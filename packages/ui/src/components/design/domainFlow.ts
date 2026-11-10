// ドメインボードの図を React Flow のノード・エッジに直す。位置は保存せず、毎回ここで決める。
//   集約とイベント: 5 列 (きっかけ (外のイベント) → コマンド → 集約 → イベント → 受け手 (外の操作・作業))。distill-ddd の集約⇄イベントの図と同じ並び
//   業務の流れ:     操作とイベントを「次に」「発生」「きっかけ」でつなぎ、入ってくる線の無いものから幅優先で層を決めて左から右へ並べる
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { DesignDomainSelection, DomainScope } from "@untie/core/model/domainScope";
import type { UntieModel } from "@untie/core/model/types";

export type DomainNodeKind = "trigger" | "command" | "query" | "aggregate" | "event" | "consumer" | "activity";

/** ノードの中身 (選択と薄くするかは finish で足す) */
export interface DomainNodeBase {
  kind: DomainNodeKind;
  label: string;
  /** 下に小さく出す補足 (コンテキスト・対象・担い手など) */
  sub?: string;
  /** 印 (取得だけ・外・時間など) */
  badges: string[];
  /** 問いの数 (0 なら出さない) */
  questions: number;
  /** 押したときに選ぶもの (選べないノードは undefined) */
  selection?: DesignDomainSelection;
}

export type DomainNodeData = DomainNodeBase & { selected: boolean; dim: boolean } & Record<string, unknown>;

export type DomainFlowNode = Node<DomainNodeData, "domain">;

export const DOMAIN_NODE_WIDTH = 200;
export const DOMAIN_NODE_HEIGHT = 52;
const GAP_Y = 16;
const COLUMN_GAP = 70;
const COLUMN_X = (i: number) => i * (DOMAIN_NODE_WIDTH + COLUMN_GAP);

interface RawEdge {
  source: string;
  target: string;
  label?: string;
  /** ポリシー (イベント → 操作)。強調の辿りでは使わない (輪になって全部が光るのを避ける) */
  policy?: boolean;
}

const sameSelection = (a: DesignDomainSelection | undefined, b: DesignDomainSelection | undefined) =>
  !!a && !!b && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

/** 問いの数を、要素 id ごとに数える */
function questionCounts(scope: DomainScope): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of scope.notices) {
    if (n.level !== "question") continue;
    const id = n.elementIds[0];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** 選んだノードから、線を下流と上流へそれぞれ辿って届くノード (ポリシーの線は辿らない) */
function reachable(start: string[], edges: RawEdge[]): Set<string> {
  const out = new Set(start);
  const walk = (dir: "down" | "up") => {
    const queue = [...start];
    const seen = new Set(start);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const e of edges) {
        if (e.policy) continue;
        const next = dir === "down" ? (e.source === id ? e.target : null) : e.target === id ? e.source : null;
        if (next && !seen.has(next)) {
          seen.add(next);
          out.add(next);
          queue.push(next);
        }
      }
    }
  };
  walk("down");
  walk("up");
  return out;
}

function finish(
  nodes: { id: string; x: number; y: number; data: DomainNodeBase }[],
  raw: RawEdge[],
  selected: DesignDomainSelection | undefined,
  contextOf: Map<string, string | null>,
): { nodes: DomainFlowNode[]; edges: Edge[] } {
  // 選んだものに当たるノード (コンテキストを選んだら、そのコンテキストの集約・イベント・コマンド)
  const hits = nodes
    .filter((n) => (selected?.kind === "context" ? contextOf.has(n.id) && contextOf.get(n.id) === selected.id : sameSelection(n.data.selection, selected)))
    .map((n) => n.id);
  const lit = selected && hits.length > 0 ? reachable(hits, raw) : null;
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "domain" as const,
      position: { x: n.x, y: n.y },
      width: DOMAIN_NODE_WIDTH,
      height: DOMAIN_NODE_HEIGHT,
      data: { ...n.data, selected: hits.includes(n.id), dim: !!lit && !lit.has(n.id) },
    })),
    edges: raw.map((e, i) => ({
      id: `e${i}:${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      ...(e.label ? { label: e.label } : {}),
      markerEnd: { type: MarkerType.ArrowClosed },
      ...(e.policy ? { style: { strokeDasharray: "5 4" } } : {}),
      className: lit && !(lit.has(e.source) && lit.has(e.target)) ? "is-dim" : undefined,
    })),
  };
}

/** 集約とイベント: きっかけ → コマンド → 集約 → イベント → 受け手 */
export function buildAggregateFlow(scope: DomainScope, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(scope);
  const contextRank = new Map<string | null, number>(scope.contexts.map((c, i) => [c.context?.id ?? null, i]));
  const rankOf = (cid: string | null | undefined) => contextRank.get(cid ?? null) ?? contextRank.size;
  const contextName = new Map<string | null, string>(scope.contexts.map((c) => [c.context?.id ?? null, c.context?.name ?? "未分類"]));
  const contextOf = new Map<string, string | null>();
  const columns: { id: string; data: DomainNodeBase }[][] = [[], [], [], [], []];
  const raw: RawEdge[] = [];

  // 集約 (コマンドが書く情報。読むだけで状態を変えるコマンドは持ち主)
  const aggregates = scope.contexts.flatMap((c) => c.aggregates).filter((a) => scope.commands.some((cmd) => cmd.aggregate?.id === a.candidate.information.id));
  for (const a of aggregates) {
    const info = a.candidate.information;
    const id = `aggregate:${info.id}`;
    contextOf.set(id, info.contextId);
    columns[2]!.push({
      id,
      data: {
        kind: "aggregate",
        label: info.name,
        sub: `${contextName.get(info.contextId) ?? "未分類"}${a.candidate.stateGroups.length > 0 ? ` ・ ${a.candidate.stateGroups.join("・")}` : ""}`,
        badges: a.writtenHere ? [] : ["書かない"],
        questions: questions.get(info.id) ?? 0,
        selection: { kind: "aggregate", id: info.id },
      },
    });
  }

  // コマンド (集約のコンテキストの順)
  const commands = [...scope.commands].sort((a, b) => rankOf(a.aggregate?.contextId) - rankOf(b.aggregate?.contextId));
  for (const c of commands) {
    const id = `command:${c.usecase.id}`;
    contextOf.set(id, c.aggregate?.contextId ?? null);
    const split = scope.splitCommands.filter((x) => x.usecase.id === c.usecase.id).length;
    columns[1]!.push({
      id,
      data: {
        kind: "command",
        label: c.usecase.name,
        sub: c.auto ? "自動" : c.actors.map((a) => a.name).join("・") || (c.activities.length === 0 ? "(作業なし)" : "(担当なし)"),
        badges: [...(c.readOnly ? ["取得だけ"] : []), ...(split > 1 ? [`作業 ${split}`] : [])],
        questions: questions.get(c.usecase.id) ?? 0,
        selection: { kind: "command", id: c.usecase.id },
      },
    });
    if (c.aggregate) raw.push({ source: id, target: `aggregate:${c.aggregate.id}` });
  }

  // イベント (内) と、きっかけ (外)
  const events = [...scope.events].sort((a, b) => rankOf(a.row.event.contextId) - rankOf(b.row.event.contextId));
  for (const e of events) {
    const ev = e.row.event;
    const id = `event:${ev.id}`;
    contextOf.set(id, ev.contextId);
    const data: DomainNodeBase = {
      kind: e.origin === "inside" ? "event" : "trigger",
      label: ev.name,
      sub: e.origin === "outside" ? `発生元: ${e.sources.map((s) => s.name).join("・") || "?"}` : (contextName.get(ev.contextId) ?? "未分類"),
      badges: [...(e.row.timed ? ["時間"] : []), ...(e.origin === "outside" ? ["外"] : [])],
      questions: questions.get(ev.id) ?? 0,
      selection: { kind: "event", id: ev.id },
    };
    columns[e.origin === "inside" ? 3 : 0]!.push({ id, data });
  }
  const eventIds = new Set(events.map((e) => e.row.event.id));
  for (const c of commands) {
    const from = c.aggregate ? `aggregate:${c.aggregate.id}` : `command:${c.usecase.id}`;
    for (const ev of c.events) if (eventIds.has(ev.id)) raw.push({ source: from, target: `event:${ev.id}` });
    for (const ev of c.triggeredBy) if (eventIds.has(ev.id)) raw.push({ source: `event:${ev.id}`, target: `command:${c.usecase.id}`, label: "ポリシー", policy: true });
  }
  // システムが直接出すイベントは、システムから出る線を引かない (発生元は補足に出す)
  // 受け手 (このシステムの外の操作と、イベントを起点にする作業)
  const consumerIds = new Set<string>();
  for (const e of events) {
    if (e.origin !== "inside") continue;
    for (const oc of e.outsideConsumers) {
      const id = `consumer:${oc.usecase.id}`;
      if (!consumerIds.has(id)) {
        consumerIds.add(id);
        columns[4]!.push({ id, data: { kind: "consumer", label: oc.usecase.name, sub: oc.place ? `対象: ${oc.place.name}` : "(対象なし)", badges: ["外"], questions: 0 } });
      }
      raw.push({ source: `event:${e.row.event.id}`, target: id });
    }
    for (const a of e.row.consumers.activities) {
      const id = `activity:${a.id}`;
      if (!consumerIds.has(id)) {
        consumerIds.add(id);
        columns[4]!.push({ id, data: { kind: "activity", label: a.name, sub: "作業の起点", badges: [], questions: 0 } });
      }
      raw.push({ source: `event:${e.row.event.id}`, target: id });
    }
  }

  const nodes = columns.flatMap((col, ci) => col.map((n, ri) => ({ ...n, x: COLUMN_X(ci), y: ri * (DOMAIN_NODE_HEIGHT + GAP_Y) })));
  return finish(nodes, raw, selected, contextOf);
}

/** 業務の流れ: 操作 (コマンド・クエリ) とイベントを、次に・発生・きっかけでつなぎ、幅優先で層を決めて並べる */
export function buildBusinessFlow(model: UntieModel, scope: DomainScope, selected: DesignDomainSelection | undefined): { nodes: DomainFlowNode[]; edges: Edge[] } {
  const questions = questionCounts(scope);
  const contextOf = new Map<string, string | null>();
  const items: { id: string; data: DomainNodeBase }[] = [];
  const usecaseIds = new Set<string>();
  for (const c of scope.commands) {
    usecaseIds.add(c.usecase.id);
    const id = `command:${c.usecase.id}`;
    contextOf.set(id, c.aggregate?.contextId ?? null);
    items.push({
      id,
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
    items.push({ id: `command:${q.usecase.id}`, data: { kind: "query", label: q.usecase.name, sub: q.screen ? `画面: ${q.screen.name}` : undefined, badges: ["問い合わせ"], questions: 0 } });
  }
  const eventIds = new Set<string>();
  for (const e of scope.events) {
    eventIds.add(e.row.event.id);
    const id = `event:${e.row.event.id}`;
    contextOf.set(id, e.row.event.contextId);
    items.push({
      id,
      data: {
        kind: e.origin === "inside" ? "event" : "trigger",
        label: e.row.event.name,
        badges: [...(e.row.timed ? ["時間"] : []), ...(e.origin === "outside" ? ["外"] : [])],
        questions: questions.get(e.row.event.id) ?? 0,
        selection: { kind: "event", id: e.row.event.id },
      },
    });
  }
  const raw: RawEdge[] = [];
  for (const r of model.relations) {
    if (r.kind === "usecaseNext" && usecaseIds.has(r.sourceId) && usecaseIds.has(r.targetId)) raw.push({ source: `command:${r.sourceId}`, target: `command:${r.targetId}`, label: "次に" });
    else if (r.kind === "usecaseEvent" && usecaseIds.has(r.sourceId) && eventIds.has(r.targetId)) raw.push({ source: `command:${r.sourceId}`, target: `event:${r.targetId}` });
    else if (r.kind === "eventUsecase" && eventIds.has(r.sourceId) && usecaseIds.has(r.targetId)) raw.push({ source: `event:${r.sourceId}`, target: `command:${r.targetId}`, label: "きっかけ" });
  }

  // 層: 入ってくる線の無いものから幅優先。輪だけのまとまりは、残った最初のものから始める。線の無いものは最後の列
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(items.map((n) => [n.id, 0]));
  for (const e of raw) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const connected = new Set(raw.flatMap((e) => [e.source, e.target]));
  const layer = new Map<string, number>();
  const bfs = (roots: string[]) => {
    const queue = roots.filter((r) => !layer.has(r));
    for (const r of queue) layer.set(r, 0);
    while (queue.length > 0) {
      const id = queue.shift()!;
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
  const nodes = items.map((n) => {
    const l = layer.get(n.id)!;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    return { ...n, x: COLUMN_X(l), y: r * (DOMAIN_NODE_HEIGHT + GAP_Y) };
  });
  return finish(nodes, raw, selected, contextOf);
}
