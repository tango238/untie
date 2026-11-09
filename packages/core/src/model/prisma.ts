// データベースの DSL (Prisma のスキーマ言語の一部) の解析器。純粋関数だけを置く (設計書 5.7)。
// 対応する範囲: model / enum ブロック、フィールドの型 (? と [])、@id @unique @default @relation @map、@@id @@unique @@map、// コメント。
// datasource / generator などのブロックは読み飛ばす。ほかの属性 (@db.VarChar など) は生のまま持ち、エラーにしない。
// エラーは行・列つきで集め、ブロック単位 (model の中は 1 行単位) で復帰して続ける。

export interface PrismaAttribute {
  /** @ を除いた名前 (@@ のときは @@ も除く。例: id, map, db.VarChar) */
  name: string;
  /** かっこの中身 (かっこが無ければ空文字) */
  args: string;
}

export interface PrismaField {
  name: string;
  /** 型の名前 (? と [] は除く) */
  type: string;
  isList: boolean;
  isOptional: boolean;
  isId: boolean;
  isUnique: boolean;
  mapName?: string;
  /** @default(...) のかっこの中身 */
  defaultValue?: string;
  relation?: { fields?: string[]; references?: string[] };
  /** 未知のものを含む、すべての属性 */
  attributes: PrismaAttribute[];
}

export interface PrismaModel {
  name: string;
  mapName?: string;
  fields: PrismaField[];
  /** @@id / @@unique / @@map など (name は @@ を除く) */
  blockAttributes: PrismaAttribute[];
}

export interface PrismaEnum {
  name: string;
  values: string[];
  mapName?: string;
}

export interface PrismaError {
  /** 1 から */
  line: number;
  /** 1 から */
  column: number;
  message: string;
}

export interface PrismaSchema {
  models: PrismaModel[];
  enums: PrismaEnum[];
  errors: PrismaError[];
}

/** 組み込みのスカラー型 */
export const PRISMA_SCALAR_TYPES = ["String", "Int", "BigInt", "Float", "Boolean", "DateTime", "Decimal", "Json", "Bytes"] as const;

/** 読み飛ばすブロック */
const SKIPPED_BLOCKS = new Set(["datasource", "generator"]);
/** 解析しないが、ブロックとしては読んで飛ばすもの (複合型・ビュー) */
const IGNORED_BLOCKS = new Set(["type", "view"]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** model・テーブルの名前として使える識別子か */
export const isPrismaIdent = (name: string): boolean => IDENT.test(name);

interface Line {
  /** 1 から */
  no: number;
  /** コメントを除いた本文 (列は元の行と揃える) */
  code: string;
}

/** // から行末までを除く (文字列の中の // は残す) */
export function stripComment(raw: string): string {
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "/" && raw[i + 1] === "/") return raw.slice(0, i);
  }
  return raw;
}

/** 文字列の中を除いて、最初の } の位置 (無ければ -1) */
export function findClose(text: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "}") return i;
  }
  return -1;
}

/** ブロックの見出し (model Foo { など) */
export const HEADER = /^(\s*)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\{(.*)$/;
const BLOCK_KEYWORDS = new Set(["model", "enum", "datasource", "generator", "type", "view"]);

/** 文字列リテラルの中身 ("..." の最初の 1 つ) */
export function firstString(args: string): string | undefined {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(args);
  return m ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

/** [a, b] のような列の一覧 (かっこの中身から) */
function nameList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** args から `key: [a, b]` を取り出す */
function listArg(args: string, key: string): string[] | undefined {
  const m = new RegExp(`(?:^|[,\\s(])${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args);
  return m ? nameList(m[1]) : undefined;
}

/**
 * text の from から始まる属性 (@name か @@name、続けて (...)) を読む。かっこは入れ子と文字列を考える。
 * 閉じていなければ error を返す
 */
function readAttributes(text: string, from: number): { attrs: { name: string; args: string; column: number }[]; error?: { column: number; message: string } } {
  const attrs: { name: string; args: string; column: number }[] = [];
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] !== "@") return { attrs, error: { column: i, message: `属性として読めません: ${text.slice(i).split(/\s/)[0]}` } };
    const start = i;
    i += text[i + 1] === "@" ? 2 : 1;
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    if (name === "") return { attrs, error: { column: start, message: "属性の名前がありません" } };
    let args = "";
    if (text[i] === "(") {
      let depth = 0;
      let inString = false;
      const argStart = i + 1;
      let closed = false;
      for (; i < text.length; i++) {
        const c = text[i];
        if (inString) {
          if (c === "\\") i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            args = text.slice(argStart, i);
            i++;
            closed = true;
            break;
          }
        }
      }
      if (!closed) return { attrs, error: { column: start, message: `@${name} のかっこが閉じられていません` } };
    }
    attrs.push({ name, args: args.trim(), column: start });
  }
  return { attrs };
}

interface RawField {
  field: PrismaField;
  typeLine: number;
  typeColumn: number;
}

export function parsePrismaDsl(dsl: string): PrismaSchema {
  const errors: PrismaError[] = [];
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];
  const ignoredNames = new Set<string>();
  const declared = new Set<string>();
  const rawFields = new Map<PrismaModel, RawField[]>();
  const err = (line: number, column: number, message: string) => errors.push({ line, column, message });

  const lines: Line[] = dsl.split(/\r\n|\r|\n/).map((raw, i) => ({ no: i + 1, code: stripComment(raw) }));
  const firstCol = (code: string) => code.search(/\S/) + 1;

  let i = 0;
  while (i < lines.length) {
    const { no, code } = lines[i];
    const trimmed = code.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    const header = HEADER.exec(code);
    if (!header) {
      // 「model Foo」だけで { が無い、ブロックの外の行、余分な } など。1 行だけ飛ばして続ける
      const kw = /^\s*(model|enum)\b/.exec(code);
      err(no, firstCol(code), kw ? `${kw[1]} のブロックを { で開いてください` : trimmed.startsWith("}") ? "対応する { がありません" : `ここには model か enum のブロックを書きます: ${trimmed.split(/\s/)[0]}`);
      i++;
      continue;
    }
    const kind = header[2];
    const name = header[3];
    const nameColumn = code.indexOf(name, header[1].length + kind.length) + 1;
    // ブロックの中身 (開き行の { のあとも含む) を、} まで集める
    const body: Line[] = [];
    let rest = header[4];
    let closed = false;
    let j = i;
    const closeAt = findClose(rest);
    if (closeAt >= 0) {
      body.push({ no, code: " ".repeat(code.length - rest.length) + rest.slice(0, closeAt) });
      closed = true;
    } else {
      if (rest.trim() !== "") body.push({ no, code: " ".repeat(code.length - rest.length) + rest });
      for (j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        const at = findClose(l.code);
        if (at >= 0) {
          const before = l.code.slice(0, at);
          if (before.trim() !== "") body.push({ no: l.no, code: before });
          closed = true;
          break;
        }
        // 閉じ忘れ: 次のブロックの見出しが来たら、そこから読み直す
        const next = HEADER.exec(l.code);
        if (next && BLOCK_KEYWORDS.has(next[2]!)) {
          j--;
          break;
        }
        body.push(l);
      }
    }
    if (!closed) err(no, nameColumn, `${name} のブロックが } で閉じられていません`);
    i = closed ? j + 1 : j >= lines.length ? lines.length : j + 1;

    if (IGNORED_BLOCKS.has(kind) && IDENT.test(name)) ignoredNames.add(name);
    if (SKIPPED_BLOCKS.has(kind) || IGNORED_BLOCKS.has(kind)) continue;
    if (kind !== "model" && kind !== "enum") {
      err(no, header[1].length + 1, `解釈できないブロックです: ${kind} (model か enum を書きます)`);
      continue;
    }
    if (!IDENT.test(name)) {
      err(no, nameColumn, `名前が正しくありません: ${name}`);
      continue;
    }
    if (declared.has(name)) {
      err(no, nameColumn, `同じ名前の model / enum があります: ${name}`);
      continue;
    }
    declared.add(name);
    if (kind === "enum") enums.push(parseEnumBody(name, body, err));
    else {
      const model = parseModelBody(name, body, err, rawFields);
      models.push(model);
    }
  }

  // 型の検査は、すべての model / enum が出そろってから
  const known = new Set<string>([...PRISMA_SCALAR_TYPES, ...ignoredNames, ...models.map((m) => m.name), ...enums.map((e) => e.name)]);
  for (const model of models) {
    for (const raw of rawFields.get(model) ?? []) {
      if (!known.has(raw.field.type)) err(raw.typeLine, raw.typeColumn, `未知の型です: ${raw.field.type}`);
    }
  }
  errors.sort((a, b) => a.line - b.line || a.column - b.column);
  return { models, enums, errors };
}

function parseEnumBody(name: string, body: Line[], err: (line: number, column: number, message: string) => void): PrismaEnum {
  const values: string[] = [];
  let mapName: string | undefined;
  const seen = new Set<string>();
  for (const { no, code } of body) {
    const trimmed = code.trim();
    if (trimmed === "") continue;
    const col = firstCol0(code);
    if (trimmed.startsWith("@@")) {
      const { attrs, error } = readAttributes(code, col - 1);
      if (error) err(no, error.column + 1, error.message);
      for (const a of attrs) if (a.name === "map") mapName = firstString(a.args) ?? mapName;
      continue;
    }
    const m = /^([A-Za-z_]\w*)\s*(.*)$/.exec(trimmed);
    if (!m) {
      err(no, col, `enum の値として読めません: ${trimmed}`);
      continue;
    }
    if (seen.has(m[1]!)) {
      err(no, col, `同じ値があります: ${m[1]}`);
      continue;
    }
    if (m[2] !== "") {
      const { error } = readAttributes(code, col - 1 + m[1].length);
      if (error) err(no, error.column + 1, error.message);
    }
    seen.add(m[1]!);
    values.push(m[1]);
  }
  return { name, values, ...(mapName !== undefined ? { mapName } : {}) };
}

const firstCol0 = (code: string) => code.search(/\S/) + 1;

function parseModelBody(
  name: string,
  body: Line[],
  err: (line: number, column: number, message: string) => void,
  rawFields: Map<PrismaModel, RawField[]>,
): PrismaModel {
  const model: PrismaModel = { name, fields: [], blockAttributes: [] };
  const raws: RawField[] = [];
  const fieldNames = new Set<string>();
  rawFields.set(model, raws);
  for (const { no, code } of body) {
    const trimmed = code.trim();
    if (trimmed === "") continue;
    const col = firstCol0(code);
    if (trimmed.startsWith("@@")) {
      const { attrs, error } = readAttributes(code, col - 1);
      if (error) err(no, error.column + 1, error.message);
      for (const a of attrs) {
        model.blockAttributes.push({ name: a.name, args: a.args });
        if (a.name === "map") model.mapName = firstString(a.args) ?? model.mapName;
      }
      continue;
    }
    // 名前 型 (? か []) 属性...
    const m = /^([A-Za-z_]\w*)\s+([A-Za-z_][\w]*)(\[\])?(\?)?/.exec(trimmed);
    if (!m) {
      err(no, col, `フィールドとして読めません: ${trimmed}`);
      continue;
    }
    const typeColumn = col + trimmed.indexOf(m[2], m[1].length);
    if (fieldNames.has(m[1]!)) {
      err(no, col, `同じ名前のフィールドがあります: ${m[1]}`);
      continue;
    }
    const attrStart = col - 1 + m[0].length;
    const { attrs, error } = readAttributes(code, attrStart);
    if (error) err(no, error.column + 1, error.message);
    const field: PrismaField = {
      name: m[1],
      type: m[2],
      isList: m[3] !== undefined,
      isOptional: m[4] !== undefined,
      isId: false,
      isUnique: false,
      attributes: attrs.map((a) => ({ name: a.name, args: a.args })),
    };
    for (const a of attrs) {
      if (a.name === "id") field.isId = true;
      else if (a.name === "unique") field.isUnique = true;
      else if (a.name === "default") field.defaultValue = a.args;
      else if (a.name === "map") field.mapName = firstString(a.args) ?? field.mapName;
      else if (a.name === "relation") {
        const fields = listArg(a.args, "fields");
        const references = listArg(a.args, "references");
        field.relation = { ...(fields ? { fields } : {}), ...(references ? { references } : {}) };
      }
    }
    fieldNames.add(field.name);
    model.fields.push(field);
    raws.push({ field, typeLine: no, typeColumn });
  }
  return model;
}

/** 列の要約 (右のペインに出す短い表記。例: `String? @unique`) */
export function describePrismaField(f: PrismaField): string {
  const parts = [`${f.type}${f.isList ? "[]" : ""}${f.isOptional ? "?" : ""}`];
  if (f.isId) parts.push("@id");
  if (f.isUnique) parts.push("@unique");
  if (f.defaultValue !== undefined) parts.push(`@default(${f.defaultValue})`);
  if (f.relation) {
    const fk = f.relation.fields?.length ? `${f.relation.fields.join(", ")} → ${f.relation.references?.join(", ") ?? "?"}` : "";
    parts.push(fk ? `@relation(${fk})` : "@relation");
  }
  return parts.join(" ");
}
