import * as Y from "yjs";
import type { UntieModel } from "@untie/core";
import { initialOrders } from "./order";
import { getRoots } from "./roots";
import { boardToYMap, elementToYMap, relationToRecord } from "./write";

/**
 * JSON から読んだモデルを空の Y.Doc に 1 トランザクションで入れる。
 * elements と boards は配列の順に順序キー order を振る (関係・ノード・線も同じ)。
 * `$schema` は入れない (保存形式の注釈で、同時編集の対象ではない)。
 */
export function loadModel(doc: Y.Doc, model: UntieModel, origin?: unknown): void {
  const roots = getRoots(doc);
  doc.transact(() => {
    roots.meta.set("name", model.meta.name);
    if (model.meta.description !== undefined) roots.meta.set("description", model.meta.description);

    const elementOrders = initialOrders(model.elements.length);
    model.elements.forEach((e, i) => roots.elements.set(e.id, elementToYMap(e, elementOrders[i])));

    const relationOrders = initialOrders(model.relations.length);
    model.relations.forEach((r, i) => roots.relations.set(r.id, relationToRecord(r, relationOrders[i])));

    const boardOrders = initialOrders(model.boards.length);
    model.boards.forEach((b, i) => {
      roots.boards.set(b.id, boardToYMap(b, boardOrders[i], initialOrders(b.nodes.length), initialOrders((b.edges ?? []).length)));
    });
  }, origin);
}
