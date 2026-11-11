// 実装を始める準備 (5.7)。対象のシステムについて、実装を始める前に決まっているべきことを条件にして、1 つずつ機械的に調べる。
// 途中まで決まった設計から実装を作り始めると、足りないところを作る側が勝手に埋めてしまう。それを防ぐために、条件がすべてそろうまで始めない。
// 条件は業務の言葉で書く (利用者に見せる)。内部のドメインモデルは、実装を始めたあとに裏で作って確かめるので、ここには入れない。純粋関数だけを置く。
import { checkDesign, type DesignProblem, type DesignProblemType } from "./designCheck";
import type { DesignBoardKind } from "./design";
import { usecasePlaces } from "./placement";
import { sequenceGaps } from "./sequence";
import { effectiveDatabaseIds } from "./design";
import { systemInformationIds } from "./designData";
import { parsePrismaDslCached } from "./prismaCache";
import { designScreenName } from "./sitemap";
import { traceToActors } from "./trace";
import { ELEMENT_KIND_LABELS, type Element, type UntieModel } from "./types";

export type ReadinessConditionId = "analysis" | "usecases" | "information" | "origins" | "rules" | "states" | "flow" | "screens" | "navigation" | "data";

/** 行を押したときの移動先 */
export type ReadinessTarget =
  /** 分析の要素。その要素を直せるボードへ移る */
  | { kind: "element"; id: string }
  /** シーケンス図で、その業務を開く (id は BusinessSequence の id) */
  | { kind: "sequence"; id: string }
  /** 設計ボードへ移る */
  | { kind: "board"; id: DesignBoardKind }
  /** 設計の検証の行と同じところへ移る */
  | { kind: "design"; problem: DesignProblem };

/** まだ決まっていないこと 1 件 */
export interface ReadinessItem {
  message: string;
  target?: ReadinessTarget;
}

export interface ReadinessCondition {
  id: ReadinessConditionId;
  /** 条件 (そろっている状態を言う) */
  title: string;
  /** なぜ要るか・どこで決めるか */
  hint: string;
  /** まだ決まっていないこと。空なら、この条件はそろっている */
  items: ReadinessItem[];
  done: boolean;
}

export interface Readiness {
  systemId: string;
  conditions: ReadinessCondition[];
  /** そろった条件の数 */
  doneCount: number;
  /** すべての条件がそろっている (実装を始められる) */
  ready: boolean;
}

/** 条件の見出しと説明 (並べる順) */
export const READINESS_CONDITIONS: readonly { id: ReadinessConditionId; title: string; hint: string }[] = [
  { id: "analysis", title: "分析に抜けが無い", hint: "分析モードの検証で、エラーが無いこと。誰の何のためのものか辿れない要素があると、作るものの根拠が欠ける" },
  { id: "usecases", title: "このシステムで行う操作がある", hint: "操作の対象に、このシステム (か、このシステムの画面) を結ぶ。操作が、作る機能の単位になる" },
  { id: "information", title: "操作が扱う情報が決まっている", hint: "操作ごとに、取得する情報・保存する情報を結ぶ。何も扱わない操作は、作る中身が決まらない" },
  { id: "origins", title: "情報と出来事の出どころが決まっている", hint: "取得するだけの情報には、それを保存する操作が要る (ほかのシステムや帳票の操作でもよい)。操作のきっかけの出来事には、起こす操作か、起きる時期が要る" },
  { id: "rules", title: "条件と区分の中身が決まっている", hint: "条件は、何で判断するか (説明か、区分・状態との結びつき)。区分は、取りうる値" },
  { id: "states", title: "状態の移り変わりがつながっている", hint: "操作の前提にしている状態には、その状態になる操作が要る。無いと、その操作は永久に行えない" },
  { id: "flow", title: "業務の流れが決まっている", hint: "条件で流れが変わるときにどうなるか、作業の担当、操作の対象。シーケンス図で決める" },
  { id: "screens", title: "画面がそろっている", hint: "操作が使う画面がサイトマップにあり、画面 UI と、項目とデータの対応がある" },
  { id: "navigation", title: "画面の行き来が決まっている", hint: "どの画面にも辿り着けて、遷移のきっかけが決まっている" },
  { id: "data", title: "データの置き場所が決まっている", hint: "このシステムが使う情報が、すべてデータベースのテーブルに対応していて、テーブルに名前と列がある" },
];

/** 設計の検証 (checkDesign) の種類を、どの条件に数えるか */
const DESIGN_CONDITION: Record<DesignProblemType, ReadinessConditionId> = {
  noDatabase: "data",
  informationUnmapped: "data",
  tableMissing: "data",
  dslError: "data",
  bindingInvalid: "screens",
  bindingUnmapped: "screens",
  screenWithoutView: "screens",
  transitionViaUndecided: "navigation",
  screenUnreachable: "navigation",
};

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";
const label = (e: Element | undefined): string => (e ? `${ELEMENT_KIND_LABELS[e.kind]}「${nameOf(e)}」` : "(消えた要素)");

/** そのシステムの実装を始める準備ができているかを調べる */
export function checkReadiness(model: UntieModel, systemId: string): Readiness {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const items = new Map<ReadinessConditionId, ReadinessItem[]>(READINESS_CONDITIONS.map((c) => [c.id, []]));
  const add = (id: ReadinessConditionId, item: ReadinessItem) => items.get(id)!.push(item);
  const element = (id: string): ReadinessTarget => ({ kind: "element", id });

  // 分析: 担い手まで辿れない要素 (途切れている箇所だけ。その先は同じ原因なので数えない) と、分析の検証のエラー
  const trace = traceToActors(model);
  for (const p of trace.problems) if (p.isBreak) add("analysis", { message: `${label(byId.get(p.elementId))}: ${p.reason}`, target: element(p.elementId) });
  for (const e of trace.errors) add("analysis", { message: `${label(byId.get(e.elementId))}: ${e.reason}`, target: element(e.elementId) });

  // このシステムで行う操作 (対象がこのシステムか、このシステムの画面)
  const places = usecasePlaces(model);
  const usecases = model.elements.filter((e) => e.kind === "usecase" && places.get(e.id) === systemId);
  const usecaseIds = new Set(usecases.map((u) => u.id));
  if (usecases.length === 0) add("usecases", { message: "このシステムを対象にした操作がありません。分析モードで、操作の対象にこのシステム (か、このシステムの画面) を結んでください" });

  // 操作が扱う情報
  const informationOf = new Map<string, string[]>();
  for (const r of model.relations) if (r.kind === "usecaseInformation") informationOf.set(r.sourceId, [...(informationOf.get(r.sourceId) ?? []), r.targetId]);
  for (const u of usecases) {
    if ((informationOf.get(u.id) ?? []).length === 0) add("information", { message: `操作「${nameOf(u)}」が扱う情報が決まっていません`, target: element(u.id) });
  }

  // 出どころ: このシステムの操作が扱う情報を、保存する操作 (どのシステム・帳票のものでも) が 1 つも無い
  const written = new Set(model.relations.filter((r) => r.kind === "usecaseInformation" && r.access !== "read").map((r) => r.targetId));
  for (const id of systemInformationIds(model, systemId)) {
    if (!written.has(id)) add("origins", { message: `情報「${nameOf(byId.get(id))}」を保存する操作がありません (取得するだけで、どこで作られるかが決まっていない)`, target: element(id) });
  }
  // 出どころ: このシステムの操作のきっかけの出来事に、起こす操作・システムも、起きる時期も無い
  const raised = new Set(model.relations.filter((r) => r.kind === "usecaseEvent" || r.kind === "systemEvent").map((r) => r.targetId));
  const triggers = new Set(model.relations.filter((r) => r.kind === "eventUsecase" && usecaseIds.has(r.targetId)).map((r) => r.sourceId));
  for (const e of model.elements) {
    if (e.kind === "event" && triggers.has(e.id) && !raised.has(e.id) && !e.timing) {
      add("origins", { message: `出来事「${nameOf(e)}」がいつ起きるか (起こす操作か、起きる時期) が決まっていません`, target: element(e.id) });
    }
  }

  // 条件と区分: このシステムの操作が判断する条件と、その条件・扱う情報に結んだ区分
  const conditionIds = new Set(model.relations.filter((r) => r.kind === "usecaseCondition" && usecaseIds.has(r.sourceId)).map((r) => r.targetId));
  const informationIds = new Set(usecases.flatMap((u) => informationOf.get(u.id) ?? []));
  const grounded = new Set(model.relations.filter((r) => r.kind === "conditionVariation" || r.kind === "conditionState").map((r) => r.sourceId));
  const variationIds = new Set(
    model.relations
      .filter((r) => (r.kind === "conditionVariation" && conditionIds.has(r.sourceId)) || (r.kind === "informationVariation" && informationIds.has(r.sourceId)))
      .map((r) => r.targetId),
  );
  for (const e of model.elements) {
    if (e.kind === "condition" && conditionIds.has(e.id) && !grounded.has(e.id) && !(e.description ?? "").trim()) {
      add("rules", { message: `条件「${nameOf(e)}」を何で判断するかが決まっていません (説明を書くか、区分・状態と結ぶ)`, target: element(e.id) });
    }
    if (e.kind === "variation" && variationIds.has(e.id) && e.values.filter((v) => v.trim()).length === 0) {
      add("rules", { message: `区分「${nameOf(e)}」の値が決まっていません`, target: element(e.id) });
    }
  }

  // 状態: このシステムの操作が前提にしている状態に、その状態になる操作 (どのシステムのものでも) が無い
  const entered = new Set(model.relations.filter((r) => r.kind === "usecaseState").map((r) => r.targetId));
  const waiting = new Map<string, string[]>();
  for (const r of model.relations) {
    if (r.kind !== "stateUsecase" || !usecaseIds.has(r.targetId) || entered.has(r.sourceId)) continue;
    waiting.set(r.sourceId, [...(waiting.get(r.sourceId) ?? []), r.targetId]);
  }
  for (const [stateId, users] of waiting) {
    add("states", {
      message: `状態「${nameOf(byId.get(stateId))}」になる操作がありません (操作「${users.map((id) => nameOf(byId.get(id))).join("」「")}」の前提)`,
      target: element(stateId),
    });
  }

  // 業務の流れ: 分岐のときにどうなるか・担当や対象の抜け
  for (const { sequence, gap } of sequenceGaps(model, systemId)) add("flow", { message: `${sequence.name}: ${gap.message}`, target: { kind: "sequence", id: sequence.id } });

  // 設計: 画面・画面の行き来・データ
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) {
    const message = "このシステムの設計がまだありません";
    add("screens", { message, target: { kind: "board", id: "sitemap" } });
    add("data", { message, target: { kind: "board", id: "data" } });
  } else {
    // 操作が使う画面 (分析の画面) が、サイトマップに入っていない
    const inDesign = new Set(design.screens.flatMap((s) => (s.source.kind === "screen" ? [s.source.screenId] : [])));
    const used = new Set(model.relations.filter((r) => r.kind === "usecaseScreen" && usecaseIds.has(r.sourceId)).map((r) => r.targetId));
    for (const e of model.elements) {
      if (e.kind === "screen" && used.has(e.id) && !inDesign.has(e.id)) add("screens", { message: `画面「${nameOf(e)}」がサイトマップに入っていません`, target: { kind: "board", id: "sitemap" } });
    }
    const check = checkDesign(model, systemId);
    for (const p of [...check.problems, ...check.warnings]) add(DESIGN_CONDITION[p.type], { message: p.message, target: { kind: "design", problem: p } });
    // このシステムが使う情報のテーブルが、ひな形のまま (名前が仮・列が id だけ)
    const mine = new Set(systemInformationIds(model, systemId));
    for (const dbId of effectiveDatabaseIds(model, design)) {
      const db = model.databases.find((d) => d.id === dbId);
      if (!db) continue;
      const schema = parsePrismaDslCached(db.dsl);
      for (const t of db.tables) {
        const table = schema.models.find((m) => m.name === t.table);
        if (!table || !t.informationIds.some((id) => mine.has(id))) continue;
        const of = t.informationIds.map((id) => nameOf(byId.get(id))).join("・");
        const target: ReadinessTarget = { kind: "design", problem: { type: "tableMissing", message: "", target: { kind: "table", id: db.id, table: t.table } } };
        if (/^Table\d+$/.test(t.table)) add("data", { message: `テーブル ${t.table} (情報「${of}」) の名前が仮のままです`, target });
        if (!table.fields.some((f) => !f.isId)) add("data", { message: `テーブル ${t.table} (情報「${of}」) に、id のほかの列がありません`, target });
      }
    }
    // 画面 UI が無い画面は、設計の検証では 1 行にまとめている。ここでは画面ごとに数える
    const noView = design.screens.filter((s) => s.view === undefined);
    if (noView.length > 0) {
      const list = items.get("screens")!;
      const at = list.findIndex((i) => i.target?.kind === "design" && i.target.problem.type === "screenWithoutView");
      const rows = noView.map((s): ReadinessItem => ({ message: `画面「${designScreenName(model, s)}」の画面 UI がまだありません`, target: { kind: "board", id: "screen" } }));
      if (at >= 0) list.splice(at, 1, ...rows);
    }
  }

  const conditions = READINESS_CONDITIONS.map((c): ReadinessCondition => {
    const list = items.get(c.id)!;
    return { ...c, items: list, done: list.length === 0 };
  });
  const doneCount = conditions.filter((c) => c.done).length;
  return { systemId, conditions, doneCount, ready: doneCount === conditions.length };
}

/** まだ決まっていないことの総数 */
export function readinessRemaining(readiness: Readiness): number {
  return readiness.conditions.reduce((n, c) => n + c.items.length, 0);
}
