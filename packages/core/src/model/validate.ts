// スキーマ検証 (ajv, 2020-12) + 参照整合性の検査。
import type { ErrorObject } from "ajv";
// 検証関数は事前に生成しておく (アプリの CSP が eval を許さないため、実行時に ajv.compile() できない)
import * as generated from "./schemaValidator.gen.js";
import { inspectDomain } from "./domain";
import { relationKindFor, sameRelation } from "./relations";
import { ELEMENT_KIND_LABELS, ELEMENT_KINDS, isContextMemberKind, isIssueTargetKind, issueScopeOfKind } from "./types";
import type { Element, UntieModel } from "./types";

export type ValidationResult = { ok: true; model: UntieModel } | { ok: false; errors: string[] };

type Validator = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
const validators = generated as unknown as Record<string, Validator | undefined>;
const validateSchema = validators.validateModelSchema!;

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
function elementValidator(kind: string): Validator | undefined {
  return validators[`validate_${kind}`];
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

/**
 * 要素 1 つがスキーマ (種類ごとの形) に合うか。参照整合性は見ない。
 * 同時編集で Y.Doc から組み立てるとき、形の壊れた要素 (項目が欠けた課題など) を外すのに使う。
 */
export function isValidElementShape(json: unknown): json is Element {
  const kind = (json as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !(ELEMENT_KINDS as readonly string[]).includes(kind)) return false;
  const validate = elementValidator(kind);
  return validate !== undefined && validate(json);
}

/** 設計データの部品 (スキーマの $defs) */
export type DesignPartKind = "designScreen" | "transition" | "layout" | "navGroup" | "database" | DomainPartKind;

/** ドメインモデルの部品 (スキーマの $defs。0.6.0) */
export type DomainPartKind = "boundedContext" | "aggregate" | "domainCommand" | "domainEvent" | "domainPolicy" | "contextRelation" | "domainTerm";

/**
 * 設計データの部品 1 つがスキーマに合うか。参照整合性は見ない。
 * 同時編集で Y.Doc から読むとき、形の壊れた画面・遷移・ナビ・データベースを読み飛ばすのに使う (isValidElementShape と同じ流儀)
 */
export function isValidDesignShape(kind: DesignPartKind, json: unknown): boolean {
  const validate = validators[`validateDef_${kind}`];
  return validate !== undefined && validate(json);
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

  // BUC / アクティビティ / 情報のコンテキスト
  const defaultCount = new Map<string, number>();
  for (const e of model.elements) {
    if (e.kind === "buc") {
      const biz = byId.get(e.businessId);
      if (!biz) errors.push(`${label(e)} の業務 ${e.businessId} が存在しません`);
      else if (biz.kind !== "business") errors.push(`${label(e)} の businessId ${e.businessId} は業務ではありません`);
      if (e.isDefault) defaultCount.set(e.businessId, (defaultCount.get(e.businessId) ?? 0) + 1);
    }
    if ((e.kind === "activity" || e.kind === "usecase") && e.hours !== undefined && Math.abs(Math.round(e.hours * 10) - e.hours * 10) > 1e-6) {
      errors.push(`${label(e)} の時間 ${e.hours} は小数点第一位までにしてください`);
    }
    if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId !== null) {
      const ctx = byId.get(e.contextId);
      if (!ctx) errors.push(`${label(e)} のコンテキスト ${e.contextId} が存在しません`);
      else if (ctx.kind !== "context") errors.push(`${label(e)} の contextId ${e.contextId} はコンテキストではありません`);
    }
    if ((e.kind === "screen" || e.kind === "nfr") && "systemId" in e) {
      const sys = byId.get(e.systemId);
      if (!sys) errors.push(`${label(e)} のシステム ${e.systemId} が存在しません`);
      else if (sys.kind !== "system") errors.push(`${label(e)} の systemId ${e.systemId} はシステムではありません`);
    }
    if (e.kind === "activity" && e.bucId !== null) {
      const buc = byId.get(e.bucId);
      if (!buc) errors.push(`${label(e)} の活動 ${e.bucId} が存在しません`);
      else if (buc.kind !== "buc") errors.push(`${label(e)} の bucId ${e.bucId} は活動ではありません`);
    }
  }
  for (const e of model.elements) {
    if (e.kind === "buc" && e.isDefault) {
      const biz = byId.get(e.businessId);
      if (biz && biz.kind === "business" && biz.name !== e.name) {
        errors.push(`${label(e)} の名前が業務名「${biz.name}」と一致しません (既定の活動は業務名と同じにします)`);
      }
    }
    if (e.kind !== "business") continue;
    const n = defaultCount.get(e.id) ?? 0;
    if (n !== 1) errors.push(`${label(e)} の既定の活動が ${n} 個あります (ちょうど 1 個必要です)`);
  }

  // 課題の対象
  for (const e of model.elements) {
    if (e.kind !== "issue") continue;
    const scopes = new Set<string>();
    for (const tid of e.targetIds) {
      const t = byId.get(tid);
      if (!t) errors.push(`${label(e)} の対象 ${tid} が存在しません`);
      else if (!isIssueTargetKind(t.kind)) errors.push(`${label(e)} の対象 ${label(t)} は登場人物・業務・作業・操作・画面ではありません`);
      else scopes.add(issueScopeOfKind(t.kind));
    }
    if (scopes.size > 1) errors.push(`${label(e)} の対象に、登場人物と業務・作業・操作・画面が混ざっています (全体的な課題と具体的な課題は分けてください)`);
  }

  // 操作の対象 (システム・帳票・画面) は 1 本まで (0.3.0)
  const targetCount = new Map<string, number>();
  for (const r of model.relations) {
    if (r.kind === "usecaseSystem" || r.kind === "usecaseScreen") targetCount.set(r.sourceId, (targetCount.get(r.sourceId) ?? 0) + 1);
  }
  for (const [ucId, n] of targetCount) {
    const uc = byId.get(ucId);
    if (uc && n > 1) errors.push(`${label(uc)} の対象 (システム・帳票・画面) が ${n} つあります (1 つだけにしてください)`);
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
    // 取得・保存の区別 (access) は、操作が扱う情報の関係にだけ付けられる (0.4.0)
    if (r.access !== undefined && r.kind !== "usecaseInformation") errors.push(`関係 ${r.id} (${r.kind}) に access が付いています (usecaseInformation だけに付けられます)`);
    for (let j = 0; j < i; j++) {
      if (sameRelation(model.relations[j], r)) {
        errors.push(`関係 ${r.id} は ${model.relations[j].id} と重複しています`);
        break;
      }
    }
  });

  // ボード
  const relationIds = new Set(model.relations.map((r) => r.id));
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
      if (el.kind === "buc" && el.isDefault) errors.push(`ボード「${board.name}」に既定の活動 ${label(el)} が置かれています`);
    }
    const seenEdges = new Set<string>();
    for (const e of board.edges ?? []) {
      if (!relationIds.has(e.relationId)) errors.push(`ボード「${board.name}」の線の関係 ${e.relationId} が存在しません`);
      if (seenEdges.has(e.relationId)) errors.push(`ボード「${board.name}」に関係 ${e.relationId} の線の設定が複数あります`);
      seenEdges.add(e.relationId);
    }
  }

  errors.push(...checkDesignIntegrity(model, byId));
  // ドメインモデル (0.6.0) の参照整合性。規則は domain.ts の inspectDomain (修復と同じ)
  for (const p of inspectDomain(model.domain, model.elements).problems) errors.push(`ドメインモデルの${p.what}`);

  return errors;
}

/** 設計データ (designs・databases。0.5.0) の参照整合性 */
function checkDesignIntegrity(model: UntieModel, byId: ReadonlyMap<string, Element>): string[] {
  const errors: string[] = [];
  const databaseIds = new Set<string>();
  for (const db of model.databases) {
    if (databaseIds.has(db.id)) errors.push(`データベースの id が重複しています: ${db.id}`);
    databaseIds.add(db.id);
    for (const table of db.tables) {
      for (const infoId of table.informationIds) {
        const info = byId.get(infoId);
        if (!info) errors.push(`データベース「${db.name}」のテーブル「${table.table}」の情報 ${infoId} が存在しません`);
        else if (info.kind !== "information") errors.push(`データベース「${db.name}」のテーブル「${table.table}」の ${infoId} は情報ではありません`);
      }
    }
  }
  const seenSystems = new Set<string>();
  // 画面・遷移・ナビゲーションのグループの id は、設計をまたいで一意 (同時編集で 1 つの Y.Map に置くため)
  const seenScreens = new Set<string>();
  const seenTransitions = new Set<string>();
  const seenGroups = new Set<string>();
  for (const design of model.designs) {
    const sys = byId.get(design.systemId);
    const where = sys ? `設計「${sys.name}」(${design.systemId})` : `設計 (システム ${design.systemId})`;
    if (!sys) errors.push(`${where} のシステムが存在しません`);
    else if (sys.kind !== "system") errors.push(`${where} の systemId はシステムではありません`);
    if (seenSystems.has(design.systemId)) errors.push(`${where} が複数あります (システムごとに 1 つだけです)`);
    seenSystems.add(design.systemId);
    for (const dbId of design.databaseIds) if (!databaseIds.has(dbId)) errors.push(`${where} のデータベース ${dbId} が存在しません`);

    const screenIds = new Set<string>();
    for (const s of design.screens) {
      if (seenScreens.has(s.id)) errors.push(`${where} の画面の id が重複しています: ${s.id}`);
      seenScreens.add(s.id);
      screenIds.add(s.id);
      if (s.source.kind === "screen") {
        const screen = byId.get(s.source.screenId);
        if (!screen) errors.push(`${where} の画面 ${s.id} が指す画面 ${s.source.screenId} が存在しません`);
        else if (screen.kind !== "screen") errors.push(`${where} の画面 ${s.id} が指す ${s.source.screenId} は画面ではありません`);
        else if (screen.systemId !== design.systemId) errors.push(`${where} の画面 ${s.id} が指す画面 ${s.source.screenId} は別のシステムの画面です`);
      }
      for (const b of s.bindings ?? []) {
        if (!databaseIds.has(b.databaseId)) errors.push(`${where} の画面 ${s.id} の対応のデータベース ${b.databaseId} が存在しません`);
      }
    }
    for (const t of design.transitions) {
      if (seenTransitions.has(t.id)) errors.push(`${where} の遷移の id が重複しています: ${t.id}`);
      seenTransitions.add(t.id);
      if (!screenIds.has(t.from)) errors.push(`${where} の遷移 ${t.id} の遷移元 ${t.from} が、この設計の画面にありません`);
      if (!screenIds.has(t.to)) errors.push(`${where} の遷移 ${t.id} の遷移先 ${t.to} が、この設計の画面にありません`);
    }
    for (const group of design.layout.navigation) {
      if (seenGroups.has(group.id)) errors.push(`${where} のナビゲーションのグループの id が重複しています: ${group.id}`);
      seenGroups.add(group.id);
      for (const item of group.items) {
        if (!screenIds.has(item.screenId)) errors.push(`${where} のナビゲーション「${group.group}」の画面 ${item.screenId} が、この設計の画面にありません`);
      }
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
