// コンテキストの所属についての純粋関数。
// コンテキストは役割の同じ情報と、それに関係の深い状態・条件・バリエーションをまとめたもの (RDRA のコンテキスト)。
// 所属は人が決める。ここでは関係から候補を出し、所属がつながりと合っていないものを知らせる。
import { isContextMemberKind, type Element, type UntieModel } from "./types";

const contextOf = (e: Element | undefined): string | null =>
  e && isContextMemberKind(e.kind) && "contextId" in e ? e.contextId : null;

/**
 * 要素がつながっているコンテキストの重み。直接つながる所属要素は 2、操作を介した情報は 1。
 * - 条件: 判断に使う操作の情報 (1)、参照する状態・バリエーション (2)
 * - バリエーション: 種別にしている情報・条件 (2)
 * - 状態: 結んだ操作の情報 (1)、状態を参照する条件 (2)。状態グループは全員分を足す
 * - 情報: 関連する情報・種別のバリエーション (2)
 */
export function contextScores(model: UntieModel, elementId: string): Map<string, number> {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const self = byId.get(elementId);
  const scores = new Map<string, number>();
  if (!self || !isContextMemberKind(self.kind)) return scores;
  const ids = new Set(
    self.kind === "state" && self.group
      ? model.elements.filter((e) => e.kind === "state" && e.group === self.group).map((e) => e.id)
      : [self.id],
  );
  const add = (ctx: string | null, w: number) => {
    if (ctx) scores.set(ctx, (scores.get(ctx) ?? 0) + w);
  };
  const infosOfUsecase = (ucId: string) =>
    model.relations.filter((r) => r.kind === "usecaseInformation" && r.sourceId === ucId).map((r) => byId.get(r.targetId));

  for (const r of model.relations) {
    const out = ids.has(r.sourceId);
    const inc = ids.has(r.targetId);
    if (!out && !inc) continue;
    const other = byId.get(out ? r.targetId : r.sourceId);
    if (!other || ids.has(other.id)) continue;
    if (other.kind === "usecase") {
      // 操作を介して、その操作が扱う情報のコンテキストへ
      for (const info of infosOfUsecase(other.id)) add(contextOf(info), 1);
    } else if (isContextMemberKind(other.kind)) {
      add(contextOf(other), 2);
    }
  }
  return scores;
}

/** 関係から見た所属の候補 (いちばん重いコンテキスト)。同点なら要素の並び順で先のもの */
export function suggestContext(model: UntieModel, elementId: string): string | null {
  const scores = contextScores(model, elementId);
  let best: string | null = null;
  let bestScore = 0;
  for (const ctx of model.elements.filter((e) => e.kind === "context")) {
    const s = scores.get(ctx.id) ?? 0;
    if (s > bestScore) {
      best = ctx.id;
      bestScore = s;
    }
  }
  return best;
}

export interface ContextNotice {
  elementId: string;
  type: "unassigned" | "mismatch";
  /** 候補のコンテキスト */
  suggestedId: string | null;
  message: string;
}

/**
 * 所属の見直し候補 (検証の [情報])。エラーではなく気づきとして出す。
 * - unassigned: コンテキストに属していない
 * - mismatch: 状態・条件・バリエーションが、属するコンテキストの要素とつながらず、別のコンテキストの要素とだけつながっている
 *   (情報どうしの関連はコンテキストの結合そのものなので、情報は対象にしない)
 * 状態グループは代表の 1 件だけを出す。
 */
export function contextNotices(model: UntieModel): ContextNotice[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const name = (id: string | null) => (id ? byId.get(id)?.name || "(名前なし)" : "");
  const seenGroups = new Set<string>();
  const notices: ContextNotice[] = [];
  for (const e of model.elements) {
    if (!isContextMemberKind(e.kind) || !("contextId" in e)) continue;
    if (e.kind === "state" && e.group) {
      if (seenGroups.has(e.group)) continue;
      seenGroups.add(e.group);
    }
    const suggestedId = suggestContext(model, e.id);
    const what = e.kind === "state" && e.group ? `状態グループ「${e.group}」は` : "";
    if (e.contextId === null) {
      notices.push({
        elementId: e.id,
        type: "unassigned",
        suggestedId,
        message: `${what}コンテキストに属していません。${suggestedId ? `つながりから見ると「${name(suggestedId)}」が候補です。` : ""}`,
      });
      continue;
    }
    if (e.kind === "information" || !suggestedId) continue;
    const scores = contextScores(model, e.id);
    if ((scores.get(e.contextId) ?? 0) === 0) {
      notices.push({
        elementId: e.id,
        type: "mismatch",
        suggestedId,
        message: `${what}「${name(e.contextId)}」の要素とつながっておらず、「${name(suggestedId)}」の要素とつながっています。所属を見直す候補です。`,
      });
    }
  }
  return notices;
}
