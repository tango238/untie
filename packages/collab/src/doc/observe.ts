import * as Y from "yjs";
import { getRoots } from "./roots";

/** 1 回のトランザクションで変わった id */
export interface ModelChanges {
  elements: Set<string>;
  relations: Set<string>;
  boards: Set<string>;
  /** meta (名前・説明) が変わったか */
  meta: boolean;
}

/**
 * Y.Doc の変更を、変わった id の集まりにして知らせる (observeDeep を包む)。
 * 1 回のトランザクションにつき 1 回呼ぶ。origin は doc.transact に渡したもの (リモートの update なら Y.applyUpdate の origin)。
 * 戻り値は購読の解除。Phase 4 でストアが「変わった id だけ組み立て直す」ために使う。
 */
export function observeModelChanges(doc: Y.Doc, onChange: (changed: ModelChanges, origin: unknown) => void): () => void {
  const roots = getRoots(doc);
  let pending: ModelChanges | null = null;
  const take = (): ModelChanges => (pending ??= { elements: new Set(), relations: new Set(), boards: new Set(), meta: false });

  /** ルートの直下の項目 (path が空ならルートの Y.Map のキー、そうでなければ path の先頭が id) */
  const collect = (target: Set<string>) => (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) {
      const path = event.path;
      if (path.length === 0) for (const key of event.keys.keys()) target.add(key);
      else target.add(String(path[0]));
    }
  };

  const onElements = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => collect(take().elements)(events);
  const onRelations = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => collect(take().relations)(events);
  const onBoards = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => collect(take().boards)(events);
  const onMeta = () => {
    take().meta = true;
  };
  // 深い observer はすべてトランザクションの afterTransaction より前に呼ばれるので、そこでまとめて 1 回渡す
  const onAfter = (tx: Y.Transaction) => {
    const changed = pending;
    pending = null;
    if (changed) onChange(changed, tx.origin);
  };

  roots.meta.observeDeep(onMeta);
  roots.elements.observeDeep(onElements);
  roots.relations.observeDeep(onRelations);
  roots.boards.observeDeep(onBoards);
  doc.on("afterTransaction", onAfter);
  return () => {
    roots.meta.unobserveDeep(onMeta);
    roots.elements.unobserveDeep(onElements);
    roots.relations.unobserveDeep(onRelations);
    roots.boards.unobserveDeep(onBoards);
    doc.off("afterTransaction", onAfter);
  };
}
