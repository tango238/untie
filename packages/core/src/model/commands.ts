// モデルを変える純粋関数 (設計書 6 章)。
// すべて (model, payload) => 結果 の形で、失敗は例外ではなく { ok: false, reason } で返す。
import { produce } from "immer";
import { newUniqueId } from "./id";
import { relationKindFor, sameRelation } from "./relations";
import {
  DEFAULT_EDGE_SIDES,
  EDGE_SIDES,
  isFrameKind,
  isContextMemberKind,
  isIssueTargetKind,
  ISSUE_ANALYSIS_KEYS,
  issueScopeOfKind,
  type Buc,
  type EdgeSide,
  type Element,
  type ElementKind,
  type IssueAnalysis,
  type Link,
  type UntieModel,
} from "./types";

export interface Fail {
  ok: false;
  reason: string;
}
export type Ok<T = unknown> = { ok: true; model: UntieModel } & T;
export type CommandResult<T = unknown> = Ok<T> | Fail;

export interface Position {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

/** 枠でない要素 (カード) の表示サイズ。UI のカードの大きさと一致させる */
export const DEFAULT_CARD_SIZE: Size = { width: 168, height: 64 };

/** 枠 (業務・BUC) をボードに置くときの既定サイズ */
export const DEFAULT_FRAME_SIZE: Record<"business" | "buc", Size> = {
  business: { width: 480, height: 320 },
  buc: { width: 240, height: 200 },
};

/** 種類ごとに追加時に指定できる初期値 */
export interface ElementInit {
  description?: string;
  /** information / state / condition / variation (所属コンテキスト。省略時は未分類) */
  contextId?: string | null;
  /** state */
  group?: string;
  /** variation */
  values?: string[];
  /** issue */
  severity?: number;
  targetIds?: string[];
  /** buc (必須) */
  businessId?: string;
  /** activity */
  bucId?: string | null;
}

/** updateElement で変えられる項目 */
export interface ElementPatch {
  name?: string;
  description?: string;
  /** activity / usecase */
  links?: Link[];
  /** activity / usecase。かかる時間 (時間単位、小数点第一位まで)。null で消す */
  hours?: number | null;
  group?: string;
  values?: string[];
  severity?: number;
  targetIds?: string[];
  /** issue。分析 (現象・所在・理由・影響)。指定した項目だけ変わり、空文字で消す。null で分析全体を消す */
  analysis?: Partial<IssueAnalysis> | null;
}

const PATCH_KEYS_BY_KIND: Record<ElementKind, readonly (keyof ElementPatch)[]> = {
  actor: [],
  externalActor: [],
  system: [],
  ledger: [],
  business: [],
  buc: [],
  activity: ["links", "hours"],
  usecase: ["links", "hours"],
  context: [],
  information: [],
  state: ["group"],
  variation: ["values"],
  condition: [],
  issue: ["severity", "targetIds", "analysis"],
};

const fail = (reason: string): Fail => ({ ok: false, reason });

function findElement(model: UntieModel, id: string): Element | undefined {
  return model.elements.find((e) => e.id === id);
}

function usedIds(model: UntieModel): Set<string> {
  const used = new Set<string>();
  for (const e of model.elements) used.add(e.id);
  for (const r of model.relations) used.add(r.id);
  for (const b of model.boards) used.add(b.id);
  return used;
}

function isFinitePoint(p: Position): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function isValidSize(s: Size): boolean {
  return Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= 1 && s.height >= 1;
}

/** 課題の対象 id 一覧を検査する。問題があれば理由を返す */
function checkIssueTargets(model: UntieModel, targetIds: readonly string[]): string | null {
  const scopes = new Set<string>();
  for (const id of targetIds) {
    const t = findElement(model, id);
    if (!t) return `課題の対象が存在しません: ${id}`;
    if (!isIssueTargetKind(t.kind)) return "課題の対象にできるのは登場人物 (アクター・外部アクター・システム・帳票)・業務・作業・操作だけです";
    scopes.add(issueScopeOfKind(t.kind));
  }
  // 全体的な課題 (登場人物) と具体的な課題 (業務・作業・操作) は分けて扱う
  if (scopes.size > 1) return ISSUE_SCOPE_MIX_REASON;
  return null;
}

export const ISSUE_SCOPE_MIX_REASON =
  "全体的な課題 (登場人物が対象) と具体的な課題 (業務・作業・操作が対象) の対象は混ぜられません。付け替えるときは、いまの対象を外してから追加してください";

function checkSeverity(severity: number): string | null {
  return Number.isInteger(severity) && severity >= 1 && severity <= 5 ? null : "重要度は 1〜5 の整数にしてください";
}

/** 時間は 0 以上で、小数点第一位まで */
export function checkHours(hours: number): string | null {
  if (!Number.isFinite(hours) || hours < 0 || hours > 100000) return "時間は 0 以上の数で入力してください";
  if (Math.abs(Math.round(hours * 10) - hours * 10) > 1e-6) return "時間は小数点第一位まで入力してください";
  return null;
}

function checkLinks(links: Link[]): string | null {
  for (const l of links) {
    if (!/^https?:\/\//.test(l.url.trim())) return `リンクの URL は http:// か https:// で始めてください: ${l.url}`;
  }
  return null;
}

/** 削除した要素への参照を、関係・ボードのノード・課題の対象から掃除する */
function sweepReferences(draft: UntieModel, removed: ReadonlySet<string>): void {
  draft.relations = draft.relations.filter((r) => !removed.has(r.sourceId) && !removed.has(r.targetId));
  for (const board of draft.boards) {
    board.nodes = board.nodes.filter((n) => !removed.has(n.elementId));
  }
  for (const e of draft.elements) {
    if (e.kind === "issue") e.targetIds = e.targetIds.filter((id) => !removed.has(id));
  }
}

// ---------------------------------------------------------------- 要素

export interface AddElementPayload {
  kind: ElementKind;
  name: string;
  /** 指定するとそのボードに置く (課題は置けない) */
  boardId?: string;
  position?: Position;
  /** 枠の初期サイズ (省略時は既定) */
  size?: Size;
  init?: ElementInit;
  /** テスト用などで id を固定する */
  id?: string;
}

/** 要素を作る。業務なら既定 BUC も作る。boardId があればそのボードに置く */
export function addElement(model: UntieModel, payload: AddElementPayload): CommandResult<{ id: string }> {
  const { kind, boardId, init = {} } = payload;
  const name = payload.name.trim();

  if (boardId !== undefined) {
    if (!model.boards.some((b) => b.id === boardId)) return fail(`ボードが存在しません: ${boardId}`);
    if (kind === "issue") return fail("課題はボードに置けません");
  }
  if (payload.position && !isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);

  if (kind === "buc") {
    const biz = init.businessId ? findElement(model, init.businessId) : undefined;
    if (!biz || biz.kind !== "business") return fail("活動には所属する業務が必要です");
  }
  if (kind === "activity" && init.bucId) {
    const buc = findElement(model, init.bucId);
    if (!buc || buc.kind !== "buc") return fail(`所属先の活動が存在しません: ${init.bucId}`);
  }
  if (isContextMemberKind(kind) && init.contextId) {
    const ctx = findElement(model, init.contextId);
    if (!ctx || ctx.kind !== "context") return fail(`所属先のコンテキストが存在しません: ${init.contextId}`);
  }
  if (kind === "issue") {
    const reason = checkIssueTargets(model, init.targetIds ?? []);
    if (reason) return fail(reason);
    if (init.severity !== undefined) {
      const sev = checkSeverity(init.severity);
      if (sev) return fail(sev);
    }
  }

  const used = usedIds(model);
  const id = payload.id ?? newUniqueId(kind, used);
  used.add(id);
  const description = init.description === undefined || init.description === "" ? {} : { description: init.description };

  let element: Element;
  switch (kind) {
    case "actor":
    case "externalActor":
    case "business":
    case "usecase":
    case "context":
    case "system":
    case "ledger":
      element = { id, kind, name, ...description };
      break;
    case "condition":
      element = { id, kind, name, contextId: init.contextId ?? null, ...description };
      break;
    case "buc":
      element = { id, kind, name, businessId: init.businessId!, isDefault: false, ...description };
      break;
    case "activity":
      element = { id, kind, name, bucId: init.bucId ?? null, ...description };
      break;
    case "information":
      element = { id, kind, name, contextId: init.contextId ?? null, ...description };
      break;
    case "state":
      element = {
        id,
        kind,
        name,
        // 状態グループごとに同じコンテキストに属するので、同じグループの状態に合わせる
        contextId: init.contextId ?? (init.group ? stateGroupContext(model, init.group) : null),
        ...description,
        ...(init.group ? { group: init.group } : {}),
      };
      break;
    case "variation":
      element = { id, kind, name, values: [...(init.values ?? [])], contextId: init.contextId ?? null, ...description };
      break;
    case "issue":
      element = {
        id,
        kind,
        name,
        severity: init.severity ?? 3,
        targetIds: [...new Set(init.targetIds ?? [])],
        ...description,
      };
      break;
  }

  const defaultBucId = kind === "business" ? newUniqueId("buc", used) : null;

  const next = produce(model, (draft) => {
    draft.elements.push(element);
    if (defaultBucId) {
      draft.elements.push({ id: defaultBucId, kind: "buc", name, businessId: id, isDefault: true });
    }
    if (boardId !== undefined) {
      const board = draft.boards.find((b) => b.id === boardId)!;
      const pos = payload.position ?? { x: 0, y: 0 };
      const size = isFrameKind(kind) ? (payload.size ?? DEFAULT_FRAME_SIZE[kind]) : payload.size;
      board.nodes.push({ elementId: id, x: pos.x, y: pos.y, ...(size ?? {}) });
    }
  });
  return { ok: true, model: next, id };
}

export interface UpdateElementPayload {
  id: string;
  patch: ElementPatch;
}

/** 名前・説明・種類固有の項目を変える。所属 (bucId / businessId / contextId) は moveActivity / moveBuc / moveInformation で変える */
export function updateElement(model: UntieModel, payload: UpdateElementPayload): CommandResult {
  const target = findElement(model, payload.id);
  if (!target) return fail(`要素が存在しません: ${payload.id}`);
  const patch = payload.patch;

  if (target.kind === "buc" && target.isDefault && patch.name !== undefined) {
    return fail("既定の活動の名前は業務の名前と同じで、直接は変えられません");
  }

  const allowed = new Set<string>(["name", "description", ...PATCH_KEYS_BY_KIND[target.kind]]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return fail(`この要素では「${key}」を変更できません`);
  }
  if (patch.links !== undefined) {
    const reason = checkLinks(patch.links);
    if (reason) return fail(reason);
  }
  if (patch.hours !== undefined && patch.hours !== null) {
    const reason = checkHours(patch.hours);
    if (reason) return fail(reason);
  }
  if (patch.severity !== undefined) {
    const reason = checkSeverity(patch.severity);
    if (reason) return fail(reason);
  }
  if (patch.targetIds !== undefined) {
    const reason = checkIssueTargets(model, patch.targetIds);
    if (reason) return fail(reason);
  }

  const next = produce(model, (draft) => {
    const el = draft.elements.find((e) => e.id === payload.id)!;
    if (patch.name !== undefined) {
      el.name = patch.name.trim();
      // 既定 BUC の名前は業務名と同じに保つ
      if (el.kind === "business") {
        const def = draft.elements.find((e) => e.kind === "buc" && e.isDefault && e.businessId === el.id);
        if (def) def.name = el.name;
      }
    }
    if (patch.description !== undefined) {
      if (patch.description === "") delete el.description;
      else el.description = patch.description;
    }
    if (el.kind === "state" && patch.group !== undefined) {
      if (patch.group === "") delete el.group;
      else {
        el.group = patch.group;
        // 既にあるグループへ移したら、そのグループのコンテキストに合わせる
        const other = model.elements.find((e) => e.kind === "state" && e.group === patch.group && e.id !== el.id);
        if (other && other.kind === "state") el.contextId = other.contextId;
      }
    }
    if (el.kind === "variation" && patch.values !== undefined) el.values = [...patch.values];
    if ((el.kind === "activity" || el.kind === "usecase") && patch.hours !== undefined) {
      if (patch.hours === null) delete el.hours;
      else el.hours = Math.round(patch.hours * 10) / 10;
    }
    if ((el.kind === "activity" || el.kind === "usecase") && patch.links !== undefined) {
      const links = patch.links.map((l) => ({ title: l.title.trim() || l.url.trim(), url: l.url.trim() }));
      if (links.length === 0) delete el.links;
      else el.links = links;
    }
    if (el.kind === "issue") {
      if (patch.severity !== undefined) el.severity = patch.severity;
      if (patch.targetIds !== undefined) el.targetIds = [...new Set(patch.targetIds)];
      if (patch.analysis === null) delete el.analysis;
      else if (patch.analysis !== undefined) {
        const analysis: IssueAnalysis = { ...el.analysis };
        for (const key of ISSUE_ANALYSIS_KEYS) {
          const v = patch.analysis[key];
          if (v === undefined) continue;
          if (v.trim() === "") delete analysis[key];
          else analysis[key] = v.trim();
        }
        if (Object.keys(analysis).length === 0) delete el.analysis;
        else el.analysis = analysis;
      }
    }
  });
  return { ok: true, model: next };
}

export interface RemoveElementPayload {
  id: string;
}

/** 要素と付随するもの (関係・ボードのノード・課題の対象・業務なら BUC) を消す */
export function removeElement(model: UntieModel, payload: RemoveElementPayload): CommandResult {
  const target = findElement(model, payload.id);
  if (!target) return fail(`要素が存在しません: ${payload.id}`);
  if (target.kind === "buc" && target.isDefault) return fail("既定の活動は削除できません");

  const next = produce(model, (draft) => {
    const removed = new Set<string>([payload.id]);

    if (target.kind === "business") {
      // 業務を消すと BUC は全て消え、所属アクティビティは未所属になる
      const bucIds = new Set(draft.elements.filter((e) => e.kind === "buc" && e.businessId === target.id).map((e) => e.id));
      for (const id of bucIds) removed.add(id);
      for (const e of draft.elements) {
        if (e.kind === "activity" && e.bucId && bucIds.has(e.bucId)) e.bucId = null;
      }
    } else if (target.kind === "context") {
      // コンテキストを消すと、所属していた要素は未分類になる
      for (const e of draft.elements) {
        if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId === target.id) e.contextId = null;
      }
    } else if (target.kind === "buc") {
      // 既定でない BUC を消すと、所属アクティビティは業務の既定 BUC に戻る
      const def = draft.elements.find(
        (e): e is Buc => e.kind === "buc" && e.isDefault && e.businessId === target.businessId,
      );
      for (const e of draft.elements) {
        if (e.kind === "activity" && e.bucId === target.id) e.bucId = def ? def.id : null;
      }
    }

    draft.elements = draft.elements.filter((e) => !removed.has(e.id));
    sweepReferences(draft, removed);
  });
  return { ok: true, model: next };
}

export interface MoveActivityPayload {
  activityId: string;
  /** null で未所属 */
  bucId: string | null;
}

/** アクティビティの所属 BUC を変える */
export function moveActivity(model: UntieModel, payload: MoveActivityPayload): CommandResult {
  const act = findElement(model, payload.activityId);
  if (!act || act.kind !== "activity") return fail(`作業が存在しません: ${payload.activityId}`);
  if (payload.bucId !== null) {
    const buc = findElement(model, payload.bucId);
    if (!buc || buc.kind !== "buc") return fail(`活動が存在しません: ${payload.bucId}`);
  }
  if (act.bucId === payload.bucId) return { ok: true, model };
  const next = produce(model, (draft) => {
    const a = draft.elements.find((e) => e.id === payload.activityId);
    if (a && a.kind === "activity") a.bucId = payload.bucId;
  });
  return { ok: true, model: next };
}

export interface MoveToContextPayload {
  /** 情報・状態・条件・バリエーション */
  elementId: string;
  /** null は未分類 */
  contextId: string | null;
}

/** 同じ状態グループの状態が属しているコンテキスト (無ければ null) */
function stateGroupContext(model: UntieModel, group: string): string | null {
  for (const e of model.elements) if (e.kind === "state" && e.group === group) return e.contextId;
  return null;
}

/**
 * 要素の所属コンテキストを変える。状態は状態グループごとに属するので、同じグループの状態もまとめて移す
 */
export function moveToContext(model: UntieModel, payload: MoveToContextPayload): CommandResult {
  const target = findElement(model, payload.elementId);
  if (!target || !isContextMemberKind(target.kind)) return fail(`コンテキストに属せない要素です: ${payload.elementId}`);
  if (payload.contextId !== null) {
    const ctx = findElement(model, payload.contextId);
    if (!ctx || ctx.kind !== "context") return fail(`コンテキストが存在しません: ${payload.contextId}`);
  }
  const group = target.kind === "state" ? target.group : undefined;
  const ids = new Set(
    group ? model.elements.filter((e) => e.kind === "state" && e.group === group).map((e) => e.id) : [target.id],
  );
  const members = model.elements.filter((e) => ids.has(e.id));
  if (members.every((e) => "contextId" in e && e.contextId === payload.contextId)) return { ok: true, model };
  const next = produce(model, (draft) => {
    for (const e of draft.elements) {
      if (ids.has(e.id) && "contextId" in e) e.contextId = payload.contextId;
    }
  });
  return { ok: true, model: next };
}

export interface MoveBucPayload {
  bucId: string;
  businessId: string;
}

/** BUC の所属業務を変える (所属アクティビティは BUC についていく) */
export function moveBuc(model: UntieModel, payload: MoveBucPayload): CommandResult {
  const buc = findElement(model, payload.bucId);
  if (!buc || buc.kind !== "buc") return fail(`活動が存在しません: ${payload.bucId}`);
  if (buc.isDefault) return fail("既定の活動の業務は変えられません");
  const biz = findElement(model, payload.businessId);
  if (!biz || biz.kind !== "business") return fail(`業務が存在しません: ${payload.businessId}`);
  if (buc.businessId === payload.businessId) return { ok: true, model };
  const next = produce(model, (draft) => {
    const b = draft.elements.find((e) => e.id === payload.bucId);
    if (b && b.kind === "buc") b.businessId = payload.businessId;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 関係

export interface AddRelationPayload {
  sourceId: string;
  targetId: string;
  id?: string;
}

/** 両端の種類から関係の種類を決めて関係を作る。不可なら失敗を返す */
export function addRelation(model: UntieModel, payload: AddRelationPayload): CommandResult<{ id: string }> {
  const { sourceId, targetId } = payload;
  if (sourceId === targetId) return fail("自分自身には線を引けません");
  const source = findElement(model, sourceId);
  const target = findElement(model, targetId);
  if (!source) return fail(`始点の要素が存在しません: ${sourceId}`);
  if (!target) return fail(`終点の要素が存在しません: ${targetId}`);
  const kind = relationKindFor(source.kind, target.kind);
  if (!kind) return fail("この組み合わせの要素は線で結べません");
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);

  const candidate = { kind, sourceId, targetId };
  if (model.relations.some((r) => sameRelation(r, candidate))) return fail("同じ関係がすでにあります");

  const id = payload.id ?? newUniqueId("relation", usedIds(model));
  const next = produce(model, (draft) => {
    draft.relations.push({ id, kind, sourceId, targetId });
  });
  return { ok: true, model: next, id };
}

export interface RemoveRelationPayload {
  id: string;
}

export function removeRelation(model: UntieModel, payload: RemoveRelationPayload): CommandResult {
  if (!model.relations.some((r) => r.id === payload.id)) return fail(`関係が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.relations = draft.relations.filter((r) => r.id !== payload.id);
    // ボードごとの線の見た目も一緒に消す
    for (const b of draft.boards) {
      if (!b.edges) continue;
      b.edges = b.edges.filter((e) => e.relationId !== payload.id);
      if (b.edges.length === 0) delete b.edges;
    }
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- ボード

export interface AddBoardPayload {
  name: string;
  id?: string;
}

export function addBoard(model: UntieModel, payload: AddBoardPayload): CommandResult<{ id: string }> {
  if (payload.id !== undefined && usedIds(model).has(payload.id)) return fail(`id が重複しています: ${payload.id}`);
  const id = payload.id ?? newUniqueId("board", usedIds(model));
  const next = produce(model, (draft) => {
    draft.boards.push({ id, name: payload.name.trim(), nodes: [] });
  });
  return { ok: true, model: next, id };
}

export interface RenameBoardPayload {
  id: string;
  name: string;
}

export function renameBoard(model: UntieModel, payload: RenameBoardPayload): CommandResult {
  if (!model.boards.some((b) => b.id === payload.id)) return fail(`ボードが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.boards.find((b) => b.id === payload.id)!.name = payload.name.trim();
  });
  return { ok: true, model: next };
}

export interface RemoveBoardPayload {
  id: string;
}

/** ボードを消す。最後の 1 枚は消せない。ボード上にあった要素や関係は残る */
export function removeBoard(model: UntieModel, payload: RemoveBoardPayload): CommandResult {
  if (!model.boards.some((b) => b.id === payload.id)) return fail(`ボードが存在しません: ${payload.id}`);
  if (model.boards.length <= 1) return fail("最後の 1 枚のボードは削除できません");
  const next = produce(model, (draft) => {
    draft.boards = draft.boards.filter((b) => b.id !== payload.id) as typeof draft.boards;
  });
  return { ok: true, model: next };
}

export interface PlaceOnBoardPayload {
  boardId: string;
  elementId: string;
  position: Position;
  /** 枠の初期サイズ (省略時は既定) */
  size?: Size;
}

/** 要素をボードに置く。課題と既定 BUC は置けない。同じボードに 2 回は置けない */
export function placeOnBoard(model: UntieModel, payload: PlaceOnBoardPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  const el = findElement(model, payload.elementId);
  if (!el) return fail(`要素が存在しません: ${payload.elementId}`);
  if (el.kind === "issue") return fail("課題はボードに置けません");
  if (el.kind === "buc" && el.isDefault) return fail("既定の活動はボードに置けません");
  if (board.nodes.some((n) => n.elementId === el.id)) return fail("この要素はすでにこのボードにあります");
  if (!isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");

  const size = isFrameKind(el.kind) ? (payload.size ?? DEFAULT_FRAME_SIZE[el.kind]) : payload.size;
  const next = produce(model, (draft) => {
    draft.boards
      .find((b) => b.id === payload.boardId)!
      .nodes.push({ elementId: el.id, x: payload.position.x, y: payload.position.y, ...(size ?? {}) });
  });
  return { ok: true, model: next };
}

export interface RemoveFromBoardPayload {
  boardId: string;
  elementId: string;
}

/** ボードから外す (要素は残る) */
export function removeFromBoard(model: UntieModel, payload: RemoveFromBoardPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!board.nodes.some((n) => n.elementId === payload.elementId)) return fail("この要素はこのボードにありません");
  const next = produce(model, (draft) => {
    const b = draft.boards.find((x) => x.id === payload.boardId)!;
    b.nodes = b.nodes.filter((n) => n.elementId !== payload.elementId);
  });
  return { ok: true, model: next };
}

export interface MoveNodePayload {
  boardId: string;
  elementId: string;
  position: Position;
  size?: Size;
}

/** ノードの座標 (とサイズ) を変える */
export function moveNode(model: UntieModel, payload: MoveNodePayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!board.nodes.some((n) => n.elementId === payload.elementId)) return fail("この要素はこのボードにありません");
  if (!isFinitePoint(payload.position)) return fail("座標が不正です");
  if (payload.size && !isValidSize(payload.size)) return fail("サイズが不正です");
  const next = produce(model, (draft) => {
    const node = draft.boards.find((b) => b.id === payload.boardId)!.nodes.find((n) => n.elementId === payload.elementId)!;
    node.x = payload.position.x;
    node.y = payload.position.y;
    if (payload.size) {
      node.width = payload.size.width;
      node.height = payload.size.height;
    }
  });
  return { ok: true, model: next };
}

export interface SetEdgeSidesPayload {
  boardId: string;
  relationId: string;
  /** 既定 (right) に戻すなら undefined */
  sourceSide?: EdgeSide;
  /** 既定 (left) に戻すなら undefined */
  targetSide?: EdgeSide;
}

/** ボードごとの線の見た目 (どの辺から出て、どの辺に入るか) を変える。両方とも既定なら項目ごと消す */
export function setEdgeSides(model: UntieModel, payload: SetEdgeSidesPayload): CommandResult {
  const board = model.boards.find((b) => b.id === payload.boardId);
  if (!board) return fail(`ボードが存在しません: ${payload.boardId}`);
  if (!model.relations.some((r) => r.id === payload.relationId)) return fail(`関係が存在しません: ${payload.relationId}`);
  for (const side of [payload.sourceSide, payload.targetSide]) {
    if (side !== undefined && !EDGE_SIDES.includes(side)) return fail(`辺が不正です: ${side}`);
  }
  const sourceSide = payload.sourceSide === DEFAULT_EDGE_SIDES.sourceSide ? undefined : payload.sourceSide;
  const targetSide = payload.targetSide === DEFAULT_EDGE_SIDES.targetSide ? undefined : payload.targetSide;
  const next = produce(model, (draft) => {
    const b = draft.boards.find((x) => x.id === payload.boardId)!;
    const rest = (b.edges ?? []).filter((e) => e.relationId !== payload.relationId);
    if (sourceSide !== undefined || targetSide !== undefined) {
      rest.push({
        relationId: payload.relationId,
        ...(sourceSide !== undefined ? { sourceSide } : {}),
        ...(targetSide !== undefined ? { targetSide } : {}),
      });
    }
    if (rest.length > 0) b.edges = rest;
    else delete b.edges;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 課題・全体

export interface SetIssueTargetsPayload {
  issueId: string;
  targetIds: string[];
}

export function setIssueTargets(model: UntieModel, payload: SetIssueTargetsPayload): CommandResult {
  const issue = findElement(model, payload.issueId);
  if (!issue || issue.kind !== "issue") return fail(`課題が存在しません: ${payload.issueId}`);
  const reason = checkIssueTargets(model, payload.targetIds);
  if (reason) return fail(reason);
  const next = produce(model, (draft) => {
    const i = draft.elements.find((e) => e.id === payload.issueId);
    if (i && i.kind === "issue") i.targetIds = [...new Set(payload.targetIds)];
  });
  return { ok: true, model: next };
}

export interface ClearAllPayload {
  /** 空のボードの id (省略時は自動) */
  boardId?: string;
}

/** 要素・関係・ボードを全て消し、空のボード「ボード 1」だけにする (メタ情報は残す) */
export function clearAll(model: UntieModel, payload: ClearAllPayload = {}): CommandResult {
  const next = produce(model, (draft) => {
    draft.elements = [];
    draft.relations = [];
    draft.boards = [{ id: payload.boardId ?? newUniqueId("board", new Set()), name: "ボード 1", nodes: [] }];
  });
  return { ok: true, model: next };
}
