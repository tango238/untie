// 壊れた参照の修復 (設計書 6 章)。
// 同時編集では「要素 A を消す」と「A への関係を足す」が両方受け入れられ、合流後に壊れた参照が残りうる。
// validateModel の参照整合性検査と同じ規則で壊れた箇所を見つけ、直したモデルと変更の一覧を返す純粋関数。
//
// 直す規則:
// - 業務が無い (業務でない要素を指す) 活動 (BUC) は消す。システムが無い (システムでない要素を指す) 画面・非機能要件も消す
// - 業務の既定の活動はちょうど 1 個にする (無ければ作る。複数なら最初を残し、他の既定の活動の作業は残した方へ付け替えて消す)
// - 既定の活動の名前を業務名に揃える
// - 消えた要素を指す関係・ボードのノード・課題の targetIds は消す
// - 消えた活動を指す作業の bucId、消えたコンテキストを指す contextId は null にする
// - 自己参照の関係と、両端の種類から決まる kind と合わない関係は消す。usecaseInformation 以外に付いた access は外す
// - 同じ関係 (sameRelation) の重複は先頭を残して畳む
// - 操作の対象 (システム・帳票・画面) が 2 本以上なら、画面を優先し、先にあるものを残す
// - 関係が消えたボードの線の設定は消す
// - 置けない要素 (課題・既定の活動) のノードは消す。枠 (業務・活動) のノードに width / height が無ければ既定の大きさを補う
// - ボードが 0 枚なら「ボード 1」を作る
// - 設計データ (0.5.0): システムが無い設計、元の画面が無い (別のシステムの画面を含む) 設計の画面、画面が無い遷移・ナビゲーションの項目、
//   データベースが無い使用・画面の対応、情報が無いテーブルの対応は消す (データベース自体は消さない)。大きすぎる・深すぎる・使えないキーを含む画面 UI は、画面を残して画面 UI と対応を消す
// - アクター・外部アクターのペルソナは、列挙の外の IT の習熟を外し、全項目が空なら persona ごと消す
// - イベントの発生タイミング (0.5.4) は、種類が分からなければ timing ごと消し、周期に合わない・範囲外の項目は外す (normalizeEventTiming)
// - ドメインモデル (0.6.0): 参照の壊れた箇所を domain.ts の inspectDomain の規則で直す (消えた情報をルートにする集約は消す、消えたシステムは実装先から外す、など)。
//   形の合わない英語名・分類・統合の方式は、部品を残して項目だけ外す (truncate.ts の cleanDomain)
// - スキーマの上限 (limits.ts) を超えた文字列は、要素を外さず上限に切り詰める (truncate.ts。最初に行う)
//
// changes には id・種類・項目名だけを書く。業務名などの中身はログに出さない (untieRoom.ts がそのまま console に出すため)。
//
// 対象外 (validateModel が検査するが、同時編集では起きにくいので直さない):
// - 要素・関係・ボードをまたいだ id の重複
// - 作業・操作の時間 (hours) の小数点の桁
// - 課題の対象の混在 (登場人物と業務・作業・操作が同じ課題に混ざる)
import { produce } from "immer";
import { DEFAULT_FRAME_SIZE } from "./commands";
import { removeDesignScreens } from "./design";
import { inspectDomain } from "./domain";
import { viewShapeProblem } from "./designView";
import { isTooLong, VIEW_JSON_MAX_LENGTH } from "./limits";
import { newUniqueId } from "./id";
import { isUndirected, relationKindFor } from "./relations";
import { truncateModelStrings } from "./truncate";
import { ELEMENT_KIND_LABELS, isContextMemberKind, isPersonaItSkill, normalizeEventTiming, normalizePersona } from "./types";
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
export function repairModel(input: UntieModel): RepairResult {
  // 長すぎる文字列は先に切り詰める (切り詰めないと、以降の検証で形の壊れた要素として扱われる)
  const truncated = truncateModelStrings(input);
  const model = truncated.model;
  const changes: string[] = [...truncated.changes];

  /** 知らせを出さずに直した (全項目が空のペルソナを消した) */
  let silentlyFixed = false;
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

    // 0. ペルソナ。列挙の外の IT の習熟は項目を外し、全項目が空 (空のオブジェクトを含む) なら persona ごと消す
    for (const e of draft.elements) {
      if (e.kind !== "actor" && e.kind !== "externalActor") continue;
      const persona = e.persona as Record<string, unknown> | undefined;
      if (persona === undefined) continue;
      if (typeof persona === "object" && persona !== null && "itSkill" in persona && !isPersonaItSkill(persona.itSkill)) {
        changes.push(`${label(e)} のペルソナの IT の習熟を外した (値が正しくない)`);
        delete persona.itSkill;
      }
      if (normalizePersona(persona) === null) {
        delete e.persona;
        silentlyFixed = true;
      }
    }

    // 0b. イベントの発生タイミング。種類が分からなければ消し、ほかは正規化した形にそろえる
    for (const e of draft.elements) {
      if (e.kind !== "event" || e.timing === undefined) continue;
      const normalized = normalizeEventTiming(e.timing);
      if (normalized === null) {
        changes.push(`${label(e)} の発生タイミングを外した (種類が正しくない)`);
        delete e.timing;
      } else if (JSON.stringify(normalized) !== JSON.stringify(e.timing)) {
        changes.push(`${label(e)} の発生タイミングの、周期に合わない・範囲外の項目を外した`);
        e.timing = normalized;
      }
    }

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
    // 画面・非機能要件。属するシステムが無いものを消す (システムを消すと一緒に消えるものなので)
    for (const e of draft.elements) {
      if (e.kind !== "screen" && e.kind !== "nfr") continue;
      const problem = refProblem(e.systemId, "system");
      if (problem) {
        removed.add(e.id);
        changes.push(`${label(e)} を消した (システム: ${problem})`);
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
        changes.push(`${label(keep)} の名前を業務 ${biz.id} の名前に揃えた`);
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
      if (r.access !== undefined && r.kind !== "usecaseInformation") {
        // 取得・保存の区別は操作が扱う情報の関係にだけ付けられる。ほかに付いていたら外す
        changes.push(`関係 ${r.id} の access を外した (${r.kind} には付けられない)`);
        delete r.access;
      }
      if (r.alternate !== undefined) {
        // 代替パターンは操作が判断する条件の関係にだけ付けられる。そのとき起きる出来事が無ければ、出来事の参照だけ外す (0.6.1)
        if (r.kind !== "usecaseCondition") {
          changes.push(`関係 ${r.id} の alternate を外した (${r.kind} には付けられない)`);
          delete r.alternate;
        } else if (r.alternate.eventId !== undefined && kindOf.get(r.alternate.eventId) !== "event") {
          changes.push(`関係 ${r.id} の代替パターンのイベントの参照を外した (イベントが無い)`);
          delete r.alternate.eventId;
        }
        // エラー (0.6.2): 起きる出来事と両方あれば、出来事を外す (エラーのほうが、あとから決めた細かい判断)。入力エラーに付いた HTTP ステータスは外す
        if (r.alternate?.error !== undefined) {
          if (r.alternate.eventId !== undefined) {
            changes.push(`関係 ${r.id} の代替パターンのイベントの参照を外した (エラーと両方は持てない)`);
            delete r.alternate.eventId;
          }
          if (r.alternate.error.status !== undefined && r.alternate.error.type !== "server") {
            changes.push(`関係 ${r.id} の代替パターンのエラーから HTTP ステータスを外した (サーバーエラーにだけ付けられる)`);
            delete r.alternate.error.status;
          }
        }
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
    // 操作の対象 (システム・帳票・画面) は 1 本まで。同時編集で 2 本になったら、画面を優先し、先にあるものを残す
    const targetsOf = new Map<string, (typeof keptRelations)[number][]>();
    for (const r of keptRelations) {
      if (r.kind === "usecaseSystem" || r.kind === "usecaseScreen") targetsOf.set(r.sourceId, [...(targetsOf.get(r.sourceId) ?? []), r]);
    }
    const extraTargets = new Set<string>();
    for (const list of targetsOf.values()) {
      if (list.length < 2) continue;
      const keep = list.find((r) => r.kind === "usecaseScreen") ?? list[0]!;
      for (const r of list) {
        if (r === keep) continue;
        extraTargets.add(r.id);
        changes.push(`関係 ${r.id} を消した (操作 ${r.sourceId} の対象は ${keep.id} の 1 つだけにする)`);
      }
    }
    if (extraTargets.size > 0) {
      const rest = keptRelations.filter((r) => !extraTargets.has(r.id));
      keptRelations.length = 0;
      keptRelations.push(...rest);
    }
    if (keptRelations.length !== draft.relations.length) draft.relations = keptRelations;
    const relationIds = new Set(draft.relations.map((r) => r.id));

    // 4. ボード: 置けないノード (要素が無い・課題・既定の活動) を消し、枠の大きさを補い、関係が無い線の設定を消す
    for (const b of draft.boards) {
      const nodes: typeof b.nodes = [];
      for (const n of b.nodes) {
        const el = byId.get(n.elementId);
        if (!el) {
          changes.push(`ボード ${b.id} のノード ${n.elementId} を消した (要素が無い)`);
          continue;
        }
        if (el.kind === "issue" || (el.kind === "buc" && el.isDefault)) {
          changes.push(`ボード ${b.id} のノード ${n.elementId} を消した (${el.kind === "issue" ? "課題" : "既定の活動"}は置けない)`);
          continue;
        }
        if (el.kind === "business" || el.kind === "buc") {
          const size = DEFAULT_FRAME_SIZE[el.kind];
          if (n.width === undefined || n.height === undefined) {
            changes.push(`ボード ${b.id} の${ELEMENT_KIND_LABELS[el.kind]} ${el.id} のノードに枠の大きさを補った`);
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
                ? `ボード ${b.id} の重複した関係の線 ${e.relationId} を消した`
                : `ボード ${b.id} の線の設定 ${e.relationId} を消した (関係が無い)`,
            );
          }
          if (edges.length > 0) b.edges = edges;
          else delete b.edges;
        }
      }
    }

    // 5. 設計データ。消えた要素を指すものを外す (removeElement の連鎖と同じ範囲)
    const databaseIds = new Set(draft.databases.map((d) => d.id));
    draft.designs = draft.designs.filter((d) => {
      const problem = refProblem(d.systemId, "system");
      if (problem) changes.push(`システム ${d.systemId} の設計を消した (${problem})`);
      return !problem;
    });
    for (const design of draft.designs) {
      const where = `システム ${design.systemId} の設計`;
      const usable = design.databaseIds.filter((id) => databaseIds.has(id));
      if (usable.length !== design.databaseIds.length) {
        changes.push(`${where}のデータベースの指定を外した (データベースが無い)`);
        design.databaseIds = usable;
      }
      for (const s of design.screens) {
        // 画面のレイアウトが列挙の外の値なら、項目を外す (設計のレイアウトに従う)
        if (s.shell !== undefined && s.shell !== "shell" && s.shell !== "plain") {
          changes.push(`${where}の画面 ${s.id} のレイアウトの指定を外した (値が正しくない)`);
          delete s.shell;
        }
        // 画面 UI が大きすぎる・深すぎる・使えないキーを含むときは、画面を残して画面 UI と対応を捨てる
        if (s.view !== undefined) {
          const problem = viewShapeProblem(s.view) ?? (isTooLong(JSON.stringify(s.view), VIEW_JSON_MAX_LENGTH) ? "大きすぎる" : null);
          if (problem) {
            changes.push(`${where}の画面 ${s.id} の画面 UI と項目の対応を消した (${problem === "大きすぎる" ? problem : "形が正しくない"})`);
            delete s.view;
            delete s.bindings;
            continue;
          }
        }
        if (s.bindings) {
          const kept = s.bindings.filter((b) => databaseIds.has(b.databaseId));
          if (kept.length !== s.bindings.length) {
            changes.push(`${where}の画面 ${s.id} の項目の対応を外した (データベースが無い)`);
            s.bindings = kept;
          }
        }
      }
      // 元の画面が無い (別のシステムの画面を含む) 画面と、それを指す遷移・ナビゲーションの項目は、removeElement と同じ範囲で外す
      const badSource = (s: (typeof design.screens)[number]) => {
        if (s.source.kind !== "screen") return false;
        const el = byId.get(s.source.screenId);
        return !el || el.kind !== "screen" || el.systemId !== design.systemId;
      };
      for (const s of design.screens) if (badSource(s)) changes.push(`${where}の画面 ${s.id} を消した (元の画面が、このシステムに無い)`);
      removeDesignScreens(design, badSource);
      // 同じ元の画面 (同じ分析の画面・同じ組み込みの画面) を指す画面が 2 つ以上あれば、後のものを消す (同時編集で、2 人が同じ画面を足したときに起きる)
      const sourceSeen = new Set<string>();
      const dup = (s: (typeof design.screens)[number]) => {
        const key = s.source.kind === "screen" ? `screen:${s.source.screenId}` : `builtin:${s.source.builtin}`;
        if (sourceSeen.has(key)) return true;
        sourceSeen.add(key);
        return false;
      };
      const dupIds = new Set(design.screens.filter(dup).map((s) => s.id));
      for (const id of dupIds) changes.push(`${where}の画面 ${id} を消した (同じ画面が重なっている)`);
      removeDesignScreens(design, (s) => dupIds.has(s.id));
      // 画面が無い遷移とナビゲーションの項目 (消した画面を指すもの、もとから壊れていたもの)
      const known = new Set(design.screens.map((s) => s.id));
      const transitions = design.transitions.filter((t) => known.has(t.from) && known.has(t.to));
      if (transitions.length !== design.transitions.length) {
        for (const t of design.transitions) if (!known.has(t.from) || !known.has(t.to)) changes.push(`${where}の遷移 ${t.id} を消した (画面が無い)`);
        design.transitions = transitions;
      }
      // 同じ from / to の遷移が 2 本以上あれば、後のものを消す
      const pairSeen = new Set<string>();
      const uniq = design.transitions.filter((t) => {
        const key = `${t.from}\n${t.to}`;
        if (pairSeen.has(key)) {
          changes.push(`${where}の遷移 ${t.id} を消した (同じ遷移が重なっている)`);
          return false;
        }
        pairSeen.add(key);
        return true;
      });
      design.transitions = uniq;
      for (const group of design.layout.navigation) {
        const items = group.items.filter((i) => known.has(i.screenId));
        if (items.length !== group.items.length) {
          changes.push(`${where}のナビゲーションの項目を外した (画面が無い)`);
          group.items = items;
        }
      }
    }
    for (const db of draft.databases) {
      for (const table of db.tables) {
        const ids = table.informationIds.filter((id) => kindOf.get(id) === "information");
        if (ids.length !== table.informationIds.length) {
          changes.push(`データベース ${db.id} のテーブルの情報の対応を外した (情報が無い)`);
          table.informationIds = ids;
        }
      }
    }

    // 5b. ドメインモデル (0.6.0)。消えた要素・コンテキスト・集約を指すものを、inspectDomain の規則で外す
    const inspected = inspectDomain(draft.domain, draft.elements);
    if (inspected.problems.length > 0) {
      for (const p of inspected.problems) changes.push(`ドメインモデルの${p.what}ので、${p.fix}`);
      draft.domain = inspected.domain;
    }

    // 6. ボードが 0 枚なら「ボード 1」を作る
    if (draft.boards.length === 0) {
      const id = usedIds.has(FALLBACK_BOARD_ID) ? newUniqueId("board", usedIds) : FALLBACK_BOARD_ID;
      const board: Board = { id, name: "ボード 1", nodes: [] };
      (draft.boards as Board[]).push(board);
      changes.push("ボードが 0 枚だったので「ボード 1」を作った");
    }
  });

  // 何も直していなければ入力の参照をそのまま返す
  return changes.length === 0 && !silentlyFixed ? { model, changes } : { model: next, changes };
}
