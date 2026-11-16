// 業務フローボード (分析（簡易）と分析（詳細）で共通) の組み立て。横軸は業務ごとの枠の中で作業を順に、縦軸は担当の登場人物。
// 作業の順序は作業 → 作業の起点 (activityTrigger: 始点が前の作業、終点が後の作業) をそのまま使う。モデルには保存せず、毎回組み立てる。
import { defaultBucOf } from "./selectors";
import type { Activity, Actor, Business, Buc, EventElement, ExternalActor, UntieModel } from "./types";

/** 業務フローボードの id の末尾 (簡易: simple:flow、詳細の分析ボード: analysis:flow) */
export const FLOW_BOARD_LABEL = "業務フロー";

export interface FlowCell {
  activity: Activity;
  /** 左から数えた列 (0 始まり)。順序が決まっていない作業は、順序のある作業の右に 1 列ずつ並べる */
  column: number;
  /** 前後のどちらにも順序が決まっていない作業 */
  unordered: boolean;
  /** 担当 (複数のときは先頭の行に出す。全員の名前はカードに添える) */
  assignees: (Actor | ExternalActor)[];
  /** きっかけのイベント (eventActivity。作業の起点のうちイベント) */
  triggerEvents: EventElement[];
}

export interface FlowRow {
  /** 担当なしの行は null */
  actor: Actor | ExternalActor | null;
  cells: FlowCell[];
}

export interface FlowLink {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface FlowBusiness {
  business: Business;
  columns: number;
  rows: FlowRow[];
  links: FlowLink[];
}

export interface ActivityFlow {
  businesses: FlowBusiness[];
  /** どの業務にも属さない作業 (順序は決められない) */
  orphans: Activity[];
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

/** 同じ業務の中の作業の列を決める。順序の最長の長さ (閉じた順序は、戻る線を無視する) */
function columnsOf(acts: Activity[], links: FlowLink[]): Map<string, number> {
  const ids = new Set(acts.map((a) => a.id));
  const next = new Map<string, string[]>(acts.map((a) => [a.id, []]));
  for (const l of links) if (ids.has(l.sourceId) && ids.has(l.targetId)) next.get(l.sourceId)!.push(l.targetId);
  // 戻る線 (輪になる線) を見つけて外す
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
  const actors = model.elements.filter((e): e is Actor | ExternalActor => e.kind === "actor" || e.kind === "externalActor");
  const actorById = new Map(actors.map((a) => [a.id, a]));
  const triggers = model.relations.filter((r) => r.kind === "activityTrigger");
  const shown = new Set<string>();

  const businesses = model.elements
    .filter((e): e is Business => e.kind === "business")
    .map((business): FlowBusiness => {
      const acts = activitiesOf(model, business);
      for (const a of acts) shown.add(a.id);
      const ids = new Set(acts.map((a) => a.id));
      const links = triggers.filter((r) => ids.has(r.sourceId) && ids.has(r.targetId)).map((r) => ({ id: r.id, sourceId: r.sourceId, targetId: r.targetId }));
      const col = columnsOf(acts, links);
      const linked = new Set(links.flatMap((l) => [l.sourceId, l.targetId]));
      let columns = Math.max(0, ...[...col.entries()].filter(([id]) => linked.has(id)).map(([, c]) => c + 1));
      const cells: FlowCell[] = acts.map((activity) => {
        const unordered = !linked.has(activity.id);
        const column = unordered ? columns++ : col.get(activity.id)!;
        const assignees = model.relations
          .filter((r) => r.kind === "actorActivity" && r.targetId === activity.id)
          .map((r) => actorById.get(r.sourceId))
          .filter((a): a is Actor | ExternalActor => !!a);
        const triggerEvents = model.relations
          .filter((r) => r.kind === "eventActivity" && r.targetId === activity.id)
          .map((r) => model.elements.find((e) => e.id === r.sourceId))
          .filter((e): e is EventElement => e?.kind === "event");
        return { activity, column, unordered, assignees, triggerEvents };
      });
      // 行: 業務の主担当を先に、次に担当の登場人物を出てきた順に、担当なしを最後に
      const owners = model.relations.filter((r) => r.kind === "actorBusiness" && r.targetId === business.id).map((r) => actorById.get(r.sourceId)).filter((a): a is Actor | ExternalActor => !!a);
      const firstActor = (c: FlowCell) => c.assignees[0] ?? null;
      const rowActors: (Actor | ExternalActor | null)[] = [];
      for (const a of [...owners, ...cells.map(firstActor)]) if (!rowActors.includes(a) && (a !== null || cells.some((c) => firstActor(c) === null))) rowActors.push(a);
      const rows = rowActors.sort((x, y) => Number(x === null) - Number(y === null)).map((actor) => ({ actor, cells: cells.filter((c) => firstActor(c) === actor) }));
      return { business, columns: Math.max(columns, 1), rows, links };
    });
  const orphans = model.elements.filter((e): e is Activity => e.kind === "activity" && !shown.has(e.id));
  return { businesses, orphans };
}

/** この作業の前の作業にできる作業 (同じ業務の、まだ前になっていない作業) */
export function previousCandidates(model: UntieModel, activityId: string): Activity[] {
  const flow = buildActivityFlow(model);
  const box = flow.businesses.find((b) => b.rows.some((r) => r.cells.some((c) => c.activity.id === activityId)));
  if (!box) return [];
  const taken = new Set(model.relations.filter((r) => r.kind === "activityTrigger" && r.targetId === activityId).map((r) => r.sourceId));
  return box.rows.flatMap((r) => r.cells.map((c) => c.activity)).filter((a) => a.id !== activityId && !taken.has(a.id));
}
