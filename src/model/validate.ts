// スキーマ検証 (ajv, 2020-12) + 参照整合性の検査。
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import schema from "../../schema/untie.schema.json";
import { relationKindFor, sameRelation } from "./relations";
import { ELEMENT_KIND_LABELS, ELEMENT_KINDS, isIssueTargetKind } from "./types";
import type { Element, UntieModel } from "./types";

export type ValidationResult = { ok: true; model: UntieModel } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/** instancePath (/elements/3/name) を elements[3].name の形にする */
function pathLabel(instancePath: string): string {
  if (instancePath === "") return "(全体)";
  return instancePath
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}

function describeError(e: ErrorObject): string {
  const where = pathLabel(e.instancePath);
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `${where}: 必須項目「${String(p.missingProperty)}」がありません`;
    case "additionalProperties":
      return `${where}: 未知の項目「${String(p.additionalProperty)}」があります`;
    case "type":
      return `${where}: 型が不正です (${String(p.type)} である必要があります)`;
    case "enum":
      return `${where}: 許されない値です (${(p.allowedValues as unknown[]).map(String).join(" / ")} のいずれか)`;
    case "const":
      return `${where}: 値は ${JSON.stringify(p.allowedValue)} である必要があります`;
    case "minimum":
      return `${where}: ${String(p.limit)} 以上である必要があります`;
    case "maximum":
      return `${where}: ${String(p.limit)} 以下である必要があります`;
    case "minLength":
      return `${where}: ${String(p.limit)} 文字以上である必要があります`;
    case "maxLength":
      return `${where}: ${String(p.limit)} 文字以下である必要があります`;
    case "minItems":
      return `${where}: ${String(p.limit)} 件以上必要です`;
    case "pattern":
      return `${where}: 使えない文字が含まれています (英数字・_・- のみ)`;
    case "uniqueItems":
      return `${where}: 重複した値があります`;
    case "oneOf":
      return `${where}: どの種類の要素の形式にも合いません`;
    default:
      return `${where}: ${e.message ?? "スキーマに合いません"}`;
  }
}

/** 種類ごとの要素スキーマの検証関数 */
function elementValidator(kind: string) {
  return ajv.getSchema(`${schema.$id}#/$defs/${kind}`);
}

/**
 * elements の oneOf は全種類分のエラーが出て読めないので、
 * 要素ごとに自身の kind のスキーマで検証し直したエラーに置き換える。
 */
function summarizeSchemaErrors(json: unknown, errors: readonly ErrorObject[]): string[] {
  const elements = (json as { elements?: unknown })?.elements;
  const messages: string[] = [];
  const handled = new Set<number>();
  for (const e of errors) {
    const m = /^\/elements\/(\d+)(\/|$)/.exec(e.instancePath);
    if (!m || !Array.isArray(elements)) {
      messages.push(describeError(e));
      continue;
    }
    const index = Number(m[1]);
    if (handled.has(index)) continue;
    handled.add(index);
    const kind = (elements[index] as { kind?: unknown } | null)?.kind;
    const validate = typeof kind === "string" && (ELEMENT_KINDS as readonly string[]).includes(kind) ? elementValidator(kind) : undefined;
    if (!validate) {
      messages.push(`elements[${index}].kind: 要素の種類が不正です`);
      continue;
    }
    validate(elements[index]);
    for (const ve of validate.errors ?? []) {
      // bucId は oneOf (id か null) なので、枝ごとの複数エラーを 1 件にまとめる
      if (ve.instancePath === "/bucId") {
        messages.push(`elements[${index}].bucId: 文字列の id か null である必要があります`);
        continue;
      }
      messages.push(describeError({ ...ve, instancePath: `/elements/${index}${ve.instancePath}` }));
    }
  }
  return [...new Set(messages)];
}

/** 参照整合性の検査。問題を日本語で列挙する */
export function checkIntegrity(model: UntieModel): string[] {
  const errors: string[] = [];
  const label = (e: Element) => `${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」(${e.id})`;

  // id の一意性 (要素・関係・ボードそれぞれの中で)
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${what}の id が重複しています: ${id}`);
      seen.add(id);
    }
  };
  dup(model.elements.map((e) => e.id), "要素");
  dup(model.relations.map((r) => r.id), "関係");
  dup(model.boards.map((b) => b.id), "ボード");
  // 要素・関係・ボードをまたいだ重複 (同じ種類の中の重複は上で報告済み)
  const owner = new Map<string, string>();
  const crossReported = new Set<string>();
  const collect = (ids: string[], what: string) => {
    for (const id of new Set(ids)) {
      const prev = owner.get(id);
      if (prev !== undefined && prev !== what && !crossReported.has(id)) {
        crossReported.add(id);
        errors.push(`id「${id}」が${prev}と${what}の両方で使われています`);
      }
      if (prev === undefined) owner.set(id, what);
    }
  };
  collect(model.elements.map((e) => e.id), "要素");
  collect(model.relations.map((r) => r.id), "関係");
  collect(model.boards.map((b) => b.id), "ボード");

  const byId = new Map<string, Element>();
  for (const e of model.elements) if (!byId.has(e.id)) byId.set(e.id, e);

  // BUC / アクティビティ
  const defaultCount = new Map<string, number>();
  for (const e of model.elements) {
    if (e.kind === "buc") {
      const biz = byId.get(e.businessId);
      if (!biz) errors.push(`${label(e)} の業務 ${e.businessId} が存在しません`);
      else if (biz.kind !== "business") errors.push(`${label(e)} の businessId ${e.businessId} は業務ではありません`);
      if (e.isDefault) defaultCount.set(e.businessId, (defaultCount.get(e.businessId) ?? 0) + 1);
    }
    if (e.kind === "activity" && e.bucId !== null) {
      const buc = byId.get(e.bucId);
      if (!buc) errors.push(`${label(e)} の BUC ${e.bucId} が存在しません`);
      else if (buc.kind !== "buc") errors.push(`${label(e)} の bucId ${e.bucId} は BUC ではありません`);
    }
  }
  for (const e of model.elements) {
    if (e.kind === "buc" && e.isDefault) {
      const biz = byId.get(e.businessId);
      if (biz && biz.kind === "business" && biz.name !== e.name) {
        errors.push(`${label(e)} の名前が業務名「${biz.name}」と一致しません (既定 BUC は業務名と同じにします)`);
      }
    }
    if (e.kind !== "business") continue;
    const n = defaultCount.get(e.id) ?? 0;
    if (n !== 1) errors.push(`${label(e)} の既定 BUC が ${n} 個あります (ちょうど 1 個必要です)`);
  }

  // 課題の対象
  for (const e of model.elements) {
    if (e.kind !== "issue") continue;
    for (const tid of e.targetIds) {
      const t = byId.get(tid);
      if (!t) errors.push(`${label(e)} の対象 ${tid} が存在しません`);
      else if (!isIssueTargetKind(t.kind)) errors.push(`${label(e)} の対象 ${label(t)} は業務・アクティビティ・ユースケースではありません`);
    }
  }

  // 関係
  model.relations.forEach((r, i) => {
    const s = byId.get(r.sourceId);
    const t = byId.get(r.targetId);
    if (!s) errors.push(`関係 ${r.id} の始点 ${r.sourceId} が存在しません`);
    if (!t) errors.push(`関係 ${r.id} の終点 ${r.targetId} が存在しません`);
    if (r.sourceId === r.targetId) errors.push(`関係 ${r.id} が自己参照です`);
    if (s && t) {
      const expected = relationKindFor(s.kind, t.kind);
      if (expected === null) {
        errors.push(`関係 ${r.id} の両端 (${ELEMENT_KIND_LABELS[s.kind]} → ${ELEMENT_KIND_LABELS[t.kind]}) は線で結べません`);
      } else if (expected !== r.kind) {
        errors.push(`関係 ${r.id} の kind「${r.kind}」が両端の種類から決まる「${expected}」と一致しません`);
      }
    }
    for (let j = 0; j < i; j++) {
      if (sameRelation(model.relations[j], r)) {
        errors.push(`関係 ${r.id} は ${model.relations[j].id} と重複しています`);
        break;
      }
    }
  });

  // ボード
  for (const board of model.boards) {
    const seen = new Set<string>();
    for (const n of board.nodes) {
      const el = byId.get(n.elementId);
      if (!el) {
        errors.push(`ボード「${board.name}」のノードの要素 ${n.elementId} が存在しません`);
        continue;
      }
      if (seen.has(n.elementId)) errors.push(`ボード「${board.name}」に ${label(el)} が複数回置かれています`);
      seen.add(n.elementId);
      if ((el.kind === "business" || el.kind === "buc") && (n.width === undefined || n.height === undefined)) {
        errors.push(`ボード「${board.name}」の ${label(el)} のノードには width と height が必要です`);
      }
      if (el.kind === "issue") errors.push(`ボード「${board.name}」に課題 ${label(el)} が置かれています`);
      if (el.kind === "buc" && el.isDefault) errors.push(`ボード「${board.name}」に既定 BUC ${label(el)} が置かれています`);
    }
  }

  return errors;
}

/** スキーマ検証に続けて参照整合性を検査する */
export function validateModel(json: unknown): ValidationResult {
  if (!validateSchema(json)) {
    const errors = summarizeSchemaErrors(json, validateSchema.errors ?? []);
    return { ok: false, errors: errors.length > 0 ? errors : ["スキーマに合いません"] };
  }
  const model = json as unknown as UntieModel;
  const errors = checkIntegrity(model);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, model };
}
