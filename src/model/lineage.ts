// トレース: 要素から上 (担い手の側) と下 (詳細の側) へ、直接つながっていない要素まで辿ってレイヤーごとに並べる。
// 純粋関数だけを置く。
import { FIXED_LAYERS, fixedLayerOf, type FixedLayer } from "./fixedBoards";
import { isContextMemberKind, type Element, type UntieModel } from "./types";

/**
 * 要素 → 1 つ上の要素。
 * - 業務 → 主担当のアクター
 * - 活動 → 業務
 * - 作業 → 活動 (業務に直接なら業務)、担当 (アクター・外部アクター・システム)
 * - 操作 → 使う作業
 * - 情報 → 扱う操作、コンテキスト、取得元・保存先 (システム・帳票)
 * - 条件 → 判断に使う操作、コンテキスト
 * - 状態 → 結んだ操作・状態を参照する条件、コンテキスト
 * - バリエーション → 種別にしている情報・条件、コンテキスト
 * 情報どうしの関連は同じレイヤーなので辿らない。
 */
function upEdges(model: UntieModel): Map<string, string[]> {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const up = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const list = up.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    up.set(from, list);
  };
  for (const e of model.elements) {
    if (e.kind === "buc" && !e.isDefault) add(e.id, e.businessId);
    if (e.kind === "activity" && e.bucId) {
      const buc = byId.get(e.bucId);
      // 既定 BUC は画面に出ないので、業務へ直接つなぐ
      if (buc && buc.kind === "buc") add(e.id, buc.isDefault ? buc.businessId : buc.id);
    }
    if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId) add(e.id, e.contextId);
  }
  for (const r of model.relations) {
    switch (r.kind) {
      case "actorBusiness":
      case "actorActivity":
      case "activityUsecase":
      case "usecaseInformation":
      case "usecaseCondition":
      case "informationVariation":
      case "conditionVariation":
      case "conditionState":
      case "usecaseState":
      case "systemInformation":
        add(r.targetId, r.sourceId);
        break;
      case "stateUsecase":
      case "informationSystem":
        // 始点が下位 (状態 → 操作、情報 → 保存先) なので向きを逆にする
        add(r.sourceId, r.targetId);
        break;
      case "informationRelated":
        break;
    }
  }
  return up;
}

export interface LineageRow {
  layer: FixedLayer;
  elements: Element[];
}

export interface Lineage {
  /** 上のレイヤー (登場人物の側から順に) */
  up: LineageRow[];
  /** 下のレイヤー (近い順) */
  down: LineageRow[];
}

function walk(start: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of edges.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  seen.delete(start);
  return seen;
}

function groupByLayer(model: UntieModel, ids: Set<string>, exclude: FixedLayer | null): LineageRow[] {
  const rows = new Map<FixedLayer, Element[]>();
  for (const e of model.elements) {
    if (!ids.has(e.id)) continue;
    const layer = fixedLayerOf(e.kind);
    if (!layer || layer === exclude) continue;
    rows.set(layer, [...(rows.get(layer) ?? []), e]);
  }
  return FIXED_LAYERS.filter((l) => rows.has(l)).map((layer) => ({ layer, elements: rows.get(layer)! }));
}

/** 要素から上と下へ辿った要素を、レイヤーごとにまとめる (自分と同じレイヤーは除く) */
export function lineage(model: UntieModel, elementId: string): Lineage {
  const el = model.elements.find((e) => e.id === elementId);
  if (!el) return { up: [], down: [] };
  const up = upEdges(model);
  const down = new Map<string, string[]>();
  for (const [from, tos] of up) for (const to of tos) down.set(to, [...(down.get(to) ?? []), from]);
  const own = fixedLayerOf(el.kind);
  return { up: groupByLayer(model, walk(el.id, up), own), down: groupByLayer(model, walk(el.id, down), own) };
}
