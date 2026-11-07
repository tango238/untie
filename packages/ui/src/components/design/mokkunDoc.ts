// 設計 (サイトマップ・レイアウト・画面 UI) から、mokkun v2 の文書を組み立てる。純粋関数だけを置く。
// プレビュー (MokkunPreview) は、この文書の画面を renderViewV2 で HTML にして iframe に入れる。
import { parseV2Document, type MokkunV2Schema } from "mokkun";
import { designScreenName } from "@untie/core/model/sitemap";
import type { DesignScreen, SystemDesign, UntieModel } from "@untie/core/model/types";

type ViewV2 = MokkunV2Schema["views"][string];
type ActionV2 = NonNullable<ViewV2["secondaryActions"]>[number];
type NavGroupV2 = NonNullable<MokkunV2Schema["app"]["navigation"]>[number];

export interface MokkunDoc {
  schema: MokkunV2Schema;
  /** 設計の画面の id → mokkun の view の名前 (いまは画面の id そのもの) */
  viewNameOf: (designScreenId: string) => string;
  /** 画面 UI (view) が mokkun の検証に通らず、仮の view に替えた画面の id → 理由 */
  viewErrors: Record<string, string>;
  /** 画面の外の問題で、mokkun の検証に通らなかった理由 (通れば undefined)。通らないときも schema は組み立てたまま返す */
  error?: string;
}

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** 画面 UI がまだ無い画面の仮のセクションの見出し */
export const PLACEHOLDER_SECTION_TITLE = "画面 UI はまだありません";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 分析の画面が使う情報 (screenInformation の関係の並び順) */
function screenInformation(model: UntieModel, screen: DesignScreen): { id: string; name: string }[] {
  if (screen.source.kind !== "screen") return [];
  const screenId = screen.source.screenId;
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  return model.relations
    .filter((r) => r.kind === "screenInformation" && r.sourceId === screenId)
    .map((r) => ({ id: r.targetId, name: nameOf(byId.get(r.targetId)) }));
}

/** 画面 UI (view) が無い画面の仮の view: 画面が使う情報を readonly の text で 1 つずつ並べる。情報が無ければ note だけ */
function placeholderView(model: UntieModel, screen: DesignScreen, title: string, goal: string): ViewV2 {
  const infos = screenInformation(model, screen);
  const section: ViewV2["sections"][number] = {
    id: "placeholder",
    title: PLACEHOLDER_SECTION_TITLE,
    kind: "readonly",
    ...(infos.length > 0
      ? { fields: infos.map((i) => ({ item: i.id, label: i.name, component: "text" as const, readonly: true })) }
      : { note: "この画面が使う情報は、分析にまだありません。" }),
  };
  return { title, goal, sections: [section] };
}

/** view の中のすべての操作の id (画面の主・副・セクションの操作・一覧の行・一括の操作)。遷移の操作の id を重ねないために集める */
function actionIdsOf(view: ViewV2): Set<string> {
  const ids = new Set<string>();
  const add = (a: unknown) => {
    if (isObject(a) && typeof a.id === "string") ids.add(a.id);
  };
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.forEach(add) : undefined);
  add(view.primaryAction);
  list(view.secondaryActions);
  for (const section of Array.isArray(view.sections) ? view.sections : []) {
    if (!isObject(section)) continue;
    list(section.actions);
    if (isObject(section.list)) {
      list(section.list.rowActions);
      list(section.list.bulkActions);
    }
  }
  return ids;
}

/** mokkun の検証のエラーの path (`views.<id>.…`) から、壊れている view の名前を取り出す */
function brokenViews(errors: { path?: string }[]): { views: Set<string>; others: number } {
  const views = new Set<string>();
  let others = 0;
  for (const e of errors) {
    const m = /^views\.([^.[]+)/.exec(e.path ?? "");
    if (m) views.add(m[1]!);
    else others++;
  }
  return { views, others };
}

const describeErrors = (errors: { path?: string; message: string }[]): string => {
  const shown = errors.slice(0, 3).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
  return `${shown.join(" / ")}${errors.length > 3 ? ` (ほか ${errors.length - 3} 件)` : ""}`;
};

/**
 * 設計の画面ごとに mokkun の view を作る文書を組み立てる。
 * - app: name はヘッダーに出すシステム名 (設計の layout.header.systemName、空なら対象システムの名前)、layout は設計のレイアウト、header は利用者名・テナント名 (mokkun の header.systemName は小さな補足なので使わない)、navigation は設計のナビゲーション (view は画面の id、label は省略時は画面名)
 * - views: キーは画面の id。画面 UI (view) があればその中身をそのまま使い (title は画面名を正にする)、無ければ仮の 1 セクション。遷移は secondaryActions に navigate として足す (きっかけがメニュー (nav) の遷移は足さない。メニューで行く)。操作の id が重なるときは `_2` のように付け直す
 * 組み立てた文書は mokkun の検証 (parseV2Document) に通す。画面 UI が壊れている画面は、その画面だけ仮の view に替えてもう一度検証し、理由は viewErrors (画面の id → 理由) に入れる。
 * それでも通らない (画面の外の問題) ときは理由を error に入れる
 */
export function buildMokkunSchema(model: UntieModel, systemId: string, design: SystemDesign): MokkunDoc {
  const systemName = nameOf(model.elements.find((e) => e.id === systemId));
  const screens = design.screens;
  const names = new Map(screens.map((s) => [s.id, designScreenName(model, s)]));
  const byId = new Map(model.elements.map((e) => [e.id, e]));

  const navigation: NavGroupV2[] = design.layout.navigation
    .map((g) => ({
      group: g.group || "(名前なし)",
      items: g.items.filter((i) => names.has(i.screenId)).map((i) => ({ view: i.screenId, label: i.label || names.get(i.screenId)! })),
    }))
    .filter((g) => g.items.length > 0);
  const inNavigation = new Set(navigation.flatMap((g) => g.items.map((i) => i.view)));

  const header = design.layout.header;
  const app: MokkunV2Schema["app"] = {
    name: header?.systemName || systemName,
    layout: design.layout.shell,
    ...(header?.userName || header?.tenantName
      ? { header: { ...(header.userName ? { userName: header.userName } : {}), ...(header.tenantName ? { tenantName: header.tenantName } : {}) } }
      : {}),
    ...(navigation.length > 0 ? { navigation } : {}),
  };

  const buildViews = (placeholders: ReadonlySet<string>): MokkunV2Schema["views"] => {
    const views: MokkunV2Schema["views"] = {};
    for (const screen of screens) {
      const title = names.get(screen.id)!;
      const analysis = screen.source.kind === "screen" ? byId.get(screen.source.screenId) : undefined;
      const goal = (analysis?.kind === "screen" && analysis.description?.trim()) || title;
      // 画面 UI は JSON の写しを使う (モデルの値を mokkun に触らせない)
      const given = !placeholders.has(screen.id) && isObject(screen.view) ? (JSON.parse(JSON.stringify(screen.view)) as Partial<ViewV2>) : undefined;
      const base: ViewV2 = given ? ({ ...given, title, goal: given.goal ?? goal } as ViewV2) : placeholderView(model, screen, title, goal);
      // メニューに載っている画面は、現在地を示すために nav を付ける (画面 UI が決めていればそれを使う)
      const view: ViewV2 = inNavigation.has(screen.id) && base.nav === undefined ? { ...base, nav: screen.id } : base;

      // 遷移の操作の id は、画面 UI の操作の id と重ならないようにする (重なったら _2, _3 … を付ける。遷移は捨てない)
      const taken = actionIdsOf(view);
      const actions: ActionV2[] = [];
      for (const t of design.transitions) {
        if (t.from !== screen.id || t.via === "nav" || !names.has(t.to)) continue;
        let id = t.id;
        for (let n = 2; taken.has(id); n++) id = `${t.id}_${n}`;
        taken.add(id);
        actions.push({ id, label: t.label || names.get(t.to)!, kind: "navigate", to: t.to, style: "secondary" });
      }
      views[screen.id] = actions.length > 0 ? { ...view, secondaryActions: [...(Array.isArray(view.secondaryActions) ? view.secondaryActions : []), ...actions] } : view;
    }
    return views;
  };

  const viewErrors: Record<string, string> = {};
  let draft: MokkunV2Schema = { mokkun: 2, app, views: buildViews(new Set()) };
  let parsed = parseV2Document(draft);
  if (!parsed.success) {
    const { views: broken } = brokenViews(parsed.errors);
    const ids = new Set([...broken].filter((id) => design.screens.some((s) => s.id === id && isObject(s.view))));
    if (ids.size > 0) {
      for (const id of ids) viewErrors[id] = describeErrors(parsed.errors.filter((e) => e.path?.startsWith(`views.${id}.`) || e.path === `views.${id}`));
      draft = { mokkun: 2, app, views: buildViews(ids) };
      parsed = parseV2Document(draft);
    }
  }
  const doc: MokkunDoc = { schema: parsed.success ? parsed.data : draft, viewNameOf: (id) => id, viewErrors };
  if (!parsed.success) doc.error = describeErrors(parsed.errors);
  return doc;
}

const cache = new WeakMap<SystemDesign, { model: UntieModel; doc: MokkunDoc }>();

/** 組み立てた文書。モデルと設計だけで決まるので、選択やプレビューする画面が変わっても組み立て直さない (設計の参照とモデルが同じなら使い回す) */
export function cachedMokkunDoc(model: UntieModel, systemId: string, design: SystemDesign): MokkunDoc {
  const hit = cache.get(design);
  if (hit && hit.model === model) return hit.doc;
  const doc = buildMokkunSchema(model, systemId, design);
  cache.set(design, { model, doc });
  return doc;
}
