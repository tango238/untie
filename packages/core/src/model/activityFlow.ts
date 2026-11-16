// 業務フローボード (分析（簡易）と分析（詳細）で共通) の組み立て。1 枚の図に、横軸は業務ごとの帯の中で作業を順に左から右へ、縦軸は担当の登場人物。
// 一番上に外部アクター (発生させるイベント)、一番下にシステム・帳票 (作業が使う操作の対象) を置く。
// 作業の順序は作業 → 作業の起点 (activityTrigger: 始点が前の作業、終点が後の作業) をそのまま使う。モデルには保存せず、毎回組み立てる。
import { defaultBucOf } from "./selectors";
import type { Activity, Actor, Business, Buc, EventElement, ExternalActor, UntieModel } from "./types";

export const FLOW_BOARD_LABEL = "業務フロー";

export interface FlowCell {
  activity: Activity;
  businessId: string;
  /** 図全体の列 (0 始まり)。業務の帯ごとに左から並べ、順序が決まっていない作業は、その業務の順序のある作業の右に 1 列ずつ並べる */
  column: number;
  /** 前後のどちらにも順序が決まっていない作業 */
  unordered: boolean;
  /** 担当 (複数のときは先頭の行に出す。全員の名前をカードに添える) */
  assignees: (Actor | ExternalActor)[];
  /** カードの中に添えるきっかけのイベント (行にカードとして出していないもの) */
  triggerEvents: EventElement[];
}

/** 外部アクターの行に出す、そのアクターが発生させて作業の起点になるイベント */
export interface FlowEventCell {
  event: EventElement;
  column: number;
}

export interface FlowRow {
  /** 担当なしの行は null */
  actor: Actor | ExternalActor | null;
  /** 外部アクターの行か (作業は持たず、発生させるイベントを出す) */
  external: boolean;
  cells: FlowCell[];
  events: FlowEventCell[];
}

/** 業務の帯 (上の山形)。columns 列ぶん */
export interface FlowBand {
  business: Business;
  start: number;
  columns: number;
}

/** 一番下の行の、システム・帳票のカード。同じ列で同じものは 1 枚にまとめる */
export interface FlowSystemCell {
  key: string;
  element: { id: string; name: string; kind: "system" | "ledger" };
  column: number;
  /** この対象を使う操作の作業 */
  activityIds: string[];
}

export type FlowLinkKind = "order" | "event" | "system";

/** 線でつなぐ 1 本 (sourceId / targetId は、カードの key) */
export interface FlowLink {
  id: string;
  kind: FlowLinkKind;
  sourceId: string;
  targetId: string;
}

export interface ActivityFlow {
  bands: FlowBand[];
  columns: number;
  rows: FlowRow[];
  systems: FlowSystemCell[];
  links: FlowLink[];
  /** どの業務にも属さない作業 (順序は決められない) */
  orphans: Activity[];
  /** 起点にする作業が無く、図に出していないイベントの数 (外部アクターが発生させるもの) */
  hiddenEvents: number;
}

function activitiesOf(model: UntieModel, business: Business): Activity[] {
  const bucs = model.elements.filter((e): e is Buc => e.kind === "buc" && e.businessId === business.id);
  const ids = new Set(bucs.map((b) => b.id));
  // 業務直下の作業 (既定の活動) を先に、活動の作業を活動の順に並べる
  const def = defaultBucOf(model, business.id);
  const order = [...(def ? [def.id] : []), ...bucs.filter((b) => b.id !== def?.id).map((b) => b.id)];
  const acts = model.elements.filter((e): e is Activity => e.kind === "activity" && e.bucId !== null && ids.has(e.bucId));
  return order.flatMap((id) => acts.filter((a) => a.bucId === id));
}

/** 同じ業務の中の作業の列を決める。順序の最長の長さ (輪になる順序は、戻る線を無視する) */
function columnsOf(acts: Activity[], links: { sourceId: string; targetId: string }[]): Map<string, number> {
  const next = new Map<string, string[]>(acts.map((a) => [a.id, []]));
  for (const l of links) next.get(l.sourceId)?.push(l.targetId);
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of next.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  for (const a of acts) if (!state.has(a.id)) visit(a.id);
  const prev = new Map<string, string[]>(acts.map((a) => [a.id, []]));
  for (const [s, ts] of next) for (const t of ts) if (!back.has(`${s}>${t}`)) prev.get(t)!.push(s);
  const col = new Map<string, number>();
  const depth = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...(prev.get(id) ?? []).map(depth)) + 1;
    col.set(id, d);
    return d;
  };
  for (const a of acts) depth(a.id);
  return col;
}

/** 業務フローを組み立てる */
export function buildActivityFlow(model: UntieModel): ActivityFlow {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const isActor = (e: unknown): e is Actor | ExternalActor => !!e && ((e as { kind: string }).kind === "actor" || (e as { kind: string }).kind === "externalActor");
  const triggers = model.relations.filter((r) => r.kind === "activityTrigger");
  const shown = new Set<string>();

  const bands: FlowBand[] = [];
  const cells: FlowCell[] = [];
  const links: FlowLink[] = [];
  let offset = 0;
  for (const business of model.elements.filter((e): e is Business => e.kind === "business")) {
    const acts = activitiesOf(model, business);
    for (const a of acts) shown.add(a.id);
    if (acts.length === 0) continue;
    const ids = new Set(acts.map((a) => a.id));
    const inner = triggers.filter((r) => ids.has(r.sourceId) && ids.has(r.targetId));
    const col = columnsOf(acts, inner);
    const linked = new Set(inner.flatMap((r) => [r.sourceId, r.targetId]));
    let columns = Math.max(0, ...acts.filter((a) => linked.has(a.id)).map((a) => col.get(a.id)! + 1));
    for (const activity of acts) {
      const unordered = !linked.has(activity.id);
      const column = offset + (unordered ? columns++ : col.get(activity.id)!);
      const assignees = model.relations.filter((r) => r.kind === "actorActivity" && r.targetId === activity.id).map((r) => byId.get(r.sourceId)).filter(isActor);
      cells.push({ activity, businessId: business.id, column, unordered, assignees, triggerEvents: [] });
    }
    for (const r of inner) links.push({ id: r.id, kind: "order", sourceId: r.sourceId, targetId: r.targetId });
    columns = Math.max(columns, 1);
    bands.push({ business, start: offset, columns });
    offset += columns;
  }
  const cellOf = new Map(cells.map((c) => [c.activity.id, c]));

  // 外部アクターが発生させ、作業の起点になるイベント: 外部アクターの行に、最初の起点の作業と同じ列で出す
  const eventCells = new Map<string, FlowEventCell[]>();
  const shownEvents = new Set<string>();
  let hiddenEvents = 0;
  for (const rel of model.relations.filter((r) => r.kind === "externalActorEvent")) {
    const actor = byId.get(rel.sourceId);
    const event = byId.get(rel.targetId);
    if (actor?.kind !== "externalActor" || event?.kind !== "event") continue;
    const targets = model.relations.filter((r) => r.kind === "eventActivity" && r.sourceId === event.id && cellOf.has(r.targetId));
    if (targets.length === 0) {
      hiddenEvents++;
      continue;
    }
    const list = eventCells.get(actor.id) ?? [];
    list.push({ event, column: cellOf.get(targets[0]!.targetId)!.column });
    eventCells.set(actor.id, list);
    shownEvents.add(event.id);
    for (const t of targets) links.push({ id: `ev:${actor.id}:${event.id}:${t.targetId}`, kind: "event", sourceId: `${actor.id}:${event.id}`, targetId: t.targetId });
  }
  for (const c of cells) {
    c.triggerEvents = model.relations
      .filter((r) => r.kind === "eventActivity" && r.targetId === c.activity.id)
      .map((r) => byId.get(r.sourceId))
      .filter((e): e is EventElement => e?.kind === "event" && !shownEvents.has(e.id));
  }

  // 行: 外部アクター (上) → 業務の主担当・担当の登場人物 (出てきた順) → 担当なし → (システムは別)
  const rows: FlowRow[] = [];
  for (const [actorId, evs] of eventCells) rows.push({ actor: byId.get(actorId) as ExternalActor, external: true, cells: [], events: evs });
  const internal: (Actor | ExternalActor | null)[] = [];
  for (const b of bands) {
    for (const r of model.relations.filter((x) => x.kind === "actorBusiness" && x.targetId === b.business.id)) {
      const a = byId.get(r.sourceId);
      if (isActor(a) && a.kind === "actor" && !internal.includes(a) && cells.some((c) => c.businessId === b.business.id && c.assignees[0] === a)) internal.push(a);
    }
  }
  for (const c of cells) {
    const a = c.assignees[0] ?? null;
    if (!internal.includes(a)) internal.push(a);
  }
  internal.sort((x, y) => Number(x === null) - Number(y === null));
  for (const actor of internal) rows.push({ actor, external: false, cells: cells.filter((c) => (c.assignees[0] ?? null) === actor), events: [] });

  // システム・帳票: 作業が使う操作の対象 (操作 → システム・帳票、または操作が使う画面のシステム)
  const systems = new Map<string, FlowSystemCell>();
  for (const c of cells) {
    const targets = new Set<string>();
    for (const ur of model.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === c.activity.id)) {
      for (const r of model.relations) {
        if (r.sourceId !== ur.targetId) continue;
        if (r.kind === "usecaseSystem") targets.add(r.targetId);
        else if (r.kind === "usecaseScreen") {
          const screen = byId.get(r.targetId);
          if (screen?.kind === "screen") targets.add(screen.systemId);
        }
      }
    }
    for (const id of targets) {
      const t = byId.get(id);
      if (!t || (t.kind !== "system" && t.kind !== "ledger")) continue;
      const key = `sys:${c.column}:${id}`;
      const cell = systems.get(key) ?? { key, element: { id: t.id, name: t.name, kind: t.kind }, column: c.column, activityIds: [] };
      cell.activityIds.push(c.activity.id);
      systems.set(key, cell);
      links.push({ id: `sys:${c.activity.id}:${key}`, kind: "system", sourceId: c.activity.id, targetId: key });
    }
  }

  const orphans = model.elements.filter((e): e is Activity => e.kind === "activity" && !shown.has(e.id));
  return { bands, columns: Math.max(offset, 1), rows, systems: [...systems.values()], links, orphans, hiddenEvents };
}

/** この作業の前の作業にできる作業 (同じ業務の、まだ前になっていない作業) */
export function previousCandidates(model: UntieModel, activityId: string): Activity[] {
  const flow = buildActivityFlow(model);
  const mine = flow.rows.flatMap((r) => r.cells).find((c) => c.activity.id === activityId);
  if (!mine) return [];
  const taken = new Set(model.relations.filter((r) => r.kind === "activityTrigger" && r.targetId === activityId).map((r) => r.sourceId));
  return flow.rows.flatMap((r) => r.cells).filter((c) => c.businessId === mine.businessId && c.activity.id !== activityId && !taken.has(c.activity.id)).map((c) => c.activity);
}
