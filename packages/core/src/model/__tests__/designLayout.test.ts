import { describe, expect, it } from "vitest";
import { addDesignScreens, addTransition, setDesignLayout, setDesignNavigation } from "../commands";
import { checkDesign } from "../designCheck";
import { NAME_MAX_LENGTH } from "../limits";
import { addSitemapScreens, navigationFromSitemap } from "../sitemap";
import { emptyModel, type Element, type Relation, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { retailSample } from "../../sample";
import { expectFail, okModel } from "./helpers";

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "sys_b", kind: "system", name: "会計システム" },
  { id: "actor_1", kind: "actor", name: "受付" },
  { id: "biz_1", kind: "business", name: "予約" },
  { id: "buc_1", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
  { id: "biz_2", kind: "business", name: "請求" },
  { id: "buc_2", kind: "buc", name: "請求", businessId: "biz_2", isDefault: true },
  { id: "act_1", kind: "activity", name: "受ける", bucId: "buc_1" },
  { id: "act_2", kind: "activity", name: "請求する", bucId: "buc_2" },
  { id: "uc_1", kind: "usecase", name: "検索する" },
  { id: "uc_2", kind: "usecase", name: "登録する" },
  { id: "uc_3", kind: "usecase", name: "請求を見る" },
  { id: "scr_1", kind: "screen", name: "検索", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "登録", systemId: "sys_a" },
  { id: "scr_3", kind: "screen", name: "請求一覧", systemId: "sys_a" },
  { id: "scr_4", kind: "screen", name: "どこにも使わない", systemId: "sys_a" },
] as Element[];

const PAIRS: [string, string, Relation["kind"]][] = [
  ["actor_1", "act_1", "actorActivity"],
  ["actor_1", "act_2", "actorActivity"],
  ["act_1", "uc_1", "activityUsecase"],
  ["act_1", "uc_2", "activityUsecase"],
  ["act_2", "uc_3", "activityUsecase"],
  ["uc_1", "scr_1", "usecaseScreen"],
  ["uc_2", "scr_2", "usecaseScreen"],
  ["uc_3", "scr_3", "usecaseScreen"],
];

function base(): UntieModel {
  const m = emptyModel();
  m.elements = ELEMENTS.map((e) => ({ ...e }));
  m.relations = PAIRS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  return m;
}

/** 設計に、サインイン・トップ・検索・登録・請求一覧・使わない画面を足したもの (遷移は無し) */
function withScreens(): UntieModel {
  return okModel(
    addDesignScreens(base(), {
      systemId: "sys_a",
      screens: [
        { id: "d_in", source: { kind: "builtin", builtin: "signIn" } },
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d2", source: { kind: "screen", screenId: "scr_2" } },
        { id: "d3", source: { kind: "screen", screenId: "scr_3" } },
        { id: "d4", source: { kind: "screen", screenId: "scr_4" } },
      ],
      transitions: [],
    }),
  );
}

const layoutOf = (m: UntieModel) => m.designs.find((d) => d.systemId === "sys_a")!.layout;

describe("setDesignLayout", () => {
  it("設計が無ければ作り、共通の枠とヘッダーを変える。値は前後の空白を除く", () => {
    const m = okModel(setDesignLayout(base(), { systemId: "sys_a", shell: "plain", header: { systemName: " 予約 ", userName: "田中" } }));
    expect(layoutOf(m)).toEqual({ shell: "plain", header: { systemName: "予約", userName: "田中" }, navigation: [] });
    expect(validateModel(m).ok).toBe(true);
  });

  it("header は項目ごとに変える。空にした項目は消え、すべて消えたら header ごと消える", () => {
    let m = okModel(setDesignLayout(base(), { systemId: "sys_a", header: { systemName: "A", tenantName: "T" } }));
    m = okModel(setDesignLayout(m, { systemId: "sys_a", header: { userName: "U" } }));
    expect(layoutOf(m).header).toEqual({ systemName: "A", tenantName: "T", userName: "U" });
    m = okModel(setDesignLayout(m, { systemId: "sys_a", header: { systemName: "  ", tenantName: "" } }));
    expect(layoutOf(m).header).toEqual({ userName: "U" });
    m = okModel(setDesignLayout(m, { systemId: "sys_a", header: { userName: "" } }));
    expect(layoutOf(m).header).toBeUndefined();
    // shell だけ変えても header は変わらない
    m = okModel(setDesignLayout(m, { systemId: "sys_a", shell: "plain" }));
    expect(layoutOf(m).shell).toBe("plain");
  });

  it("システムが無い・枠が正しくない・名前が長すぎるときは失敗する。失敗しても変わらない", () => {
    expectFail(setDesignLayout(base(), { systemId: "nope" }), /システムが存在しません/);
    expectFail(setDesignLayout(base(), { systemId: "sys_a", shell: "x" as "shell" }), /レイアウトが正しくありません/);
    expectFail(setDesignLayout(base(), { systemId: "sys_a", header: { userName: "あ".repeat(NAME_MAX_LENGTH + 1) } }), /200 文字/);
  });
});

describe("setDesignNavigation", () => {
  it("ナビゲーションを置き換える。group・label は前後の空白を除き、空の label は省く", () => {
    const m = okModel(
      setDesignNavigation(withScreens(), {
        systemId: "sys_a",
        navigation: [
          { id: "nav_1", group: " 予約 ", items: [{ screenId: "d1", label: " 探す " }, { screenId: "d2", label: "  " }] },
          { id: "nav_2", group: "請求", items: [{ screenId: "d3" }] },
        ],
      }),
    );
    expect(layoutOf(m).navigation).toEqual([
      { id: "nav_1", group: "予約", items: [{ screenId: "d1", label: "探す" }, { screenId: "d2" }] },
      { id: "nav_2", group: "請求", items: [{ screenId: "d3" }] },
    ]);
    expect(validateModel(m).ok).toBe(true);
    // もう一度置き換えるときは、今のグループと同じ id を使ってよい
    const again = okModel(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "だけ", items: [] }] }));
    expect(layoutOf(again).navigation).toEqual([{ id: "nav_1", group: "だけ", items: [] }]);
  });

  it("id は一意: 同じ id の重複、画面・遷移の id との重なり、ほかの設計のグループとの重なりは失敗する", () => {
    const m = okModel(addTransition(withScreens(), { systemId: "sys_a", from: "d1", to: "d2" }));
    expectFail(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "n", group: "a", items: [] }, { id: "n", group: "b", items: [] }] }), /重なって/);
    expectFail(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "d1", group: "a", items: [] }] }), /重なって/);
    expectFail(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "", group: "a", items: [] }] }), /id が空/);
    const other = okModel(setDesignNavigation(okModel(setDesignLayout(m, { systemId: "sys_b" })), { systemId: "sys_b", navigation: [{ id: "nav_b", group: "x", items: [] }] }));
    expectFail(setDesignNavigation(other, { systemId: "sys_a", navigation: [{ id: "nav_b", group: "a", items: [] }] }), /重なって/);
  });

  it("画面は設計の画面だけ。名前の上限を超えると失敗する", () => {
    expectFail(setDesignNavigation(withScreens(), { systemId: "sys_a", navigation: [{ id: "n", group: "a", items: [{ screenId: "scr_1" }] }] }), /設計に無い画面/);
    expectFail(setDesignNavigation(withScreens(), { systemId: "sys_a", navigation: [{ id: "n", group: "あ".repeat(NAME_MAX_LENGTH + 1), items: [] }] }), /200 文字/);
    expectFail(setDesignNavigation(withScreens(), { systemId: "sys_a", navigation: [{ id: "n", group: "a", items: [{ screenId: "d1", label: "あ".repeat(NAME_MAX_LENGTH + 1) }] }] }), /200 文字/);
  });
});

describe("navigationFromSitemap", () => {
  it("画面を、その画面を使う操作の業務ごとにグループ化する。トップは「ホーム」の先頭、サインインは入れない、業務に入らない画面は「その他」", () => {
    const m = withScreens();
    const nav = navigationFromSitemap(m, "sys_a");
    expect(nav.map((g) => [g.group, g.items.map((i) => i.screenId)])).toEqual([
      ["ホーム", ["d_top"]],
      ["予約", ["d1", "d2"]],
      ["請求", ["d3"]],
      ["その他", ["d4"]],
    ]);
    expect(new Set(nav.map((g) => g.id)).size).toBe(4);
    expect(nav.every((g) => g.id.startsWith("nav_"))).toBe(true);
    // そのまま設定できる
    expect(setDesignNavigation(m, { systemId: "sys_a", navigation: nav }).ok).toBe(true);
  });

  it("ホームがあれば「ホーム」の先頭はホーム。トップページ (未ログインの画面) とサインインは入れない", () => {
    const m = okModel(addSitemapScreens(withScreens(), "sys_a", [{ kind: "builtin", builtin: "home" }]));
    const home = m.designs[0]!.screens.find((s) => s.source.kind === "builtin" && s.source.builtin === "home")!;
    const nav = navigationFromSitemap(m, "sys_a");
    expect(nav[0]).toMatchObject({ group: "ホーム", items: [{ screenId: home.id }] });
    const ids = nav.flatMap((g) => g.items.map((i) => i.screenId));
    expect(ids).not.toContain("d_top");
    expect(ids).not.toContain("d_in");
    expect(ids).toContain("d1");
  });

  it("トップページが無ければ「ホーム」を作らない。設計が無ければ空", () => {
    const m = okModel(addDesignScreens(base(), { systemId: "sys_a", screens: [{ id: "d1", source: { kind: "screen", screenId: "scr_1" } }], transitions: [] }));
    expect(navigationFromSitemap(m, "sys_a").map((g) => g.group)).toEqual(["予約"]);
    expect(navigationFromSitemap(base(), "sys_a")).toEqual([]);
  });

  it("店舗サンプルでも、全画面を 1 回ずつ並べる", () => {
    const nav = navigationFromSitemap(retailSample, "sys_pos");
    const ids = nav.flatMap((g) => g.items.map((i) => i.screenId));
    const design = retailSample.designs[0]!;
    expect(ids.sort()).toEqual(design.screens.filter((s) => s.id !== "ds_pos_signin" && s.id !== "ds_pos_top").map((s) => s.id).sort());
    expect(nav[0]!.group).toBe("ホーム");
    expect(nav[0]!.items).toEqual([{ screenId: "ds_pos_home" }]);
  });
});

describe("検証: メニューからも遷移からも辿れない画面", () => {
  const unreachable = (m: UntieModel) => checkDesign(m, "sys_a").warnings.filter((w) => w.type === "screenUnreachable");

  it("メニューにも、ほかの画面からの遷移にも無い画面を、画面ごとに 1 行出す。サインイン・トップは除く", () => {
    const warns = unreachable(withScreens());
    expect(warns.map((w) => w.target)).toEqual([
      { kind: "screen", id: "d1" },
      { kind: "screen", id: "d2" },
      { kind: "screen", id: "d3" },
      { kind: "screen", id: "d4" },
    ]);
    expect(warns[0]!.message).toContain("検索");
  });

  it("ホームも除く。トップページ・サインイン・ホームは辿れる画面を数えない", () => {
    const m = okModel(addSitemapScreens(withScreens(), "sys_a", [{ kind: "builtin", builtin: "home" }]));
    expect(unreachable(m).map((w) => w.target!.id)).toEqual(["d1", "d2", "d3", "d4"]);
  });

  it("shell が plain のときはメニューを数えない。メニューの遷移は、行き先がメニューに載っているときだけ数える。自分自身への遷移は数えない", () => {
    const nav = [{ id: "nav_1", group: "g", items: [{ screenId: "d1" }] }];
    let m = okModel(setDesignNavigation(withScreens(), { systemId: "sys_a", navigation: nav }));
    expect(unreachable(m).map((w) => w.target!.id)).toEqual(["d2", "d3", "d4"]);
    // plain ではメニューが出ないので、d1 も辿れない
    m = okModel(setDesignLayout(m, { systemId: "sys_a", shell: "plain" }));
    expect(unreachable(m).map((w) => w.target!.id)).toEqual(["d1", "d2", "d3", "d4"]);
    // きっかけがメニューの遷移は、メニューに載っていない行き先 (d2) には数えない
    m = okModel(addTransition(m, { systemId: "sys_a", from: "d_top", to: "d2", via: "nav" }));
    expect(unreachable(m).map((w) => w.target!.id)).toContain("d2");
    m = okModel(setDesignLayout(m, { systemId: "sys_a", shell: "shell" }));
    expect(unreachable(m).map((w) => w.target!.id)).toContain("d2");
    // 自分自身への遷移は数えない (そもそも足せない)
    expectFail(addTransition(m, { systemId: "sys_a", from: "d3", to: "d3" }));
    expect(unreachable(m).map((w) => w.target!.id)).toContain("d3");
    // きっかけがボタンなら数える
    m = okModel(addTransition(m, { systemId: "sys_a", from: "d1", to: "d2", via: "button" }));
    expect(unreachable(m).map((w) => w.target!.id)).not.toContain("d2");
  });

  it("ナビゲーションに入れるか、遷移を足すと出なくなる", () => {
    let m = okModel(addTransition(withScreens(), { systemId: "sys_a", from: "d1", to: "d2" }));
    expect(unreachable(m).map((w) => w.target!.id)).toEqual(["d1", "d3", "d4"]);
    m = okModel(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "g", items: [{ screenId: "d1" }, { screenId: "d3" }] }] }));
    expect(unreachable(m).map((w) => w.target!.id)).toEqual(["d4"]);
  });
});

describe("店舗サンプルのレイアウト", () => {
  it("shell があり、ナビゲーションは 4 グループ。検証の警告にメニューから辿れない画面は無い", () => {
    const layout = retailSample.designs[0]!.layout;
    expect(layout.shell).toBe("shell");
    // ヘッダーのシステム名は空 (対象システムの名前を出す)
    expect(layout.header).toBeUndefined();
    expect(layout.navigation.map((g) => g.group)).toEqual(["ホーム", "レジ", "商品・在庫", "売上"]);
    expect(checkDesign(retailSample, "sys_pos").warnings.filter((w) => w.type === "screenUnreachable")).toEqual([]);
    expect(validateModel(retailSample).ok).toBe(true);
  });
});
