// 壊れた参照の修復 (設計書 6 章)。
// 同時編集では「要素 A を消す」と「A への関係を足す」が両方受け入れられ、合流後に壊れた参照が残りうる。
// validateModel の参照整合性検査と同じ規則で壊れた箇所を見つけ、直したモデルと変更の一覧を返す純粋関数。
//
// 直す規則:
// - 業務が無い (業務でない要素を指す) 活動 (BUC) は消す
// - 業務の既定の活動はちょうど 1 個にする (無ければ作る。複数なら最初を残し、他の既定の活動の作業は残した方へ付け替えて消す)
// - 既定の活動の名前を業務名に揃える
// - 消えた要素を指す関係・ボードのノード・課題の targetIds は消す
// - 消えた活動を指す作業の bucId、消えたコンテキストを指す contextId は null にする
// - 自己参照の関係と、両端の種類から決まる kind と合わない関係は消す
// - 同じ関係 (sameRelation) の重複は先頭を残して畳む
// - 関係が消えたボードの線の設定は消す
// - 置けない要素 (課題・既定の活動) のノードは消す。枠 (業務・活動) のノードに width / height が無ければ既定の大きさを補う
// - ボードが 0 枚なら「ボード 1」を作る
//
// 対象外 (validateModel が検査するが、同時編集では起きにくいので直さない):
// - 要素・関係・ボードをまたいだ id の重複
// - 作業・操作の時間 (hours) の小数点の桁
// - 課題の対象の混在 (登場人物と業務・作業・操作が同じ課題に混ざる)
import { produce } from "immer";
import { DEFAULT_FRAME_SIZE } from "./commands";
import { newUniqueId } from "./id";
import { isUndirected, relationKindFor } from "./relations";
import { ELEMENT_KIND_LABELS, isContextMemberKind } from "./types";
import type { Board, Buc, Element, UntieModel } from "./types";

export interface RepairResult {
  model: UntieModel;
  /** 直した内容の短い説明 (日本語)。壊れていなければ空 */
  changes: string[];
}

/** ボードが 0 枚になったときに作るボードの id。サーバーの修復とクライアントの表示で同じ id にして、合流しても 1 枚になるようにする */
export const FALLBACK_BOARD_ID = "board_main";

/**
 * 壊れた参照を直す。壊れていなければ同じ参照を返し、changes は空。
 * 直す規則と対象外の規則は、このファイルの冒頭に書いてある。
 */
export function repairModel(model: UntieModel): RepairResult {
  const changes: string[] = [];

  const next = produce(model, (draft) => {
    const label = (e: Element) => `${ELEMENT_KIND_LABELS[e.kind]} ${e.id}`;
    const kindOf = new Map<string, Element["kind"]>(draft.elements.map((e) => [e.id, e.kind]));
    const byId = new Map<string, Element>(draft.elements.map((e) => [e.id, e]));
    /** 参照先の問題。問題が無ければ null */
    const refProblem = (id: string, want: Element["kind"]): string | null => {
      const kind = kindOf.get(id);
      if (kind === undefined) return `${ELEMENT_KIND_LABELS[want]} ${id} が無い`;
      return kind === want ? null : `${ELEMENT_KIND_LABELS[want]} ${id} ではなく${ELEMENT_KIND_LABELS[kind]}を指している`;
    };

    // 1. 活動 (BUC)。業務が無いものを消し、業務ごとに既定の活動をちょうど 1 個にし、名前を業務名に揃える
    const removed = new Set<string>();
    for (const e of draft.elements) {
      if (e.kind !== "buc") continue;
      const problem = refProblem(e.businessId, "business");
      if (problem) {
        removed.add(e.id);
        changes.push(`${label(e)} を消した (業務: ${problem})`);
      }
    }
    const defaultsByBusiness = new Map<string, Buc[]>();
    for (const e of draft.elements) {
      if (e.kind === "buc" && e.isDefault && !removed.has(e.id)) {
        const list = defaultsByBusiness.get(e.businessId) ?? [];
        list.push(e);
        defaultsByBusiness.set(e.businessId, list);
      }
    }
    const created: Buc[] = [];
    const redirect = new Map<string, string>(); // 消す既定の活動 → 残す既定の活動
    const usedIds = new Set<string>([...kindOf.keys(), ...draft.relations.map((r) => r.id), ...draft.boards.map((b) => b.id)]);
    for (const biz of draft.elements) {
      if (biz.kind !== "business") continue;
      const list = defaultsByBusiness.get(biz.id) ?? [];
      if (list.length === 0) {
        // どの端末で直しても同じ id になるよう、業務の id から決める
        const derived = `buc_${biz.id}`;
        const id = usedIds.has(derived) ? newUniqueId("buc", usedIds) : derived;
        usedIds.add(id);
        created.push({ id, kind: "buc", name: biz.name, businessId: biz.id, isDefault: true });
        changes.push(`業務 ${biz.id} の既定の活動を作った (無かった)`);
        continue;
      }
      const [keep, ...rest] = list;
      for (const dup of rest) {
        redirect.set(dup.id, keep.id);
        removed.add(dup.id);
        changes.push(`${label(dup)} を消した (業務 ${biz.id} の既定の活動が複数あり、${keep.id} を残した)`);
      }
      if (keep.name !== biz.name) {
        changes.push(`${label(keep)} の名前を業務名「${biz.name}」に揃えた`);
        keep.name = biz.name;
      }
    }
    if (redirect.size > 0) {
      for (const e of draft.elements) {
        if (e.kind === "activity" && e.bucId !== null && redirect.has(e.bucId)) {
          changes.push(`${label(e)} の bucId を ${redirect.get(e.bucId)} に付け替えた`);
          e.bucId = redirect.get(e.bucId)!;
        }
      }
    }
    if (removed.size > 0) {
      draft.elements = draft.elements.filter((e) => !removed.has(e.id));
      for (const id of removed) {
        kindOf.delete(id);
        byId.delete(id);
      }
    }
    for (const b of created) {
      draft.elements.push(b);
      kindOf.set(b.id, "buc");
      byId.set(b.id, b);
    }

    // 2. 要素の参照 (作業の bucId、情報・状態・条件・バリエーションの contextId、課題の targetIds)
    for (const e of draft.elements) {
      if (e.kind === "activity" && e.bucId !== null) {
        const problem = refProblem(e.bucId, "buc");
        if (problem) {
          changes.push(`${label(e)} の bucId を null にした (${problem})`);
          e.bucId = null;
        }
      }
      if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId !== null) {
        const problem = refProblem(e.contextId, "context");
        if (problem) {
          changes.push(`${label(e)} の contextId を null にした (${problem})`);
          e.contextId = null;
        }
      }
      if (e.kind === "issue") {
        const missing = e.targetIds.filter((id) => !kindOf.has(id));
        if (missing.length > 0) {
          e.targetIds = e.targetIds.filter((id) => kindOf.has(id));
          for (const id of missing) changes.push(`${label(e)} の対象 ${id} を外した (要素が無い)`);
        }
      }
    }

    // 3. 関係: 端の要素が無い・自己参照・両端の種類と合わないものを消し、同じ関係の重複は先頭を残して畳む
    const keptRelations: typeof draft.relations = [];
    // 同じ関係かの判定は sameRelation と同じ規則 (無向関係は向きを無視)。件数が多くても済むようキーで引く
    const seenRelations = new Map<string, string>();
    const dupRelationIds = new Set<string>();
    for (const r of draft.relations) {
      const s = byId.get(r.sourceId);
      const t = byId.get(r.targetId);
      const missing = [s ? null : r.sourceId, t ? null : r.targetId].filter((x): x is string => x !== null);
      if (!s || !t) {
        changes.push(`関係 ${r.id} を消した (端の要素 ${missing.join("・")} が無い)`);
        continue;
      }
      if (r.sourceId === r.targetId) {
        changes.push(`関係 ${r.id} を消した (自己参照)`);
        continue;
      }
      const expected = relationKindFor(s.kind, t.kind);
      if (expected === null) {
        changes.push(`関係 ${r.id} を消した (両端の種類 ${ELEMENT_KIND_LABELS[s.kind]} → ${ELEMENT_KIND_LABELS[t.kind]} は線で結べない)`);
        continue;
      }
      if (expected !== r.kind) {
        changes.push(`関係 ${r.id} を消した (kind「${r.kind}」が両端から決まる「${expected}」と違う)`);
        continue;
      }
      const key = `${r.kind}\0${r.sourceId}\0${r.targetId}`;
      const first = seenRelations.get(key);
      if (first !== undefined) {
        changes.push(`関係 ${r.id} を消した (${first} と重複)`);
        dupRelationIds.add(r.id);
        continue;
      }
      seenRelations.set(key, r.id);
      if (isUndirected(r.kind)) seenRelations.set(`${r.kind}\0${r.targetId}\0${r.sourceId}`, r.id);
      keptRelations.push(r);
    }
    if (keptRelations.length !== draft.relations.length) draft.relations = keptRelations;
    const relationIds = new Set(draft.relations.map((r) => r.id));

    // 4. ボード: 置けないノード (要素が無い・課題・既定の活動) を消し、枠の大きさを補い、関係が無い線の設定を消す
    for (const b of draft.boards) {
      const nodes: typeof b.nodes = [];
      for (const n of b.nodes) {
        const el = byId.get(n.elementId);
        if (!el) {
          changes.push(`ボード「${b.name}」のノード ${n.elementId} を消した (要素が無い)`);
          continue;
        }
        if (el.kind === "issue" || (el.kind === "buc" && el.isDefault)) {
          changes.push(`ボード「${b.name}」のノード ${n.elementId} を消した (${el.kind === "issue" ? "課題" : "既定の活動"}は置けない)`);
          continue;
        }
        if (el.kind === "business" || el.kind === "buc") {
          const size = DEFAULT_FRAME_SIZE[el.kind];
          if (n.width === undefined || n.height === undefined) {
            changes.push(`ボード「${b.name}」の${ELEMENT_KIND_LABELS[el.kind]} ${el.id} のノードに枠の大きさを補った`);
            if (n.width === undefined) n.width = size.width;
            if (n.height === undefined) n.height = size.height;
          }
        }
        nodes.push(n);
      }
      if (nodes.length !== b.nodes.length) b.nodes = nodes;
      if (b.edges) {
        const edges = b.edges.filter((e) => relationIds.has(e.relationId));
        if (edges.length !== b.edges.length) {
          for (const e of b.edges) {
            if (relationIds.has(e.relationId)) continue;
            changes.push(
              dupRelationIds.has(e.relationId)
                ? `ボード「${b.name}」の重複した関係の線 ${e.relationId} を消した`
                : `ボード「${b.name}」の線の設定 ${e.relationId} を消した (関係が無い)`,
            );
          }
          if (edges.length > 0) b.edges = edges;
          else delete b.edges;
        }
      }
    }

    // 5. ボードが 0 枚なら「ボード 1」を作る
    if (draft.boards.length === 0) {
      const id = usedIds.has(FALLBACK_BOARD_ID) ? newUniqueId("board", usedIds) : FALLBACK_BOARD_ID;
      const board: Board = { id, name: "ボード 1", nodes: [] };
      (draft.boards as Board[]).push(board);
      changes.push("ボードが 0 枚だったので「ボード 1」を作った");
    }
  });

  // 何も直していなければ入力の参照をそのまま返す
  return changes.length === 0 ? { model, changes } : { model: next, changes };
}
