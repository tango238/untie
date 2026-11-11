// 設計モードのデータボード (5.7) の計算。モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import type { CommandResult } from "./commands";
import { setDatabaseDesign } from "./commands";
import { effectiveDatabaseIds } from "./design";
import { placeInformations } from "./placement";
import { isPrismaIdent, PRISMA_SCALAR_TYPES } from "./prisma";
import { parsePrismaDslCached } from "./prismaCache";
import type { Aggregate, BoundedContext, Database, Element, UntieModel } from "./types";

const nameOf = (e: Element | undefined): string => e?.name || "(名前なし)";

/**
 * システムが使う情報の id (名前順)。対象がそのシステム (直接か、そのシステムの画面を使う) の操作が扱う情報 (placement.ts の placeInformations)。
 * 取得元・保存先・画面が扱う情報は保存せず操作から導くので、この 1 つの導出にそろう
 */
export function systemInformationIds(model: UntieModel, systemId: string): string[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const ids = (placeInformations(model).get(systemId) ?? []).map((d) => d.id);
  return ids
    .filter((id) => byId.get(id)?.kind === "information")
    .sort((a, b) => nameOf(byId.get(a)).localeCompare(nameOf(byId.get(b)), "ja") || a.localeCompare(b));
}

/**
 * システムが使う情報のうち、使うデータベースのどのテーブルにも対応していないものの id (検証の informationUnmapped と関連ボードの「未対応」の判定)。
 * 設計が無いときと、使うデータベースが無いときは空 (後者は noDatabase が知らせる)。infoIds を渡すと systemInformationIds を走らせ直さない
 */
export function unmappedInformationIds(model: UntieModel, systemId: string, infoIds?: readonly string[]): string[] {
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) return [];
  const databases = effectiveDatabaseIds(model, design)
    .map((id) => model.databases.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => !!d);
  if (databases.length === 0) return [];
  const mapped = new Set(databases.flatMap((d) => d.tables.flatMap((t) => t.informationIds)));
  return (infoIds ?? systemInformationIds(model, systemId)).filter((id) => !mapped.has(id));
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

/** 情報が入っている集約 (ドメインモデル。4.6)。対象のシステムが実装するコンテキストのものを優先する */
export interface InformationAggregate {
  aggregate: Aggregate;
  context: BoundedContext | undefined;
  role: "root" | "member";
}

export function aggregateOfInformation(model: UntieModel, systemId: string, informationId: string): InformationAggregate | null {
  const owners = model.domain.aggregates.filter((a) => a.rootInformationId === informationId || a.memberInformationIds.includes(informationId));
  if (owners.length === 0) return null;
  const contextOf = (a: Aggregate) => model.domain.contexts.find((c) => c.id === a.boundedContextId);
  const aggregate = owners.find((a) => contextOf(a)?.systemIds.includes(systemId)) ?? owners[0]!;
  return { aggregate, context: contextOf(aggregate), role: aggregate.rootInformationId === informationId ? "root" : "member" };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** DSL のコメントに入れる文字列 (改行があるとコメントが切れて解析エラーになる) */
const inComment = (text: string) => text.replace(/[\r\n]+/g, " ");
/** Prisma が model の名前に使わせない名前 (型の名前など)。集約の英語名がこれなら、連番の名前にする */
const RESERVED_MODEL_NAMES: ReadonlySet<string> = new Set([...PRISMA_SCALAR_TYPES, "Unsupported", "Boolean", "PrismaClient"].map((n) => n.toLowerCase()));

/**
 * 対象システムが使う情報のうち、このデータベースのどのテーブルにも対応していないものについて、
 * model の雛形を DSL の末尾に足し、対応 (tables[]) も足す。情報の名前は @@map にそのまま入れる。
 * model の名前は後で直す前提で Table1, Table2 … (既存と重ならない連番)。足すものが無ければ何も変えない。
 * 集約 (ドメインモデル) が決まっている情報は、集約の境界に合わせる: ルートは集約の英語名を model の名前にし (空いていれば)、
 * 中の情報はルートの直後に置いて、ルートの id を持つ列を付ける。ほかの集約との関連は ID で参照するものとして、コメントに書く
 */
export function addScaffold(model: UntieModel, systemId: string, databaseId: string): CommandResult<{ added: number }> {
  const db = model.databases.find((d) => d.id === databaseId);
  if (!db) return { ok: false, reason: `データベースが存在しません: ${databaseId}` };
  const mapped = new Set(db.tables.flatMap((t) => t.informationIds));
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const unmapped = systemInformationIds(model, systemId).filter((id) => !mapped.has(id));
  if (unmapped.length === 0) return { ok: true, model, added: 0 };
  const owner = new Map(unmapped.map((id) => [id, aggregateOfInformation(model, systemId, id)]));
  // 並び: 集約のルートの直後に、その中の情報。集約に入っていない情報は、もとの並びのまま
  const infoIds: string[] = [];
  const take = (id: string) => {
    if (!infoIds.includes(id)) infoIds.push(id);
  };
  for (const id of unmapped) {
    const o = owner.get(id);
    if (!o) {
      take(id);
      continue;
    }
    for (const x of [o.aggregate.rootInformationId, ...o.aggregate.memberInformationIds]) if (unmapped.includes(x) && owner.get(x)?.aggregate.id === o.aggregate.id) take(x);
  }
  // 名前: 集約のルートは英語名 (空いていれば)。ほかは Table1, Table2 …
  const schema = parsePrismaDslCached(db.dsl);
  const used = new Set<string>([...schema.models.map((m) => m.name), ...schema.enums.map((e) => e.name), ...db.tables.map((t) => t.table)]);
  const names = new Map<string, string>();
  for (const id of infoIds) {
    const o = owner.get(id);
    const english = o?.role === "root" ? o.aggregate.english : undefined;
    if (english && isPrismaIdent(english) && !used.has(english) && !RESERVED_MODEL_NAMES.has(english.toLowerCase())) {
      names.set(id, english);
      used.add(english);
    }
  }
  const rest = scaffoldNames({ ...db, tables: [...db.tables, ...[...names.values()].map((table) => ({ table, informationIds: [] }))] }, infoIds.length - names.size);
  for (const id of infoIds) if (!names.has(id)) names.set(id, rest.shift()!);
  /** その集約のルートの model の名前 (この雛形で足すものか、すでに対応しているテーブル) */
  const rootModel = (a: Aggregate): string | undefined => names.get(a.rootInformationId) ?? tablesOfInformation(db, a.rootInformationId)[0];
  const blocks = infoIds.map((id) => {
    const o = owner.get(id);
    const name = names.get(id)!;
    const lines: string[] = [];
    const columns: string[] = ["  id String @id"];
    if (o) {
      const label = inComment(`${o.aggregate.english ?? o.aggregate.name}${o.context ? ` (${o.context.name})` : ""}`);
      if (o.role === "root") {
        lines.push(`// 集約 ${label} のルート`);
        // ほかの集約との関連は、@relation を張らずに ID で参照する
        const inside = new Set([o.aggregate.rootInformationId, ...o.aggregate.memberInformationIds]);
        const others = new Set<string>();
        for (const r of model.relations) {
          if (r.kind !== "informationRelated" || inside.has(r.sourceId) === inside.has(r.targetId)) continue;
          const other = model.domain.aggregates.find((a) => a.id !== o.aggregate.id && (a.rootInformationId === (inside.has(r.sourceId) ? r.targetId : r.sourceId) || a.memberInformationIds.includes(inside.has(r.sourceId) ? r.targetId : r.sourceId)));
          if (other) others.add(other.english ?? other.name);
        }
        if (others.size > 0) lines.push(`// ほかの集約 (${inComment([...others].join("・"))}) は、ID の列で参照する (@relation を張らない)`);
      } else {
        lines.push(`// 集約 ${label} の中の情報 (ルートと同じトランザクションで整合させる)`);
        const root = rootModel(o.aggregate);
        if (root) columns.push(`  ${lowerFirst(root)}Id String // ルート (${root}) の id`);
      }
    }
    if (name.startsWith("Table")) lines.push("// TODO: 名前を直す");
    return `${lines.join("\n")}\nmodel ${name} {\n${columns.join("\n")}\n  @@map(${quote(nameOf(byId.get(id)))})\n}\n`;
  });
  const dsl = `${db.dsl}${db.dsl === "" || db.dsl.endsWith("\n\n") ? "" : db.dsl.endsWith("\n") ? "\n" : "\n\n"}${blocks.join("\n")}`;
  const tables = [...db.tables.map((t) => ({ table: t.table, informationIds: [...t.informationIds] })), ...infoIds.map((id) => ({ table: names.get(id)!, informationIds: [id] }))];
  const r = setDatabaseDesign(model, { id: databaseId, dsl, tables });
  if (!r.ok) return r;
  return { ok: true, model: r.model, added: infoIds.length };
}
