// 設計モードの関連ボード (5.7) の計算。分析の情報 ↔ テーブル、テーブルの項目 ↔ 設計の画面の関連を、モデルから毎回組み立てる。純粋関数だけを置く。
import { effectiveDatabaseIds } from "./design";
import { systemInformationIds, unmappedInformationIds } from "./designData";
import { unboundSlots } from "./designView";
import { describePrismaField } from "./prisma";
import { parsePrismaDslCached } from "./prismaCache";
import { designScreenName } from "./sitemap";
import type { SystemDesign, UntieModel } from "./types";

/** 関連ボードで選んでいるもの (UI の状態。保存しない) */
export type DesignRelationSelection =
  | { kind: "information"; id: string }
  | { kind: "table"; databaseId: string; table: string }
  | { kind: "screen"; id: string };

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** 対象のシステムの設計が使うデータベース (設計が無ければ空) */
function usedDatabases(model: UntieModel, design: SystemDesign | undefined) {
  if (!design) return [];
  return effectiveDatabaseIds(model, design)
    .map((id) => model.databases.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => !!d);
}

/** 図に出す情報の id: システムが使う情報と、使うデータベースのテーブルに対応づけられた情報の和 (分析の情報だけ。無くなった情報は含まない) */
export function relationInformationIds(model: UntieModel, systemId: string): Set<string> {
  const ids = new Set(systemInformationIds(model, systemId));
  for (const db of usedDatabases(model, model.designs.find((d) => d.systemId === systemId))) for (const t of db.tables) for (const id of t.informationIds) ids.add(id);
  const infos = new Set(model.elements.filter((e) => e.kind === "information").map((e) => e.id));
  for (const id of ids) if (!infos.has(id)) ids.delete(id);
  return ids;
}

export interface RelationInformation {
  id: string;
  name: string;
  description?: string;
  /** 使うデータベースのどのテーブルにも対応していない (informationUnmapped と同じ判定) */
  unmapped: boolean;
}

export interface RelationColumn {
  name: string;
  /** 型の表記 (describePrismaField) */
  type: string;
  /** この列を使う画面の id (設計の画面の並び順) */
  usedBy: string[];
}

export interface RelationTable {
  name: string;
  /** 対応する情報の id (関連の図に出る情報だけ) */
  informationIds: string[];
  columns: RelationColumn[];
}

export interface RelationDatabase {
  id: string;
  name: string;
  tables: RelationTable[];
  /** database.tables にあるのに DSL に無いテーブル (名前と、対応する情報の id) */
  missingTables: { name: string; informationIds: string[] }[];
}

export interface RelationScreen {
  id: string;
  name: string;
  hasView: boolean;
  /** 列の対応が無い項目の数 (bindingUnmapped と同じ判定) */
  unbound: number;
}

export type RelationEdge =
  | { kind: "informationTable"; informationId: string; databaseId: string; table: string }
  | { kind: "columnScreen"; databaseId: string; table: string; column: string; screenId: string };

export interface RelationGraph {
  /** 設計 (ensureDesign) がまだ無い */
  noDesign: boolean;
  informations: RelationInformation[];
  databases: RelationDatabase[];
  screens: RelationScreen[];
  edges: RelationEdge[];
}

/**
 * 関連ボードの材料。情報 = システムが使う情報と、使うデータベースのテーブルに対応づけられた情報の和 (分析の情報の並び順。無くなった情報は捨てる)。
 * テーブル = 使うデータベースの DSL の全 model。画面 = 設計の画面すべて。
 * 線は、情報 → テーブル (database.tables[].informationIds) と、列 → 画面 (画面の bindings。同じ画面が同じ列を複数の項目で使っても 1 本。存在しない列は線にしない)
 */
export function buildRelationGraph(model: UntieModel, systemId: string): RelationGraph {
  const design = model.designs.find((d) => d.systemId === systemId);
  const dbs = usedDatabases(model, design);
  const infoIds = relationInformationIds(model, systemId);
  const unmapped = new Set(unmappedInformationIds(model, systemId, [...infoIds]));
  const informations: RelationInformation[] = model.elements
    .filter((e) => e.kind === "information" && infoIds.has(e.id))
    .map((e) => ({ id: e.id, name: nameOf(e), ...(e.description ? { description: e.description } : {}), unmapped: unmapped.has(e.id) }));
  const known = new Set(informations.map((i) => i.id));

  const edges: RelationEdge[] = [];
  const databases: RelationDatabase[] = dbs.map((db) => {
    const schema = parsePrismaDslCached(db.dsl);
    const tables: RelationTable[] = schema.models.map((m) => {
      const informationIds = (db.tables.find((t) => t.table === m.name)?.informationIds ?? []).filter((id) => known.has(id));
      for (const informationId of informationIds) edges.push({ kind: "informationTable", informationId, databaseId: db.id, table: m.name });
      return { name: m.name, informationIds, columns: m.fields.map((f) => ({ name: f.name, type: describePrismaField(f), usedBy: [] })) };
    });
    const names = new Set(schema.models.map((m) => m.name));
    return { id: db.id, name: nameOf(db), tables, missingTables: db.tables.filter((t) => !names.has(t.table)).map((t) => ({ name: t.table, informationIds: t.informationIds.filter((id) => known.has(id)) })) };
  });

  const columnOf = new Map<string, RelationColumn>();
  for (const d of databases) for (const t of d.tables) for (const c of t.columns) columnOf.set(`${d.id}\0${t.name}\0${c.name}`, c);
  const screens: RelationScreen[] = [];
  for (const s of design?.screens ?? []) {
    screens.push({ id: s.id, name: designScreenName(model, s), hasView: s.view !== undefined, unbound: unboundSlots(s).length });
    for (const b of s.bindings ?? []) {
      const column = columnOf.get(`${b.databaseId}\0${b.table}\0${b.column}`);
      if (!column || column.usedBy.includes(s.id)) continue;
      column.usedBy.push(s.id);
      edges.push({ kind: "columnScreen", databaseId: b.databaseId, table: b.table, column: b.column, screenId: s.id });
    }
  }
  return { noDesign: !design, informations, databases, screens, edges };
}
