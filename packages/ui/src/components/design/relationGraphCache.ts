import { buildRelationGraph, type RelationGraph } from "@untie/core/model/designRelation";
import type { UntieModel } from "@untie/core/model/types";

let last: { model: UntieModel; systemId: string; graph: RelationGraph } | undefined;

/** 関連ボードの材料。図・左右のペインが同じ結果を使う (モデルと対象のシステムが同じなら使い回す) */
export function cachedRelationGraph(model: UntieModel, systemId: string | undefined): RelationGraph {
  const id = systemId ?? "";
  if (last && last.model === model && last.systemId === id) return last.graph;
  const graph = buildRelationGraph(model, id);
  last = { model, systemId: id, graph };
  return graph;
}
