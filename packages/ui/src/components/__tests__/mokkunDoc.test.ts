import { describe, expect, it } from "vitest";
import { renderViewV2 } from "mokkun";
import { addDesignScreens, addTransition, setDesignLayout, setDesignNavigation, setDesignScreenShell } from "@untie/core/model/commands";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { okModel } from "@untie/core/testing";
import { buildMokkunSchema, cachedMokkunDoc, PLACEHOLDER_SECTION_TITLE } from "../design/mokkunDoc";
import { previewSrcDoc } from "../design/MokkunPreview";
import { mokkunCss } from "../design/mokkunStyles";

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "scr_1", kind: "screen", name: "予約検索", description: "予約を探す画面", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "予約登録", systemId: "sys_a" },
  { id: "info_1", kind: "information", name: "予約", contextId: null },
  { id: "info_2", kind: "information", name: "客", contextId: null },
] as Element[];
const PAIRS: [string, string, Relation["kind"]][] = [
  ["scr_1", "info_1", "screenInformation"],
  ["scr_1", "info_2", "screenInformation"],
];

function base(): UntieModel {
  const m = emptyModel();
  m.elements = ELEMENTS.map((e) => ({ ...e }));
  m.relations = PAIRS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  return m;
}

function setup(): UntieModel {
  let m = okModel(
    addDesignScreens(base(), {
      systemId: "sys_a",
      screens: [
        { id: "d_in", source: { kind: "builtin", builtin: "signIn" } },
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d2", source: { kind: "screen", screenId: "scr_2" } },
      ],
      transitions: [],
    }),
  );
  m = okModel(addTransition(m, { systemId: "sys_a", from: "d1", to: "d2", via: "button", label: "登録へ" }));
  m = okModel(addTransition(m, { systemId: "sys_a", from: "d_top", to: "d1", via: "nav" }));
  m = okModel(addTransition(m, { systemId: "sys_a", from: "d2", to: "d1" }));
  return m;
}
const designOf = (m: UntieModel) => m.designs.find((d) => d.systemId === "sys_a")!;

describe("buildMokkunSchema", () => {
  it("app.name は header のシステム名 (空なら対象システムの名前)、layout は設計のレイアウト。ナビゲーションの label は省略時は画面名", () => {
    let m = okModel(setDesignLayout(setup(), { systemId: "sys_a", shell: "plain", header: { userName: "田中", tenantName: "本店" } }));
    m = okModel(
      setDesignNavigation(m, {
        systemId: "sys_a",
        navigation: [
          { id: "nav_1", group: "予約", items: [{ screenId: "d1" }, { screenId: "d2", label: "登録" }] },
          { id: "nav_2", group: "空", items: [] },
        ],
      }),
    );
    const { schema, error } = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(error).toBeUndefined();
    expect(schema.mokkun).toBe(2);
    expect(schema.app.name).toBe("予約システム");
    // header が空なら header を付けない
    expect(buildMokkunSchema(setup(), "sys_a", designOf(setup())).schema.app.header).toBeUndefined();
    expect(schema.app.layout).toBe("plain");
    // mokkun の header.systemName (小さな補足) は使わない。app.name が本来の名前
    expect(schema.app.header).toEqual({ userName: "田中", tenantName: "本店" });
    // 項目の無いグループは出さない
    expect(schema.app.navigation).toEqual([{ group: "予約", items: [{ view: "d1", label: "予約検索" }, { view: "d2", label: "登録" }] }]);
    const m2 = okModel(setDesignLayout(m, { systemId: "sys_a", header: { systemName: "予約の画面" } }));
    const s2 = buildMokkunSchema(m2, "sys_a", designOf(m2)).schema;
    expect(s2.app.name).toBe("予約の画面");
    expect(s2.app.header?.systemName).toBeUndefined();
  });

  it("ナビゲーションが無ければ navigation を付けない。メニューにある画面にだけ nav を付ける", () => {
    const m = setup();
    expect(buildMokkunSchema(m, "sys_a", designOf(m)).schema.app.navigation).toBeUndefined();
    const m2 = okModel(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "d1" }] }] }));
    const { schema, error } = buildMokkunSchema(m2, "sys_a", designOf(m2));
    expect(error).toBeUndefined();
    expect(schema.views.d1!.nav).toBe("d1");
    expect(schema.views.d2!.nav).toBeUndefined();
  });

  it("view が無い画面は仮の 1 セクション: 分析の画面が使う情報を readonly の text で並べ、無ければ note だけ。goal は分析の説明、無ければ title", () => {
    const m = setup();
    const { schema, viewNameOf } = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(Object.keys(schema.views)).toEqual(["d_in", "d_top", "d1", "d2"]);
    expect(viewNameOf("d1")).toBe("d1");
    const v1 = schema.views.d1!;
    expect(v1.title).toBe("予約検索");
    expect(v1.goal).toBe("予約を探す画面");
    expect(v1.sections).toEqual([
      {
        id: "placeholder",
        title: PLACEHOLDER_SECTION_TITLE,
        kind: "readonly",
        fields: [
          { item: "info_1", label: "予約", component: "text", readonly: true },
          { item: "info_2", label: "客", component: "text", readonly: true },
        ],
      },
    ]);
    const v2 = schema.views.d2!;
    expect(v2.goal).toBe("予約登録");
    expect(v2.sections[0]).toMatchObject({ kind: "readonly", title: PLACEHOLDER_SECTION_TITLE, note: expect.any(String) });
    expect(v2.sections[0]!.fields).toBeUndefined();
    expect(schema.views.d_in!.title).toBe("サインイン");
    expect(schema.views.d_top!.title).toBe("トップページ");
  });

  it("view があればその中身をそのまま使う (sections・primaryAction・secondaryActions)。モデルの値は書き換えない", () => {
    let m = setup();
    const view = {
      title: "検索",
      goal: "探す",
      sections: [{ id: "s1", title: "条件", kind: "form", fields: [{ item: "q", label: "キーワード", component: "text" }] }],
      primaryAction: { id: "search", label: "検索する", kind: "submit" },
      secondaryActions: [{ id: "clear", label: "クリア", kind: "reset" }],
    };
    m = { ...m, designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "d1" ? { ...s, view } : s)) })) };
    const { schema, error } = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(error).toBeUndefined();
    const v = schema.views.d1!;
    // title は画面名が正
    expect(v.title).toBe("予約検索");
    expect(v.sections).toEqual(view.sections);
    expect(v.primaryAction).toEqual(view.primaryAction);
    // 画面の遷移は、画面 UI の副アクションのあとに足す
    expect(v.secondaryActions!.map((a) => a.id)).toEqual(["clear", designOf(m).transitions.find((t) => t.from === "d1")!.id]);
    expect(view.secondaryActions).toHaveLength(1);
  });

  it("遷移は secondaryActions に navigate で足す。label は遷移の文言か遷移先の画面名。きっかけがメニュー (nav) の遷移は足さない", () => {
    const m = setup();
    const { schema } = buildMokkunSchema(m, "sys_a", designOf(m));
    const ids = Object.fromEntries(designOf(m).transitions.map((t) => [`${t.from}>${t.to}`, t.id]));
    expect(schema.views.d1!.secondaryActions).toEqual([{ id: ids["d1>d2"], label: "登録へ", kind: "navigate", to: "d2", style: "secondary" }]);
    // 文言の無い遷移は遷移先の画面名
    expect(schema.views.d2!.secondaryActions).toEqual([{ id: ids["d2>d1"], label: "予約検索", kind: "navigate", to: "d1", style: "secondary" }]);
    // トップ → 予約検索は nav なので足さない
    expect(schema.views.d_top!.secondaryActions).toBeUndefined();
  });

  it("画面 UI が壊れた画面だけ仮の view に替え、理由はその画面にだけ出す。ほかの画面はそのまま", () => {
    let m = setup();
    m = { ...m, designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "d1" ? { ...s, view: { sections: [{ id: "s", title: "x", kind: "bogus" }] } } : s)) })) };
    const { schema, error, viewErrors } = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(error).toBeUndefined();
    expect(Object.keys(viewErrors)).toEqual(["d1"]);
    expect(viewErrors.d1).toContain("views.d1.sections[0].kind");
    expect(schema.views.d1!.sections[0]!.title).toBe(PLACEHOLDER_SECTION_TITLE);
    // 遷移は残る
    expect(schema.views.d1!.secondaryActions).toHaveLength(1);
    expect(schema.views.d2!.sections[0]!.title).toBe(PLACEHOLDER_SECTION_TITLE);
  });

  it("view の title は画面名が正。goal は view にあればそれ", () => {
    let m = setup();
    const view = { title: "別の名前", goal: "目的", sections: [{ id: "s", title: "x", kind: "readonly", note: "n" }] };
    m = { ...m, designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "d1" ? { ...s, view } : s)) })) };
    const v = buildMokkunSchema(m, "sys_a", designOf(m)).schema.views.d1!;
    expect(v.title).toBe("予約検索");
    expect(v.goal).toBe("目的");
  });

  it("遷移の操作の id が、画面 UI の操作 (副・セクション・一覧の行・一括) の id と重なったら付け直す。遷移は捨てない", () => {
    let m = setup();
    const trId = designOf(m).transitions.find((t) => t.from === "d1")!.id;
    const view = {
      title: "x",
      goal: "x",
      sections: [
        { id: "s", title: "x", kind: "form", fields: [{ item: "q", label: "q", component: "text" }], actions: [{ id: trId, label: "検索", kind: "custom" }] },
        { id: "l", title: "l", kind: "list", list: { columns: [{ id: "c", label: "c" }], rowActions: [{ id: `${trId}_2`, label: "行" }] } },
      ],
    };
    m = { ...m, designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "d1" ? { ...s, view } : s)) })) };
    const { schema, error, viewErrors } = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(error).toBeUndefined();
    expect(viewErrors).toEqual({});
    expect(schema.views.d1!.secondaryActions).toEqual([{ id: `${trId}_3`, label: "登録へ", kind: "navigate", to: "d2", style: "secondary" }]);
  });

  it("画面が 1 つも無い設計は検証に通らない", () => {
    const m = okModel(setDesignLayout(base(), { systemId: "sys_a" }));
    expect(buildMokkunSchema(m, "sys_a", designOf(m)).error).toBeDefined();
  });

  it("cachedMokkunDoc は、モデルと設計が同じなら同じ結果を返す", () => {
    const m = setup();
    const a = cachedMokkunDoc(m, "sys_a", designOf(m));
    expect(cachedMokkunDoc(m, "sys_a", designOf(m))).toBe(a);
    const m2 = okModel(setDesignLayout(m, { systemId: "sys_a", shell: "plain" }));
    expect(cachedMokkunDoc(m2, "sys_a", designOf(m2))).not.toBe(a);
  });
});

describe("描画", () => {
  it("renderViewV2 で、ヘッダー・ナビ・画面名・遷移のボタンが出る", () => {
    let m = setup();
    m = okModel(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "d1" }, { screenId: "d2" }] }] }));
    const { schema } = buildMokkunSchema(m, "sys_a", designOf(m));
    const html = renderViewV2(schema, "d1");
    expect(html).toContain('class="mokkun-v2"');
    expect(html).toContain("mk2-header");
    expect(html).toContain('data-nav-view="d2"');
    expect(html).toContain(PLACEHOLDER_SECTION_TITLE);
    expect(html).toMatch(/data-navigate-to="d2"/);
    expect(html).toContain("登録へ");
  });

  it("v2 の CSS を mokkun の MOKKUN_V2_CSS から作り、親の document には差さない。srcdoc に CSS と HTML が入る", () => {
    const css = mokkunCss();
    expect(css).toContain(".mk2-header");
    expect(css).toContain(".dads-");
    // 外部のフォントを読む @import は取り除く
    expect(css).not.toContain("@import");
    expect(css).not.toContain("fonts.googleapis.com");
    expect(document.getElementById("mokkun-v2-styles")).toBeNull();
    const m = setup();
    const { schema } = buildMokkunSchema(m, "sys_a", designOf(m));
    const src = previewSrcDoc(schema, "d1");
    expect(src.startsWith("<!doctype html>")).toBe(true);
    expect(src).toContain("<style>");
    expect(src).toContain(css.slice(0, 200));
    expect(src).toContain('class="mokkun-v2"');
    // goal は画面に出さない (右のペインで編集する) ので、mokkun が見出しの上に描く shoulder を隠す CSS が入っている
    expect(src).toContain(".mokkun-v2 .mk2-view-head .dads-heading__shoulder { display: none; }");
  });

  it("画面ごとのレイアウトの上書き: shellOf は画面の上書き、無ければ設計のレイアウト。プレビューはその画面を描くときだけ app.layout を差し替える", () => {
    const nav = { systemId: "sys_a", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "d1" }, { screenId: "d2" }] }] };
    let m = okModel(setDesignNavigation(setup(), nav));
    m = okModel(setDesignScreenShell(m, { systemId: "sys_a", screenId: "d_in", shell: "plain" }));
    const doc = buildMokkunSchema(m, "sys_a", designOf(m));
    expect(doc.shellOf("d_in")).toBe("plain");
    expect(doc.shellOf("d1")).toBe("shell");
    // 文書の app.layout は設計のまま
    expect(doc.schema.app.layout).toBe("shell");
    // CSS にも mk2-globalnav があるので、body だけを見る
    const bodyOf = (src: string) => src.slice(src.indexOf("<body>"));
    const plainHtml = bodyOf(previewSrcDoc(doc.schema, "d_in", doc.shellOf("d_in")));
    const shellHtml = bodyOf(previewSrcDoc(doc.schema, "d1", doc.shellOf("d1")));
    expect(plainHtml).not.toContain("mk2-globalnav");
    expect(shellHtml).toContain("mk2-globalnav");
    // 元の文書は書き換えない
    expect(doc.schema.app.layout).toBe("shell");
    // 設計が plain で、上書きで shell にする
    let m2 = okModel(setDesignLayout(okModel(setDesignNavigation(setup(), nav)), { systemId: "sys_a", shell: "plain" }));
    m2 = okModel(setDesignScreenShell(m2, { systemId: "sys_a", screenId: "d1", shell: "shell" }));
    const doc2 = buildMokkunSchema(m2, "sys_a", designOf(m2));
    expect(doc2.shellOf("d1")).toBe("shell");
    expect(doc2.shellOf("d2")).toBe("plain");
    expect(bodyOf(previewSrcDoc(doc2.schema, "d1", doc2.shellOf("d1")))).toContain("mk2-globalnav");
  });

  it("画面名・グループ名の <script> は srcdoc でエスケープされる", () => {
    let m = setup();
    m = { ...m, elements: m.elements.map((e) => (e.id === "scr_1" ? { ...e, name: "<script>alert(1)</script>" } : e)) };
    m = okModel(setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "<script>g</script>", items: [{ screenId: "d1" }, { screenId: "d2" }] }] }));
    const { schema } = buildMokkunSchema(m, "sys_a", designOf(m));
    const src = previewSrcDoc(schema, "d1");
    expect(src).not.toContain("<script");
    expect(src).toContain("&lt;script&gt;");
  });
});
