// データベースの DSL (Prisma のスキーマ言語の一部) を、データボードの図の操作から書き換える。純粋関数だけを置く (設計書 5.7)。
// 保存する値は DSL の文字列だけなので、図の操作も DSL の文字列を書き換える。触った行のほかは、書式とコメントをそのまま残す。
// 解析エラーのある DSL は、どこを直すか決められないので書き換えない (テキストで直してもらう)。
import { findClose, firstString, HEADER, isPrismaIdent, parsePrismaDsl, PRISMA_SCALAR_TYPES, stripComment, type PrismaField, type PrismaModel, type PrismaSchema } from "./prisma";

/** 図の操作 1 つ。名前はすべて model・フィールドの名前 */
export type PrismaEdit =
  | { type: "addModel"; name: string }
  | { type: "renameModel"; from: string; to: string }
  | { type: "removeModel"; name: string }
  | { type: "addField"; model: string; field: NewPrismaField }
  | { type: "updateField"; model: string; field: string; patch: PrismaFieldPatch }
  | { type: "removeField"; model: string; field: string }
  /** from の列 fields が、to の列 references を参照する関連 (外部キー) を足す */
  | { type: "addRelation"; from: string; fields: string[]; to: string; references: string[] }
  /** model の関連のフィールド field と、相手側の対のフィールドを消す (外部キーの列は残す) */
  | { type: "removeRelation"; model: string; field: string };

export interface NewPrismaField {
  name: string;
  type: string;
  isOptional?: boolean;
  isList?: boolean;
}

export interface PrismaFieldPatch {
  name?: string;
  type?: string;
  isOptional?: boolean;
  isList?: boolean;
  isId?: boolean;
  isUnique?: boolean;
}

export type PrismaEditResult = { ok: true; dsl: string } | { ok: false; reason: string };

const fail = (reason: string): PrismaEditResult => ({ ok: false, reason });

// ---------------------------------------------------------------- 書き出し

/** フィールド 1 行 (字下げなし)。属性は読んだときの並びと中身のまま */
export function printPrismaField(f: Pick<PrismaField, "name" | "type" | "isList" | "isOptional" | "attributes">): string {
  const type = `${f.type}${f.isList ? "[]" : ""}${f.isOptional ? "?" : ""}`;
  const attrs = f.attributes.map((a) => `@${a.name}${a.args !== "" ? `(${a.args})` : ""}`);
  return [f.name, type, ...attrs].join(" ");
}

/** model のブロック全体 (行の配列) */
export function printPrismaModel(m: PrismaModel, indent = "  "): string[] {
  return [
    `model ${m.name} {`,
    ...m.fields.map((f) => indent + printPrismaField(f)),
    ...m.blockAttributes.map((a) => `${indent}@@${a.name}${a.args !== "" ? `(${a.args})` : ""}`),
    "}",
  ];
}

// ---------------------------------------------------------------- 位置

interface BlockLoc {
  kind: string;
  name: string;
  /** 見出しの行 (0 から) */
  start: number;
  /** } の行 */
  end: number;
  /** 見出しの行か } の行に中身がある (1 行で書いた model など)。書き換える前に展開する */
  inline: boolean;
  /** フィールドの名前 → 行 */
  fields: Map<string, number>;
  /** 最初の @@ の行 (無ければ undefined) */
  firstBlockAttr?: number;
}

/** 解析エラーの無い DSL の、ブロックとフィールドの行の位置 */
function locate(lines: readonly string[]): BlockLoc[] {
  const blocks: BlockLoc[] = [];
  let i = 0;
  while (i < lines.length) {
    const code = stripComment(lines[i]!);
    const header = HEADER.exec(code);
    if (!header) {
      i++;
      continue;
    }
    const rest = header[4]!;
    const loc: BlockLoc = { kind: header[2]!, name: header[3]!, start: i, end: i, inline: false, fields: new Map() };
    const closeAt = findClose(rest);
    if (closeAt >= 0) {
      loc.inline = true;
      blocks.push(loc);
      i++;
      continue;
    }
    if (rest.trim() !== "") loc.inline = true;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = stripComment(lines[j]!);
      const at = findClose(c);
      if (at >= 0) {
        if (c.slice(0, at).trim() !== "") loc.inline = true;
        break;
      }
      const t = c.trim();
      if (t === "") continue;
      if (t.startsWith("@@")) {
        loc.firstBlockAttr ??= j;
        continue;
      }
      const m = /^([A-Za-z_]\w*)\s/.exec(t);
      if (m) loc.fields.set(m[1]!, j);
    }
    loc.end = Math.min(j, lines.length - 1);
    blocks.push(loc);
    i = j + 1;
  }
  return blocks;
}

/** 書き換えの途中の DSL。行の配列を直し、必要なら読み直す */
class Doc {
  lines: string[];
  readonly eol: string;
  schema!: PrismaSchema;
  blocks!: BlockLoc[];

  constructor(dsl: string) {
    this.eol = dsl.includes("\r\n") ? "\r\n" : "\n";
    this.lines = dsl === "" ? [] : dsl.split(/\r\n|\r|\n/);
    this.refresh();
  }

  refresh() {
    this.schema = parsePrismaDsl(this.lines.join("\n"));
    this.blocks = locate(this.lines);
  }

  text(): string {
    return this.lines.join(this.eol);
  }

  model(name: string): PrismaModel | undefined {
    return this.schema.models.find((m) => m.name === name);
  }

  block(name: string): BlockLoc | undefined {
    return this.blocks.find((b) => b.kind === "model" && b.name === name);
  }

  /** 1 行で書いた model を、1 行 1 フィールドに展開する (そのブロックの中のコメントは消える) */
  expand(name: string) {
    const b = this.block(name);
    const m = this.model(name);
    if (!b || !m || !b.inline) return;
    const lead = /^\s*/.exec(this.lines[b.start]!)![0];
    this.lines.splice(b.start, b.end - b.start + 1, ...printPrismaModel(m).map((l) => lead + l));
    this.refresh();
  }

  /** フィールドの行を、字下げと行末のコメントを残して書き換える */
  rewriteField(model: string, field: string, next: PrismaField) {
    this.expand(model);
    const at = this.block(model)?.fields.get(field);
    if (at === undefined) return;
    const raw = this.lines[at]!;
    const indent = /^\s*/.exec(raw)![0];
    const code = stripComment(raw);
    const comment = raw.slice(code.length).trim();
    this.lines[at] = `${indent}${printPrismaField(next)}${comment ? ` ${comment}` : ""}`;
  }

  /** model の末尾 (最初の @@ の前、無ければ } の前) にフィールドの行を足す */
  insertField(model: string, line: string) {
    this.expand(model);
    const b = this.block(model);
    if (!b) return;
    const firstField = [...b.fields.values()].sort((a, c) => a - c)[0];
    const indent = firstField !== undefined ? /^\s*/.exec(this.lines[firstField]!)![0] : `${/^\s*/.exec(this.lines[b.start]!)![0]}  `;
    let at = b.firstBlockAttr ?? b.end;
    // @@ の直前が空行なら、その空行の前に足す
    while (b.firstBlockAttr !== undefined && at - 1 > b.start && this.lines[at - 1]!.trim() === "") at--;
    this.lines.splice(at, 0, indent + line);
    this.refresh();
  }

  /** 行をまとめて消す */
  removeLines(indices: Iterable<number>) {
    const drop = new Set(indices);
    this.lines = this.lines.filter((_, i) => !drop.has(i));
    this.refresh();
  }
}

// ---------------------------------------------------------------- 名前と型

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function knownTypes(schema: PrismaSchema): Set<string> {
  return new Set<string>([...PRISMA_SCALAR_TYPES, ...schema.models.map((m) => m.name), ...schema.enums.map((e) => e.name)]);
}

function checkNewModelName(schema: PrismaSchema, name: string): string | null {
  if (!isPrismaIdent(name)) return `テーブルの名前は英数字とアンダースコアで書いてください (先頭は英字か _): ${name}`;
  if ((PRISMA_SCALAR_TYPES as readonly string[]).includes(name)) return `型の名前と同じ名前は使えません: ${name}`;
  if (schema.models.some((m) => m.name === name) || schema.enums.some((e) => e.name === name)) return `同じ名前のテーブルか enum があります: ${name}`;
  return null;
}

function checkNewFieldName(model: PrismaModel, name: string): string | null {
  if (!isPrismaIdent(name)) return `列の名前は英数字とアンダースコアで書いてください (先頭は英字か _): ${name}`;
  if (model.fields.some((f) => f.name === name)) return `${model.name} に同じ名前の列があります: ${name}`;
  return null;
}

/** model の中で使っていない名前 (base, base2, base3 …) */
function freeFieldName(model: PrismaModel, base: string): string {
  const used = new Set(model.fields.map((f) => f.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/** model・enum で使っていない名前 (Table1, Table2 …) */
export function freePrismaModelName(dsl: string, base = "Table"): string {
  const schema = parsePrismaDsl(dsl);
  const used = new Set<string>([...schema.models.map((m) => m.name), ...schema.enums.map((e) => e.name)]);
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/** model の中で使っていない列の名前 (column1, column2 …) */
export function freePrismaFieldName(dsl: string, model: string, base = "column"): string {
  const m = parsePrismaDsl(dsl).models.find((x) => x.name === model);
  const used = new Set(m?.fields.map((f) => f.name) ?? []);
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/** 関連のフィールド (型が model) か */
const isRelationField = (schema: PrismaSchema, f: PrismaField) => schema.models.some((m) => m.name === f.type);

/** @relation の名前 (最初の文字列か name: "...") */
export function relationNameOf(f: PrismaField): string | undefined {
  const attr = f.attributes.find((a) => a.name === "relation");
  if (!attr) return undefined;
  const named = /(?:^|[,\s])name\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(attr.args);
  if (named) return named[1];
  return attr.args.trimStart().startsWith('"') ? firstString(attr.args) : undefined;
}

/**
 * 関連の対になるフィールド。field (model の関連のフィールド) に対して、相手の model にある、
 * 型が model で、関連の名前が同じものを探す (自分の model への関連なら自分は除く)
 */
export function oppositeRelationField(schema: PrismaSchema, model: string, field: string): { model: string; field: string } | undefined {
  const m = schema.models.find((x) => x.name === model);
  const f = m?.fields.find((x) => x.name === field);
  if (!m || !f) return undefined;
  const other = schema.models.find((x) => x.name === f.type);
  if (!other) return undefined;
  const name = relationNameOf(f);
  const hasFk = !!f.relation?.fields?.length;
  const candidates = other.fields.filter(
    (g) => g.type === model && !(other.name === model && g.name === field) && relationNameOf(g) === name && (hasFk ? !g.relation?.fields?.length : true),
  );
  const pick = candidates[0];
  return pick ? { model: other.name, field: pick.name } : undefined;
}

/** text の中の、key: [...] (key が null ならすべての [...]) の一覧の名前 old を next に変える */
function renameInLists(text: string, key: string | null, old: string, next: string): string {
  const re = key === null ? /(\[)([^\]]*)(\])/g : new RegExp(`(\\b${key}\\s*:\\s*\\[)([^\\]]*)(\\])`, "g");
  return text.replace(re, (_all, open: string, body: string, close: string) => {
    const replaced = body.replace(/[A-Za-z_]\w*/g, (word, offset: number) => {
      // かっこの中 (sort: Desc など) の名前は変えない
      const before = body.slice(0, offset);
      const depth = (before.match(/\(/g)?.length ?? 0) - (before.match(/\)/g)?.length ?? 0);
      return depth === 0 && word === old ? next : word;
    });
    return open + replaced + close;
  });
}

// ---------------------------------------------------------------- 操作

/** 図の操作を DSL に当てる。解析エラーのある DSL、存在しないテーブル・列、使えない名前は失敗 */
export function applyPrismaEdit(dsl: string, edit: PrismaEdit): PrismaEditResult {
  const doc = new Doc(dsl);
  if (doc.schema.errors.length > 0) return fail("DSL に解析エラーがあるので、図では直せません。テキストで直してください");
  const r = run(doc, edit);
  if (r) return fail(r);
  return { ok: true, dsl: doc.text() };
}

function run(doc: Doc, edit: PrismaEdit): string | null {
  switch (edit.type) {
    case "addModel":
      return addModel(doc, edit.name);
    case "renameModel":
      return renameModel(doc, edit.from, edit.to);
    case "removeModel":
      return removeModel(doc, edit.name);
    case "addField":
      return addField(doc, edit.model, edit.field);
    case "updateField":
      return updateField(doc, edit.model, edit.field, edit.patch);
    case "removeField":
      return removeField(doc, edit.model, edit.field);
    case "addRelation":
      return addRelation(doc, edit);
    case "removeRelation":
      return removeRelation(doc, edit.model, edit.field);
  }
}

const noModel = (name: string) => `テーブルがありません: ${name}`;
const noField = (model: string, field: string) => `${model} に列がありません: ${field}`;

function addModel(doc: Doc, name: string): string | null {
  const bad = checkNewModelName(doc.schema, name);
  if (bad) return bad;
  const block = [`model ${name} {`, "  id String @id", "}"];
  while (doc.lines.length > 0 && doc.lines[doc.lines.length - 1]!.trim() === "") doc.lines.pop();
  if (doc.lines.length > 0) doc.lines.push("");
  doc.lines.push(...block, "");
  doc.refresh();
  return null;
}

function renameModel(doc: Doc, from: string, to: string): string | null {
  if (from === to) return null;
  if (!doc.model(from)) return noModel(from);
  const bad = checkNewModelName(doc.schema, to);
  if (bad) return bad;
  // 型として参照しているフィールド (自分の中も含む)
  for (const m of doc.schema.models) {
    for (const f of m.fields) {
      if (f.type !== from) continue;
      doc.rewriteField(m.name, f.name, { ...f, type: to });
    }
  }
  const b = doc.block(from)!;
  doc.lines[b.start] = doc.lines[b.start]!.replace(new RegExp(`^(\\s*model\\s+)${from}\\b`), `$1${to}`);
  doc.refresh();
  return null;
}

function removeModel(doc: Doc, name: string): string | null {
  if (!doc.model(name)) return noModel(name);
  // ほかの model にある、このテーブルへの関連のフィールドと、その関連だけに使う外部キーの列
  for (const m of doc.schema.models) if (m.name !== name && m.fields.some((f) => f.type === name)) doc.expand(m.name);
  const drop = new Set<number>();
  for (const m of doc.schema.models) {
    if (m.name === name) continue;
    const loc = doc.block(m.name)!;
    const gone = m.fields.filter((f) => f.type === name);
    if (gone.length === 0) continue;
    const stay = m.fields.filter((f) => !gone.includes(f));
    // ほかの関連や @@id・@@unique などの一覧に使っている列は残す (消すと、無い列を指す制約が残る)
    const stillUsed = new Set([...stay.flatMap((f) => f.relation?.fields ?? []), ...blockListColumns(m)]);
    for (const f of gone) {
      drop.add(loc.fields.get(f.name)!);
      for (const fk of f.relation?.fields ?? []) {
        const fkField = m.fields.find((x) => x.name === fk);
        if (fkField && !fkField.isId && !stillUsed.has(fk) && loc.fields.has(fk)) drop.add(loc.fields.get(fk)!);
      }
    }
  }
  const b = doc.block(name)!;
  for (let i = b.start; i <= b.end; i++) drop.add(i);
  // 直前のコメントだけの行 (// TODO: 名前を直す など) も一緒に消す
  for (let i = b.start - 1; i >= 0 && /^\s*\/\//.test(doc.lines[i]!); i--) drop.add(i);
  // 前後とも空行になるなら、後ろの空行を 1 つ消す
  const before = Math.min(...drop) - 1;
  if (b.end + 1 < doc.lines.length && doc.lines[b.end + 1]!.trim() === "" && (before < 0 || doc.lines[before]!.trim() === "")) drop.add(b.end + 1);
  doc.removeLines(drop);
  return null;
}

function addField(doc: Doc, model: string, field: NewPrismaField): string | null {
  const m = doc.model(model);
  if (!m) return noModel(model);
  const bad = checkNewFieldName(m, field.name);
  if (bad) return bad;
  if (!knownTypes(doc.schema).has(field.type)) return `未知の型です: ${field.type}`;
  if (doc.schema.models.some((x) => x.name === field.type)) return "テーブルへの関連は、列から列へ線を引いて作ってください";
  doc.insertField(model, printPrismaField({ name: field.name, type: field.type, isList: !!field.isList, isOptional: !!field.isOptional && !field.isList, attributes: [] }));
  return null;
}

function updateField(doc: Doc, model: string, fieldName: string, patch: PrismaFieldPatch): string | null {
  const m = doc.model(model);
  if (!m) return noModel(model);
  const f = m.fields.find((x) => x.name === fieldName);
  if (!f) return noField(model, fieldName);
  const relation = isRelationField(doc.schema, f);
  const nextName = patch.name ?? f.name;
  if (nextName !== f.name) {
    const bad = checkNewFieldName(m, nextName);
    if (bad) return bad;
  }
  const nextType = patch.type ?? f.type;
  if (nextType !== f.type) {
    if (relation) return "関連の列の型は変えられません。線を消して引き直してください";
    if (!knownTypes(doc.schema).has(nextType)) return `未知の型です: ${nextType}`;
    if (doc.schema.models.some((x) => x.name === nextType)) return "テーブルへの関連は、列から列へ線を引いて作ってください";
  }
  let attributes = [...f.attributes];
  const toggle = (name: string, on: boolean | undefined) => {
    if (on === undefined) return;
    const has = attributes.some((a) => a.name === name);
    if (on && !has) attributes = [{ name, args: "" }, ...attributes];
    if (!on && has) attributes = attributes.filter((a) => a.name !== name);
  };
  if (relation && (patch.isId || patch.isUnique)) return "関連の列は主キーや一意にできません";
  toggle("unique", patch.isUnique);
  toggle("id", patch.isId);
  let isList = patch.isList ?? f.isList;
  let isOptional = patch.isOptional ?? f.isOptional;
  if (patch.isList === true) isOptional = false;
  if (patch.isOptional === true) isList = false;
  if ((attributes.some((a) => a.name === "id") || inCompositeId(m, f.name)) && isOptional) return "主キーの列は NULL 可にできません";
  const next: PrismaField = { ...f, name: nextName, type: nextType, isList, isOptional, attributes };
  doc.rewriteField(model, f.name, next);
  doc.refresh();
  if (nextName !== f.name) renameFieldReferences(doc, model, f.name, nextName);
  return null;
}

/** 列の名前を変えたときに、それを指す一覧 (自分の @relation の fields、@@id などの一覧、ほかのテーブルからの references) を合わせる */
function renameFieldReferences(doc: Doc, model: string, old: string, next: string) {
  const m = doc.model(model)!;
  for (const f of m.fields) {
    if (!f.relation?.fields?.includes(old)) continue;
    const at = doc.block(model)!.fields.get(f.name)!;
    doc.lines[at] = renameInLists(doc.lines[at]!, "fields", old, next);
  }
  for (const other of doc.schema.models) {
    for (const f of other.fields) {
      if (f.type !== model || !f.relation?.references?.includes(old)) continue;
      doc.expand(other.name);
      const at = doc.block(other.name)!.fields.get(f.name)!;
      doc.lines[at] = renameInLists(doc.lines[at]!, "references", old, next);
    }
  }
  const b = doc.block(model)!;
  for (let i = b.start + 1; i < b.end; i++) {
    if (stripComment(doc.lines[i]!).trim().startsWith("@@")) doc.lines[i] = renameInLists(doc.lines[i]!, null, old, next);
  }
  doc.refresh();
}

function removeField(doc: Doc, model: string, fieldName: string): string | null {
  const m = doc.model(model);
  if (!m) return noModel(model);
  const f = m.fields.find((x) => x.name === fieldName);
  if (!f) return noField(model, fieldName);
  if (isRelationField(doc.schema, f)) return removeRelation(doc, model, fieldName);
  if (blockListColumns(m).has(fieldName)) return `${model}.${fieldName} は @@id・@@unique などの一覧に使われているので消せません。テキストで一覧から外してください`;
  // この列を外部キーに使う関連と、この列を参照先 (references) にするほかのテーブルからの関連も消す (関連だけが残ると DSL が壊れる)
  const using = doc.schema.models.flatMap((x) =>
    x.fields
      .filter((r) => (x.name === model && r.relation?.fields?.includes(fieldName)) || (r.type === model && r.relation?.references?.includes(fieldName)))
      .map((r) => ({ model: x.name, field: r.name })),
  );
  for (const r of using) {
    // 自分への関連は、外部キーと参照先の両方に当たることがあるので、残っているものだけ消す
    if (!doc.model(r.model)?.fields.some((x) => x.name === r.field)) continue;
    const e = removeRelation(doc, r.model, r.field);
    if (e) return e;
  }
  doc.expand(model);
  const at = doc.block(model)!.fields.get(fieldName);
  if (at === undefined) return noField(model, fieldName);
  doc.removeLines([at]);
  return null;
}

function addRelation(doc: Doc, edit: Extract<PrismaEdit, { type: "addRelation" }>): string | null {
  const from = doc.model(edit.from);
  if (!from) return noModel(edit.from);
  const to = doc.model(edit.to);
  if (!to) return noModel(edit.to);
  if (edit.fields.length === 0 || edit.fields.length !== edit.references.length) return "関連の列の数が合いません";
  const fks = edit.fields.map((n) => from.fields.find((f) => f.name === n));
  const refs = edit.references.map((n) => to.fields.find((f) => f.name === n));
  for (let i = 0; i < fks.length; i++) {
    const fk = fks[i];
    const ref = refs[i];
    if (!fk) return noField(edit.from, edit.fields[i]!);
    if (!ref) return noField(edit.to, edit.references[i]!);
    if (isRelationField(doc.schema, fk) || isRelationField(doc.schema, ref)) return "関連の列どうしは結べません。値を持つ列から列へ線を引いてください";
    if (fk.isList || ref.isList) return "リストの列は関連に使えません";
    if (fk.type !== ref.type) return `型が違うので結べません: ${edit.from}.${fk.name} (${fk.type}) と ${edit.to}.${ref.name} (${ref.type})`;
    if (edit.from === edit.to && fk.name === ref.name) return "同じ列どうしは結べません";
  }
  const exists = from.fields.some((f) => f.type === edit.to && f.relation?.fields?.join(",") === edit.fields.join(","));
  if (exists) return `${edit.from} の ${edit.fields.join(", ")} からの関連はもうあります`;
  // 同じ 2 つのテーブルの間にほかの関連がある (か、自分への関連) なら、関連に名前を付けて区別する
  const between = edit.from === edit.to || from.fields.some((f) => f.type === edit.to) || to.fields.some((f) => f.type === edit.from);
  const name = between ? `${edit.from}_${edit.fields.join("_")}` : undefined;
  const optional = fks.some((f) => f!.isOptional);
  // 外部キーが一意 (か主キー) なら 1 対 1、そうでなければ 1 対多
  const single = edit.fields.length === 1 ? fks[0]!.isId || fks[0]!.isUnique : from.blockAttributes.some((a) => (a.name === "unique" || a.name === "id") && sameList(listOf(a.args), edit.fields));

  const forwardName = freeFieldName(from, lowerFirst(edit.fields.length === 1 && /Id$/.test(edit.fields[0]!) && edit.fields[0]!.length > 2 ? edit.fields[0]!.slice(0, -2) : edit.to));
  const named = name ? `"${name}", ` : "";
  const forward = `${forwardName} ${edit.to}${optional ? "?" : ""} @relation(${named}fields: [${edit.fields.join(", ")}], references: [${edit.references.join(", ")}])`;
  doc.insertField(edit.from, forward);
  // 相手側の対 (自分への関連なら、いま足したフィールドも避ける)
  const target = doc.model(edit.to)!;
  const backBase = lowerFirst(edit.from) + (single ? "" : edit.from.endsWith("s") ? "List" : "s");
  const backName = freeFieldName(target, backBase);
  const back = `${backName} ${edit.from}${single ? "?" : "[]"}${name ? ` @relation("${name}")` : ""}`;
  doc.insertField(edit.to, back);
  return null;
}

/** @@id・@@unique・@@index などの一覧に入っている列の名前 */
const blockListColumns = (m: PrismaModel): Set<string> => new Set(m.blockAttributes.flatMap((a) => listOf(a.args)));
/** @@id の一覧に入っている (複合主キーの構成列) か */
const inCompositeId = (m: PrismaModel, field: string) => m.blockAttributes.some((a) => a.name === "id" && listOf(a.args).includes(field));

const listOf = (args: string) => /\[([^\]]*)\]/.exec(args)?.[1]?.split(",").map((s) => s.trim().split("(")[0]!.trim()).filter(Boolean) ?? [];
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function removeRelation(doc: Doc, model: string, fieldName: string): string | null {
  const m = doc.model(model);
  if (!m) return noModel(model);
  const f = m.fields.find((x) => x.name === fieldName);
  if (!f) return noField(model, fieldName);
  if (!isRelationField(doc.schema, f)) return `${model}.${fieldName} は関連の列ではありません`;
  const opposite = oppositeRelationField(doc.schema, model, fieldName);
  doc.expand(model);
  if (opposite) doc.expand(opposite.model);
  const drop = [doc.block(model)!.fields.get(fieldName)!];
  if (opposite) drop.push(doc.block(opposite.model)!.fields.get(opposite.field)!);
  doc.removeLines(drop);
  return null;
}

// ---------------------------------------------------------------- 図に出す関連

export interface PrismaRelationLine {
  /** 外部キーを持つ側 */
  from: string;
  /** 関連のフィールド (from の中) */
  field: string;
  fields: string[];
  to: string;
  references: string[];
}

/** 図の線にする関連 (外部キーの列 → 参照先の列)。参照先のテーブルが無いものは除く */
export function prismaRelationLines(schema: PrismaSchema): PrismaRelationLine[] {
  const names = new Set(schema.models.map((m) => m.name));
  const out: PrismaRelationLine[] = [];
  for (const m of schema.models) {
    for (const f of m.fields) {
      const fields = f.relation?.fields ?? [];
      const references = f.relation?.references ?? [];
      if (!names.has(f.type) || fields.length === 0) continue;
      out.push({ from: m.name, field: f.name, fields, to: f.type, references });
    }
  }
  return out;
}
