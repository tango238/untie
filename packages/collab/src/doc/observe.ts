import * as Y from "yjs";
import { getRoots, keyOwner } from "./roots";

/** 1 回のトランザクションで変わった id */
export interface ModelChanges {
  elements: Set<string>;
  relations: Set<string>;
  boards: Set<string>;
  /** 変わった設計の systemId */
  designs: Set<string>;
  /** 変わったデータベースの id */
  databases: Set<string>;
  /** ドメインモデル (domain) が変わったか */
  domain: boolean;
  /** meta (名前・説明) が変わったか */
  meta: boolean;
}

/**
 * Y.Doc の変更を、変わった id の集まりにして知らせる (observeDeep を包む)。
 * 1 回のトランザクションにつき 1 回呼ぶ。origin は doc.transact に渡したもの (リモートの update なら Y.applyUpdate の origin)。
 * 戻り値は購読の解除。ストア (packages/ui/src/cloud/collab.ts) が、他の人の変更があったことを知るために使う。
 */
export function observeModelChanges(doc: Y.Doc, onChange: (changed: ModelChanges, origin: unknown) => void): () => void {
  const roots = getRoots(doc);
  let pending: ModelChanges | null = null;
  const take = (): ModelChanges => (pending ??= { elements: new Set(), relations: new Set(), boards: new Set(), designs: new Set(), databases: new Set(), domain: false, meta: false });

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
  // 設計データは平らなキー (`${systemId}/meta` など) に置くので、変わったキーから systemId・データベースの id を取る。
  // 画面・遷移・ナビの値は systemId を持つ (消えた値は、キー自体を入れる)
  const owners = <V extends { systemId?: string }>(map: Y.Map<V>, target: Set<string>) => (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) for (const key of event.keys.keys()) target.add(map.get(key)?.systemId ?? key);
  };
  const prefixes = (target: Set<string>) => (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) for (const key of event.keys.keys()) target.add(keyOwner(key));
  };
  const onDesigns = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => prefixes(take().designs)(events);
  const onScreens = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => owners(roots.designScreens, take().designs)(events);
  const onTransitions = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => owners(roots.designTransitions, take().designs)(events);
  const onNav = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => owners(roots.designNav, take().designs)(events);
  const onDatabases = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => prefixes(take().databases)(events);
  const onDomain = () => {
    take().domain = true;
  };
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
  roots.designs.observeDeep(onDesigns);
  roots.designScreens.observeDeep(onScreens);
  roots.designTransitions.observeDeep(onTransitions);
  roots.designNav.observeDeep(onNav);
  roots.databases.observeDeep(onDatabases);
  roots.domain.observeDeep(onDomain);
  doc.on("afterTransaction", onAfter);
  return () => {
    roots.meta.unobserveDeep(onMeta);
    roots.elements.unobserveDeep(onElements);
    roots.relations.unobserveDeep(onRelations);
    roots.boards.unobserveDeep(onBoards);
    roots.designs.unobserveDeep(onDesigns);
    roots.designScreens.unobserveDeep(onScreens);
    roots.designTransitions.unobserveDeep(onTransitions);
    roots.designNav.unobserveDeep(onNav);
    roots.databases.unobserveDeep(onDatabases);
    roots.domain.unobserveDeep(onDomain);
    doc.off("afterTransaction", onAfter);
  };
}
