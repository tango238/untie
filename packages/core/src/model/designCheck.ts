// 設計モードの検証 (5.7)。設計のあるシステムを、データベースとの対応・サイトマップ・画面の面から調べる。純粋関数だけを置く。
import { effectiveDatabaseIds } from "./design";
import { unmappedInformationIds } from "./designData";
import { unboundSlots } from "./designView";
import { parsePrismaDslCached } from "./prismaCache";
import { designScreenName } from "./sitemap";
import type { UntieModel } from "./types";

export type DesignProblemType =
  | "informationUnmapped"
  | "tableMissing"
  | "dslError"
  | "bindingInvalid"
  | "noDatabase"
  | "transitionViaUndecided"
  | "screenUnreachable"
  | "screenWithoutView"
  | "bindingUnmapped";

export interface DesignProblemTarget {
  kind: "database" | "table" | "screen" | "transition" | "information" | "board";
  /** database / table はデータベースの id、screen は設計の画面の id、transition は遷移の id、information は情報の id、board は設計ボードの種類 (data / screen など。そのボードへ移る) */
  id: string;
  /** kind が table のときのテーブル名 */
  table?: string;
}

export interface DesignProblem {
  type: DesignProblemType;
  message: string;
  target?: DesignProblemTarget;
}

export interface DesignCheckResult {
  problems: DesignProblem[];
  warnings: DesignProblem[];
}

/** 種類ごとの見出し */
export const DESIGN_PROBLEM_TITLES: Record<DesignProblemType, string> = {
  informationUnmapped: "テーブルに対応していない情報",
  tableMissing: "DSL に無いテーブル",
  dslError: "DSL の解析エラー",
  bindingInvalid: "存在しない列を指す項目の対応",
  noDatabase: "使うデータベースがありません",
  transitionViaUndecided: "きっかけが未定の遷移",
  screenUnreachable: "メニューからも遷移からも辿れない画面",
  screenWithoutView: "画面 UI がまだ無い画面",
  bindingUnmapped: "列の対応が無い項目",
};

/** 種類を並べる順 (エラー・警告それぞれの中で) */
export const DESIGN_PROBLEM_ORDER: readonly DesignProblemType[] = [
  "noDatabase",
  "informationUnmapped",
  "tableMissing",
  "dslError",
  "bindingInvalid",
  "transitionViaUndecided",
  "screenUnreachable",
  "bindingUnmapped",
  "screenWithoutView",
];

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** そのシステムの設計を検証する。設計が無ければ何も出さない */
export function checkDesign(model: UntieModel, systemId: string): DesignCheckResult {
  const problems: DesignProblem[] = [];
  const warnings: DesignProblem[] = [];
  const design = model.designs.find((d) => d.systemId === systemId);
  if (!design) return { problems, warnings };
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const databases = effectiveDatabaseIds(model, design)
    .map((id) => model.databases.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => !!d);

  // (e) 使うデータベースが 1 つも無い
  if (databases.length === 0) {
    problems.push({ type: "noDatabase", message: "使うデータベースがありません。データボードでデータベースを足してください", target: { kind: "board", id: "data" } });
  } else {
    // (a) システムが使う情報が、どのテーブルにも対応していない
    for (const id of unmappedInformationIds(model, systemId)) {
      problems.push({
        type: "informationUnmapped",
        message: `情報「${nameOf(byId.get(id))}」が、使うデータベースのどのテーブルにも対応していません`,
        target: { kind: "information", id },
      });
    }
  }
  for (const db of databases) {
    const schema = parsePrismaDslCached(db.dsl);
    const names = new Set(schema.models.map((m) => m.name));
    // (b) 対応のあるテーブルが DSL に無い
    for (const t of db.tables) {
      if (t.informationIds.length > 0 && !names.has(t.table)) {
        problems.push({
          type: "tableMissing",
          message: `「${db.name}」の DSL に、情報と対応するテーブル ${t.table} がありません`,
          target: { kind: "table", id: db.id, table: t.table },
        });
      }
    }
    // (c) DSL の解析エラー
    if (schema.errors.length > 0) {
      const first = schema.errors[0]!;
      problems.push({
        type: "dslError",
        message: `「${db.name}」の DSL に解析エラーが ${schema.errors.length} 件あります (${first.line} 行目: ${first.message})`,
        target: { kind: "database", id: db.id },
      });
    }
  }
  // (d) 画面の項目の対応が、無いデータベース・テーブル・列を指す
  for (const screen of design.screens) {
    for (const b of screen.bindings ?? []) {
      const db = model.databases.find((d) => d.id === b.databaseId);
      let reason: string | null = null;
      if (!db) reason = `データベース ${b.databaseId} がありません`;
      else {
        const table = parsePrismaDslCached(db.dsl).models.find((m) => m.name === b.table);
        if (!table) reason = `「${db.name}」にテーブル ${b.table} がありません`;
        else if (!table.fields.some((f) => f.name === b.column)) reason = `テーブル ${b.table} に列 ${b.column} がありません`;
      }
      if (reason) {
        problems.push({
          type: "bindingInvalid",
          message: `画面「${designScreenName(model, screen)}」の項目「${b.item}」の対応: ${reason}`,
          target: { kind: "screen", id: screen.id },
        });
      }
    }
  }

  // (f) 遷移のきっかけが未定
  const screenName = (id: string) => {
    const s = design.screens.find((x) => x.id === id);
    return s ? designScreenName(model, s) : id;
  };
  for (const t of design.transitions) {
    if (t.via !== undefined) continue;
    warnings.push({
      type: "transitionViaUndecided",
      message: `遷移「${screenName(t.from)}」→「${screenName(t.to)}」のきっかけが未定です`,
      target: { kind: "transition", id: t.id },
    });
  }
  // (h) ナビゲーションからも、ほかの画面からの遷移からも辿れない画面 (サインイン・トップページは除く。画面ごとに 1 行、サイトマップでその画面を選ぶ)。
  // shell が plain のときはメニューが出ないので数えない。きっかけがメニューの遷移は、行き先がメニューに載っているときだけ数える。自分自身への遷移は数えない
  const inNav = new Set(design.layout.shell === "plain" ? [] : design.layout.navigation.flatMap((g) => g.items.map((i) => i.screenId)));
  const reached = new Set(design.transitions.filter((t) => t.from !== t.to && (t.via !== "nav" || inNav.has(t.to))).map((t) => t.to));
  for (const s of design.screens) {
    if (s.source.kind === "builtin" && (s.source.builtin === "signIn" || s.source.builtin === "top")) continue;
    if (inNav.has(s.id) || reached.has(s.id)) continue;
    warnings.push({
      type: "screenUnreachable",
      message: `画面「${screenName(s.id)}」は、メニューにも、ほかの画面からの遷移にもありません`,
      target: { kind: "screen", id: s.id },
    });
  }
  // (g) 画面 UI (view) が無い。画面が 1 つも無いときは出さない。1 行にまとめ、画面ボードへ移る
  const noView = design.screens.filter((s) => s.view === undefined);
  if (noView.length > 0) {
    warnings.push({
      type: "screenWithoutView",
      message: `画面 UI がまだ無い画面が ${noView.length} 件あります (${noView.slice(0, 3).map((s) => designScreenName(model, s)).join("、")}${noView.length > 3 ? " ほか" : ""})`,
      target: { kind: "board", id: "screen" },
    });
  }
  // (i) 画面 UI の入力の項目 (form の fields[].item) と一覧の列のうち、列の対応 (bindings) が無いもの。画面ごとに 1 行にまとめ、画面ボードでその画面を選ぶ
  for (const s of design.screens) {
    const missing = unboundSlots(s);
    if (missing.length === 0) continue;
    warnings.push({
      type: "bindingUnmapped",
      message: `画面「${screenName(s.id)}」に、列の対応が無い項目が ${missing.length} 件あります (${missing.slice(0, 3).map((m) => m.label).join("、")}${missing.length > 3 ? " ほか" : ""})`,
      target: { kind: "screen", id: s.id },
    });
  }
  return { problems: sortProblems(problems), warnings: sortProblems(warnings) };
}

function sortProblems(list: DesignProblem[]): DesignProblem[] {
  const rank = (p: DesignProblem) => DESIGN_PROBLEM_ORDER.indexOf(p.type);
  return list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/** 設計のあるすべてのシステムを検証する (設計を持つ順) */
export function checkAllDesigns(model: UntieModel): (DesignCheckResult & { systemId: string })[] {
  return model.designs.map((d) => ({ systemId: d.systemId, ...checkDesign(model, d.systemId) }));
}
