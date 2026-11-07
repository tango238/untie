// 設計モードのデータボード (5.7) の計算。モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import type { CommandResult } from "./commands";
import { setDatabaseDesign } from "./commands";
import { effectiveDatabaseIds } from "./design";
import { parsePrismaDslCached } from "./prismaCache";
import type { Database, Element, UntieModel } from "./types";

const nameOf = (e: Element | undefined): string => e?.name || "(名前なし)";

/**
 * システムが使う情報の id (名前順)。次の和集合:
 * - システムに取得元 (system → information) か保存先 (information → system) として結んだ情報
 * - そのシステムの画面が扱う (screen → information) 情報
 */
export function systemInformationIds(model: UntieModel, systemId: string): string[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const screenIds = new Set(model.elements.filter((e) => e.kind === "screen" && e.systemId === systemId).map((e) => e.id));
  const ids = new Set<string>();
  for (const r of model.relations) {
    if (r.kind === "systemInformation" && r.sourceId === systemId) ids.add(r.targetId);
    else if (r.kind === "informationSystem" && r.targetId === systemId) ids.add(r.sourceId);
    else if (r.kind === "screenInformation" && screenIds.has(r.sourceId)) ids.add(r.targetId);
  }
  return [...ids]
    .filter((id) => byId.get(id)?.kind === "information")
    .sort((a, b) => nameOf(byId.get(a)).localeCompare(nameOf(byId.get(b)), "ja") || a.localeCompare(b));
}

/** データベースを使っている設計 (使っているシステムの id と、databaseIds で選んだのか既定の規則によるのか) */
export function designsUsingDatabase(model: UntieModel, databaseId: string): { systemId: string; explicit: boolean }[] {
  return model.designs
    .filter((d) => effectiveDatabaseIds(model, d).includes(databaseId))
    .map((d) => ({ systemId: d.systemId, explicit: d.databaseIds.includes(databaseId) }));
}

/** データベースを指す、画面の項目の対応 (bindings) の数 */
export function databaseBindingCount(model: UntieModel, databaseId: string): number {
  let n = 0;
  for (const d of model.designs) for (const s of d.screens) n += s.bindings?.filter((b) => b.databaseId === databaseId).length ?? 0;
  return n;
}

/** データベースの情報の対応 (tables[]) の数 */
export function databaseMappingCount(db: Pick<Database, "tables">): number {
  return db.tables.filter((t) => t.informationIds.length > 0).length;
}

/** テーブルに対応する情報の id (対応が無ければ空) */
export function tableInformationIds(db: Pick<Database, "tables">, table: string): string[] {
  return db.tables.find((t) => t.table === table)?.informationIds ?? [];
}

/** 情報に対応するテーブル名 (複数あってよい) */
export function tablesOfInformation(db: Pick<Database, "tables">, informationId: string): string[] {
  return db.tables.filter((t) => t.informationIds.includes(informationId)).map((t) => t.table);
}

/** 雛形の model の名前 (Table1, Table2 …)。DSL にも対応にもまだ無いもの */
function scaffoldNames(db: Database, count: number): string[] {
  const schema = parsePrismaDslCached(db.dsl);
  const used = new Set<string>([...schema.models.map((m) => m.name), ...schema.enums.map((e) => e.name), ...db.tables.map((t) => t.table)]);
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = `Table${n}`;
    if (!used.has(name)) names.push(name);
  }
  return names;
}

const quote = (text: string) => `"${text.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * 対象システムが使う情報のうち、このデータベースのどのテーブルにも対応していないものについて、
 * model の雛形を DSL の末尾に足し、対応 (tables[]) も足す。情報の名前は @@map にそのまま入れる。
 * model の名前は後で直す前提で Table1, Table2 … (既存と重ならない連番)。足すものが無ければ何も変えない
 */
export function addScaffold(model: UntieModel, systemId: string, databaseId: string): CommandResult<{ added: number }> {
  const db = model.databases.find((d) => d.id === databaseId);
  if (!db) return { ok: false, reason: `データベースが存在しません: ${databaseId}` };
  const mapped = new Set(db.tables.flatMap((t) => t.informationIds));
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const infoIds = systemInformationIds(model, systemId).filter((id) => !mapped.has(id));
  if (infoIds.length === 0) return { ok: true, model, added: 0 };
  const names = scaffoldNames(db, infoIds.length);
  const blocks = infoIds.map((id, i) => `// TODO: 名前を直す\nmodel ${names[i]} {\n  id String @id\n  @@map(${quote(nameOf(byId.get(id)))})\n}\n`);
  const dsl = `${db.dsl}${db.dsl === "" || db.dsl.endsWith("\n\n") ? "" : db.dsl.endsWith("\n") ? "\n" : "\n\n"}${blocks.join("\n")}`;
  const tables = [...db.tables.map((t) => ({ table: t.table, informationIds: [...t.informationIds] })), ...infoIds.map((id, i) => ({ table: names[i], informationIds: [id] }))];
  const r = setDatabaseDesign(model, { id: databaseId, dsl, tables });
  if (!r.ok) return r;
  return { ok: true, model: r.model, added: infoIds.length };
}
