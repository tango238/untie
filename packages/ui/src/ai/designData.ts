// 設計モードのデータボード「情報から作る (AI)」: 対象システムが使う情報から、データベースの DSL (Prisma の一部) と
// テーブル → 情報の対応を一回きりで作らせる。AI は submit_database で結果を提出し、DSL を解析して、エラーがあれば 1 回だけ出し直させる。
import { informationLocations, screenInformationTables } from "@untie/core/model/analysis";
import { aggregateOfInformation, systemInformationIds } from "@untie/core/model/designData";
import { parsePrismaDsl, PRISMA_SCALAR_TYPES, type PrismaError } from "@untie/core/model/prisma";
import type { Database, UntieModel } from "@untie/core/model/types";
import { ChatError, createChatSession } from "./chat";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

export interface DatabaseDesign {
  dsl: string;
  tables: { table: string; informationIds: string[] }[];
}

export interface DatabaseDesignResult extends DatabaseDesign {
  /** 提出された DSL に残っている解析エラー (出し直しのあとも直らなかったもの) */
  errors: PrismaError[];
  /** 存在しない情報の id や、DSL に無いテーブルのため捨てた対応の数 */
  dropped: number;
}

export const SUBMIT_DATABASE_TOOL: ToolDef = {
  name: "submit_database",
  description: "データベースの DSL (Prisma のスキーマの一部) と、テーブル → 情報 id の対応を提出する。DSL に解析エラーがあると、理由が返るので直して出し直す。",
  parameters: {
    type: "object",
    properties: {
      dsl: { type: "string", description: "Prisma のスキーマ (model / enum だけ。datasource や generator は書かない)" },
      tables: {
        type: "array",
        description: "model の名前と、それが表す情報の id。1 つの情報を複数のテーブルが表してもよい",
        items: {
          type: "object",
          properties: { table: { type: "string" }, informationIds: { type: "array", items: { type: "string" } } },
          required: ["table", "informationIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["dsl", "tables"],
    additionalProperties: false,
  },
};

export function dataDesignSystemPrompt(): string {
  return `あなたはデータベース設計に詳しい担当者です。業務分析で洗い出した情報から、システムのデータベースの設計を作ります。
設計は Prisma のスキーマ言語の一部 (DSL) で書きます。使えるのは次のものだけです。
- model / enum ブロック。datasource / generator は書かない
- 型: ${PRISMA_SCALAR_TYPES.join("・")}、および model・enum の名前。? (省略可) と [] (複数) が付けられる
- 属性: @id @unique @default(...) @relation(fields: [...], references: [...]) @map("...")、ブロック属性: @@id([...]) @@unique([...]) @@map("...")
- コメントは // で書く

決まり:
- model と列の名前は英語 (model は PascalCase、列は camelCase)。表す情報の名前は model の前の // コメントに書く
- 対象のシステムが使う情報は、必ずどれかの model が表すようにする。複数の情報を 1 つの model にまとめても、1 つの情報を複数の model に分けてもよい
- 情報どうしの関連は @relation で表す。外部キーの列も書く。種別のように値が決まっているものは enum にする
- 情報に集約 (aggregate) が書いてあれば、集約の境界に合わせる: ルート (role: root) を 1 つの model にし、英語名 (english) があれば model の名前にする。中の情報 (role: member) は、ルートへの @relation を持つ model か、ルートの model の列にする。別の集約の情報との関連は、@relation を張らずに ID の列だけにする (集約をまたいで整合を取らないため)。集約の書いていない情報どうしは、上の決まりどおり @relation で表す
- 業務の言葉にない列を作りすぎない。主キー (id) と、情報の説明から読み取れる列、関連の外部キーを中心にする
- 今の DSL が空でなければ、それを直したり足したりして全体を返す (既存の model の名前は変えない)。テーブル → 情報の対応も、今の対応を含めた全体を返す (返さなかった既存の対応は、model が残っていればそのまま残る)
- 結果は submit_database で提出する。DSL に解析エラーがあると理由が返るので、直して出し直す`;
}

const nameOf = (e: { name: string } | undefined) => e?.name || "(名前なし)";

/** 情報が入っている集約 (ドメインモデルで決めてあれば)。AI がテーブルの境界を集約に合わせるための材料 */
function aggregateForAi(model: UntieModel, systemId: string, informationId: string): { aggregate?: { name: string; english?: string; context?: string; role: "root" | "member"; rootInformationId: string } } {
  const owner = aggregateOfInformation(model, systemId, informationId);
  if (!owner) return {};
  const a = owner.aggregate;
  return { aggregate: { name: a.name, ...(a.english ? { english: a.english } : {}), ...(owner.context ? { context: owner.context.name } : {}), role: owner.role, rootInformationId: a.rootInformationId } };
}

/** 対象システムが使う情報の材料と、今の DSL・対応を渡す依頼の文章 */
export function dataDesignRequest(model: UntieModel, systemId: string, db: Database): string {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const system = byId.get(systemId);
  const { rows } = informationLocations(model);
  const location = new Map(rows.map((r) => [r.information.id, r]));
  const { tables } = screenInformationTables(model);
  const screensOf = new Map<string, string[]>();
  for (const t of tables.filter((x) => x.system.id === systemId)) {
    for (const row of t.rows) for (const id of row.cells.keys()) screensOf.set(id, [...(screensOf.get(id) ?? []), nameOf(row.screen)]);
  }
  const related = (id: string) =>
    model.relations
      .filter((r) => r.kind === "informationRelated" && (r.sourceId === id || r.targetId === id))
      .map((r) => nameOf(byId.get(r.sourceId === id ? r.targetId : r.sourceId)));
  const infos = systemInformationIds(model, systemId).map((id) => {
    const info = byId.get(id)!;
    const loc = location.get(id);
    const places = loc ? [...loc.places].map(([placeId, roles]) => `${nameOf(byId.get(placeId))} (${roles.map((r) => (r === "source" ? "取得元" : "保存先")).join("・")})`) : [];
    return {
      id,
      name: nameOf(info),
      ...(info.description ? { description: info.description } : {}),
      ...(related(id).length > 0 ? { related: related(id) } : {}),
      ...(screensOf.has(id) ? { screens: [...new Set(screensOf.get(id))] } : {}),
      ...(places.length > 0 ? { places } : {}),
      ...aggregateForAi(model, systemId, id),
    };
  });
  return `システム「${nameOf(system)}」のデータベース「${db.name}」の設計を作ってください。

<システムが使う情報>
${JSON.stringify(infos, null, 2)}
</システムが使う情報>

<今の DSL>
${db.dsl === "" ? "(空)" : db.dsl}
</今の DSL>

<今の対応 (テーブル → 情報 id)>
${JSON.stringify(db.tables.map((t) => ({ table: t.table, informationIds: t.informationIds })))}
</今の対応>

DSL と、テーブル → 情報 id の対応を、submit_database で提出してください。`;
}

/** 提出された内容 (または文章の中の JSON) を取り出す。形が違えば null */
export function readDatabaseDesign(raw: unknown): DatabaseDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { dsl?: unknown; tables?: unknown };
  if (typeof r.dsl !== "string" || !Array.isArray(r.tables)) return null;
  const tables = r.tables.flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const x = t as { table?: unknown; informationIds?: unknown; information_ids?: unknown };
    const ids = Array.isArray(x.informationIds) ? x.informationIds : Array.isArray(x.information_ids) ? x.information_ids : [];
    if (typeof x.table !== "string" || x.table === "") return [];
    return [{ table: x.table, informationIds: ids.filter((i): i is string => typeof i === "string") }];
  });
  return { dsl: r.dsl, tables };
}

/** AI が文章で返した JSON を取り出す (```json で囲んでいてもよい) */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export interface DataDesignOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * 対象システムが使う情報から、データベースの DSL と対応を作る。
 * 提出した DSL に解析エラーがあれば 1 回だけ出し直させ、それでも残れば残ったまま返す (errors に入る)。
 * 存在しない情報の id と、DSL に無い model の対応は捨てる
 */
export async function generateDatabaseDesign(model: UntieModel, systemId: string, db: Database, o: DataDesignOptions): Promise<DatabaseDesignResult> {
  const box: { value: DatabaseDesignResult | null } = { value: null };
  let attempts = 0;
  const infoIds = new Set(model.elements.filter((e) => e.kind === "information").map((e) => e.id));

  const evaluate = (design: DatabaseDesign, final: boolean): { result?: DatabaseDesignResult; retry?: string } => {
    const schema = parsePrismaDsl(design.dsl);
    if (schema.errors.length > 0 && !final) {
      return { retry: `DSL に解析エラーがあります。直して submit_database で出し直してください:\n- ${schema.errors.slice(0, 20).map((e) => `${e.line} 行 ${e.column} 列: ${e.message}`).join("\n- ")}` };
    }
    const names = new Set(schema.models.map((m) => m.name));
    let dropped = 0;
    const tables: DatabaseDesign["tables"] = [];
    for (const t of design.tables) {
      const ids = [...new Set(t.informationIds)].filter((id) => infoIds.has(id));
      dropped += new Set(t.informationIds).size - ids.length;
      if (!names.has(t.table)) {
        dropped += ids.length;
        continue;
      }
      if (ids.length > 0) tables.push({ table: t.table, informationIds: ids });
    }
    // 返ってこなかった既存の対応は、model が残っていれば残す
    for (const t of db.tables) {
      if (!names.has(t.table) || tables.some((x) => x.table === t.table)) continue;
      const ids = t.informationIds.filter((id) => infoIds.has(id));
      if (ids.length > 0) tables.push({ table: t.table, informationIds: ids });
    }
    return { result: { dsl: design.dsl, tables, errors: schema.errors, dropped } };
  };

  const runTool = (name: string, input: unknown): ToolOutcome => {
    if (name !== "submit_database") return { ok: false, content: JSON.stringify({ error: `不明な道具です: ${name}` }), changed: false };
    const design = readDatabaseDesign(input);
    if (!design) return { ok: false, content: JSON.stringify({ error: "dsl (文字列) と tables (配列) が必要です" }), changed: false };
    attempts++;
    const { result, retry } = evaluate(design, attempts > 1);
    if (retry) return { ok: false, content: JSON.stringify({ error: retry }), changed: false };
    box.value = result!;
    return { ok: true, content: JSON.stringify({ result: "受け付けました" }), changed: false };
  };

  const session = createChatSession(o.provider, { apiKey: o.apiKey, model: o.model, system: dataDesignSystemPrompt(), tools: [SUBMIT_DATABASE_TOOL], runTool });
  const text = await session.send(dataDesignRequest(model, systemId, db), {}, o.signal);
  if (!box.value) {
    // 道具を呼ばずに文章で JSON を返したときは、それを読む
    const design = readDatabaseDesign(extractJson(text));
    if (design) box.value = evaluate(design, true).result!;
  }
  if (!box.value) {
    await session.send("submit_database でデータベースの設計を提出してください。", {}, o.signal);
  }
  if (!box.value) throw new ChatError("AI がデータベースの設計を提出しませんでした。もう一度試してください。");
  // 今の DSL が読めるのに、結果にエラーが残るときは置かない (置き換えると壊れた DSL になる)
  if (box.value.errors.length > 0 && parsePrismaDsl(db.dsl).errors.length === 0) {
    throw new ChatError(`AI が作った DSL に解析エラーが ${box.value.errors.length} 件残っていたため、置き換えませんでした。もう一度試してください。`);
  }
  return box.value;
}
