import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDatabase, addDesignScreens, addTransition, setDatabaseDesign, setDesignDatabases, setDesignScreenView } from "@untie/core/model/commands";
import { checkDesign } from "@untie/core/model/designCheck";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { okModel } from "@untie/core/testing";
import type { ChatOptions } from "../../ai/chat";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { cachedMokkunDoc } from "../design/mokkunDoc";
import { ScreenBoard } from "../design/ScreenBoard";
import { ScreenBuilder } from "../design/ScreenBuilder";
import { ScreenListPane } from "../design/ScreenListPane";
import { revealDesignProblem } from "../design/DesignCheckPanel";
import { parseViewYaml } from "../design/ScreenYamlEditor";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const ai = vi.hoisted(() => ({ key: null as string | null, sent: [] as string[], submissions: [] as unknown[], results: [] as { ok: boolean; content: string }[], text: "" }));
vi.mock("../../ai/keys", () => ({ getApiKey: async () => ai.key, setApiKey: async () => {}, deleteApiKey: async () => {}, isApiKeyRemembered: () => false }));
vi.mock("../../ai/chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string) => {
        ai.sent.push(text);
        while (ai.submissions.length > 0) {
          const r = await o.runTool("submit_screen", ai.submissions.shift());
          ai.results.push(r);
          if (r.ok) break;
        }
        return ai.text;
      },
    }),
  };
});

const st = () => useUntieStore.getState();

const DSL = `model Item {
  id    String @id
  name  String
  price Int
}

model Sale {
  id    String @id
  total Int
}
`;

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "actor_1", kind: "actor", name: "受付" },
  { id: "biz_1", kind: "business", name: "予約" },
  { id: "buc_1", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
  { id: "act_1", kind: "activity", name: "受ける", bucId: "buc_1" },
  { id: "uc_1", kind: "usecase", name: "検索する" },
  { id: "uc_2", kind: "usecase", name: "登録する" },
  { id: "scr_1", kind: "screen", name: "予約検索", description: "予約を探す", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "予約登録", systemId: "sys_a" },
] as Element[];
const PAIRS: [string, string, Relation["kind"]][] = [
  ["actor_1", "act_1", "actorActivity"],
  ["act_1", "uc_1", "activityUsecase"],
  ["act_1", "uc_2", "activityUsecase"],
  ["uc_1", "scr_1", "usecaseScreen"],
  ["uc_2", "scr_2", "usecaseScreen"],
];

const VIEW = {
  title: "予約検索",
  goal: "探す",
  sections: [
    { id: "cond", title: "条件", kind: "form", fields: [{ item: "keyword", label: "キーワード", component: "text" }] },
    { id: "res", title: "結果", kind: "list", list: { columns: [{ id: "name", label: "名前" }] } },
  ],
};

/** 設計: トップページ・予約検索 (d1)・予約登録 (d2)。d1 → d2 の遷移。DB db_x (Item, Sale) を使う。d1 に画面 UI 無し */
function withDesign(view?: unknown): UntieModel {
  const m0 = emptyModel();
  m0.elements = ELEMENTS.map((e) => ({ ...e }));
  m0.relations = PAIRS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  m0.boards = [{ id: "board_1", name: "全体", nodes: [] }];
  let m = okModel(
    addDesignScreens(m0, {
      systemId: "sys_a",
      screens: [
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d2", source: { kind: "screen", screenId: "scr_2" } },
      ],
      transitions: [],
    }),
  );
  m = okModel(addTransition(m, { systemId: "sys_a", from: "d1", to: "d2", via: "button", label: "登録へ" }));
  m = okModel(addDatabase(m, { id: "db_x", name: "予約DB" }));
  m = okModel(setDatabaseDesign(m, { id: "db_x", dsl: DSL, tables: [] }));
  m = okModel(setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_x"] }));
  if (view !== undefined) m = okModel(setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: view as Record<string, unknown> }));
  return m;
}

const screenOf = (id = "d1") => st().model.designs[0]!.screens.find((s) => s.id === id)!;
const view = () => screenOf().view as any;
const toasts = () => st().toasts.map((t) => t.message);
const pastLength = () => st().history.past.length;
const commit = (label: string, value: string) => {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};
const pick = (label: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });

function setup(v?: unknown, select = "d1") {
  resetStore(withDesign(v));
  act(() => st().enterDesign("sys_a"));
  if (select) act(() => st().selectDesignScreen(select));
}

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null });
  ai.key = null;
  ai.sent = [];
  ai.submissions = [];
  ai.results = [];
  ai.text = "";
  setup();
});
afterEach(cleanup);

describe("ScreenListPane", () => {
  it("設計の画面を並べ、画面 UI のある画面に「UI あり」、入口の画面に「入口」の印を付ける", () => {
    setup(VIEW);
    render(<ScreenListPane />);
    const rows = document.querySelectorAll("[data-screen-id]");
    expect(Array.from(rows).map((r) => r.getAttribute("data-screen-id"))).toEqual(["d_top", "d1", "d2"]);
    const d1 = document.querySelector('[data-screen-id="d1"]')!;
    expect(within(d1 as HTMLElement).getByText("UI あり")).toBeDefined();
    expect(within(d1 as HTMLElement).getByText("入口")).toBeDefined();
    expect(within(document.querySelector('[data-screen-id="d2"]') as HTMLElement).queryByText("UI あり")).toBeNull();
  });

  it("押すとその画面を選ぶ。選んでいる画面は強調する", () => {
    render(<ScreenListPane />);
    fireEvent.click(screen.getByRole("button", { name: "予約登録" }));
    expect(st().ui.designScreenId).toBe("d2");
    expect(screen.getByRole("button", { name: "予約登録" }).getAttribute("aria-current")).toBe("true");
  });

  it("画面が無ければ案内を出す", () => {
    resetStore(emptyModel());
    render(<ScreenListPane />);
    expect(screen.getByText("サイトマップで画面を足してください。")).toBeDefined();
  });
});

describe("ScreenBoard (中央)", () => {
  it("何も選んでいなければ案内を出す", () => {
    setup(undefined, "");
    render(<ScreenBoard />);
    expect(screen.getByText("左の一覧から画面を選んでください")).toBeDefined();
    expect(screen.queryByTitle("画面のプレビュー")).toBeNull();
  });

  it("選んだ画面を mokkun で描く。画面 UI の項目が出る", () => {
    setup(VIEW);
    render(<ScreenBoard />);
    const src = (screen.getByTitle("画面のプレビュー") as HTMLIFrameElement).getAttribute("srcdoc")!;
    expect(src).toContain('data-view="d1"');
    expect(src).toContain("キーワード");
    expect(screen.queryByText("この画面の問題")).toBeNull();
  });

  it("画面 UI が mokkun の検証に通らなければ「この画面の問題」を出し、仮の画面を描く", () => {
    setup({ sections: [{ id: "s", title: "x", kind: "bogus" }] });
    render(<ScreenBoard />);
    expect(screen.getByText("この画面の問題")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("views.d1.sections[0].kind");
    expect(screen.getByTitle("画面のプレビュー")).toBeDefined();
  });
});

describe("ScreenBuilder: 画面 UI の無い画面", () => {
  it("画面を選んでいなければ案内を出す", () => {
    setup(undefined, "");
    render(<ScreenBuilder />);
    expect(screen.getByText(/左の一覧から画面を選ぶと/)).toBeDefined();
  });

  it("「画面 UI を作る」で、画面の名前と分析の説明を目的にした空の画面 UI ができる (履歴は 1 件)", () => {
    render(<ScreenBuilder />);
    expect(screen.getByText("この画面には、画面 UI がまだありません。")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "画面 UI を作る" }));
    expect(view()).toMatchObject({ title: "予約検索", goal: "予約を探す", sections: [{ id: "main", kind: "form", fields: [] }] });
    expect(pastLength()).toBe(1);
  });
});

describe("ScreenBuilder: フォームの編集", () => {
  beforeEach(() => {
    setup(VIEW);
  });

  it("画面の基本: goal と layout。goal を空にすると消え、placeholder は分析の説明", () => {
    render(<ScreenBuilder />);
    expect((screen.getByRole("textbox", { name: "画面の目的 (goal)" }) as HTMLInputElement).value).toBe("探す");
    commit("画面の目的 (goal)", "予約を探して開く");
    expect(view().goal).toBe("予約を探して開く");
    pick("セクションの並べ方 (layout)", "tabs");
    expect(view().layout).toBe("tabs");
    pick("セクションの並べ方 (layout)", "");
    expect(view().layout).toBeUndefined();
    commit("画面の目的 (goal)", "");
    expect(view().goal).toBeUndefined();
    expect((screen.getByRole("textbox", { name: "画面の目的 (goal)" }) as HTMLInputElement).placeholder).toBe("予約を探す");
  });

  it("セクション: 見出し・種類・列数・注記を変え、並べ替え・追加・削除ができる。1 回の操作が 1 件の履歴", () => {
    render(<ScreenBuilder />);
    commit("セクション 1 の見出し", "検索条件");
    expect(view().sections[0].title).toBe("検索条件");
    pick("セクション 1 の列数", "2");
    expect(view().sections[0].columns).toBe(2);
    pick("セクション 1 の列数", "");
    expect(view().sections[0].columns).toBeUndefined();
    commit("セクション 1 の注記", "どれか 1 つ");
    expect(view().sections[0].note).toBe("どれか 1 つ");
    pick("セクション 1 の種類", "readonly");
    expect(view().sections[0].kind).toBe("readonly");

    const before = pastLength();
    fireEvent.click(screen.getByRole("button", { name: "セクション 1 を下へ" }));
    expect(view().sections.map((s: { id: string }) => s.id)).toEqual(["res", "cond"]);
    expect(pastLength()).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "＋セクション" }));
    expect(view().sections).toHaveLength(3);
    expect(view().sections[2]).toMatchObject({ id: "section1", kind: "form", fields: [] });
    fireEvent.click(screen.getByRole("button", { name: "セクション 3 を削除" }));
    expect(view().sections).toHaveLength(2);
  });

  it("種類の切り替え: 項目のあるセクションを list にするときは確認して項目を消し、列を 1 つ作る。form に戻すと list を消す。どちらも mokkun の検証に通る", () => {
    // d1 を他の画面にも見える形で使うため、プレビュー用の文書を組み立てて検証する
    const errors = () => cachedMokkunDoc(st().model, "sys_a", st().model.designs[0]!).viewErrors;
    render(<ScreenBuilder />);
    pick("セクション 1 の種類", "list");
    expect(view().sections[0].kind).toBe("form");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(view().sections[0].kind).toBe("form");
    pick("セクション 1 の種類", "list");
    fireEvent.click(screen.getByRole("button", { name: "項目を消して一覧にする" }));
    expect(view().sections[0].kind).toBe("list");
    expect(view().sections[0].fields).toBeUndefined();
    expect(view().sections[0].list.columns).toHaveLength(1);
    expect(errors()).toEqual({});
    pick("セクション 1 の種類", "summary");
    expect(view().sections[0].list).toBeUndefined();
    expect(view().sections[0].kind).toBe("summary");
    expect(errors()).toEqual({});
    // 項目の無いセクションは、確認なしで list にできる
    pick("セクション 1 の種類", "list");
    expect(view().sections[0].list.columns).toHaveLength(1);
    expect(errors()).toEqual({});
    // 列の対応: 切り替えた古い項目の対応は残らない
    expect(screenOf().bindings).toBeUndefined();
  });

  it("識別子・列 id を空や重複にする変更は断ってトーストで知らせ、条件 (visibleWhen) と代表行 (rows) のキーは一緒に書き換わる", () => {
    const v = {
      title: "t",
      goal: "g",
      sections: [
        { id: "f", title: "入力", kind: "form", fields: [{ item: "a", label: "A", component: "text" }, { item: "b", label: "B", component: "text", visibleWhen: { item: "a", equals: "x" }, requiredWhen: { item: "a", equals: "y" } }] },
        { id: "l", title: "一覧", kind: "list", list: { columns: [{ id: "c1", label: "C1" }, { id: "c2", label: "C2" }], rows: [{ c1: "1", c2: "2" }] } },
      ],
    };
    setup(v);
    render(<ScreenBuilder />);
    const before = pastLength();
    commit("項目 1-1 の識別子", "");
    expect(toasts().some((t) => t.includes("空にできません"))).toBe(true);
    commit("項目 1-1 の識別子", "b");
    expect(toasts().some((t) => t.includes("すでに使っています"))).toBe(true);
    commit("列 2-1 の id", "c2");
    expect(toasts().filter((t) => t.includes("すでに使っています"))).toHaveLength(2);
    commit("列 2-1 の id", "");
    expect(pastLength()).toBe(before);
    expect((screen.getByRole("textbox", { name: "項目 1-1 の識別子" }) as HTMLInputElement).value).toBe("a");

    commit("項目 1-1 の識別子", "code");
    expect(view().sections[0].fields[1].visibleWhen.item).toBe("code");
    expect(view().sections[0].fields[1].requiredWhen.item).toBe("code");
    commit("列 2-1 の id", "first");
    expect(view().sections[1].list.rows).toEqual([{ first: "1", c2: "2" }]);
    expect(cachedMokkunDoc(st().model, "sys_a", st().model.designs[0]!).viewErrors).toEqual({});
  });

  it("同時編集で並びが変わっても、id で探して同じものを直す", () => {
    render(<ScreenBuilder />);
    const input = screen.getByRole("textbox", { name: "項目 1-1 のラベル" });
    // 入力の途中で、他の人がセクションの先頭へ別のセクションを足した (描き直しで入力欄が作り直され、書きかけが確定する)
    fireEvent.change(input, { target: { value: "変えた" } });
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { ...VIEW, sections: [{ id: "other", title: "他", kind: "readonly", note: "n" }, ...VIEW.sections] } }));
    });
    expect(view().sections.map((s: { id: string }) => s.id)).toEqual(["other", "cond", "res"]);
    expect(view().sections[1].fields[0].label).toBe("変えた");
  });

  it("項目: 追加・識別子・ラベル・部品・必須・読み取り専用・並べ替え・削除", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "セクション 1 に項目を足す" }));
    expect(view().sections[0].fields[1]).toEqual({ item: "item1", label: "新しい項目", component: "text" });
    commit("項目 1-2 の識別子", "price");
    commit("項目 1-2 のラベル", "価格");
    pick("項目 1-2 の部品", "number");
    fireEvent.click(screen.getByRole("checkbox", { name: "項目 1-2 は必須" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "項目 1-2 は読み取り専用" }));
    expect(view().sections[0].fields[1]).toEqual({ item: "price", label: "価格", component: "number", required: true, readonly: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "項目 1-2 は必須" }));
    expect(view().sections[0].fields[1].required).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "項目 1-2 を上へ" }));
    expect(view().sections[0].fields.map((f: { item: string }) => f.item)).toEqual(["price", "keyword"]);
    fireEvent.click(screen.getByRole("button", { name: "項目 1-1 を削除" }));
    expect(view().sections[0].fields.map((f: { item: string }) => f.item)).toEqual(["keyword"]);
  });

  it("列の対応: データベース → テーブル → 列の 3 つを選ぶと bindings に item をキーで入る。「なし」で外れる。項目の名前を変えると対応も付いてくる", () => {
    render(<ScreenBuilder />);
    pick("項目 1-1 の使うデータベース", "db_x");
    // 3 つ揃うまでは保存しない
    expect(screenOf().bindings).toBeUndefined();
    pick("項目 1-1 のテーブル", "Item");
    expect(screenOf().bindings).toBeUndefined();
    // 列の選択肢はテーブルの列
    const cols = within(screen.getByRole("combobox", { name: "項目 1-1 の列" })).getAllByRole("option").map((o) => o.textContent);
    expect(cols).toEqual(["列を選ぶ", "id", "name", "price"]);
    const before = pastLength();
    pick("項目 1-1 の列", "name");
    expect(screenOf().bindings).toEqual([{ item: "keyword", databaseId: "db_x", table: "Item", column: "name" }]);
    expect(pastLength()).toBe(before + 1);

    commit("項目 1-1 の識別子", "q");
    expect(screenOf().bindings).toEqual([{ item: "q", databaseId: "db_x", table: "Item", column: "name" }]);
    expect((screen.getByRole("combobox", { name: "項目 1-1 の列" }) as HTMLSelectElement).value).toBe("name");

    pick("項目 1-1 の使うデータベース", "");
    expect(screenOf().bindings).toBeUndefined();
    expect(screen.queryByRole("combobox", { name: "項目 1-1 のテーブル" })).toBeNull();
  });

  it("項目を消すと、その項目の対応も外れる", () => {
    setup({ ...VIEW });
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [{ item: "keyword", databaseId: "db_x", table: "Item", column: "name" }, { item: "res.name", databaseId: "db_x", table: "Item", column: "name" }] }));
    });
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "項目 1-1 を削除" }));
    expect(screenOf().bindings).toEqual([{ item: "res.name", databaseId: "db_x", table: "Item", column: "name" }]);
  });

  it("一覧: 列の追加・id・見出し・型・遷移先・列の対応 (キーは <セクションの id>.<列の id>)・検索・選択・ページの行数", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "セクション 2 に列を足す" }));
    expect(view().sections[1].list.columns[1]).toEqual({ id: "col1", label: "新しい列" });
    commit("列 2-2 の id", "price");
    commit("列 2-2 の見出し", "価格");
    pick("列 2-2 の型", "number");
    pick("列 2-2 の遷移先", "d2");
    expect(view().sections[1].list.columns[1]).toEqual({ id: "price", label: "価格", type: "number", to: "d2" });
    pick("列 2-2 の使うデータベース", "db_x");
    pick("列 2-2 のテーブル", "Item");
    pick("列 2-2 の列", "price");
    expect(screenOf().bindings).toEqual([{ item: "res.price", databaseId: "db_x", table: "Item", column: "price" }]);
    // 列の id を変えると対応のキーも変わる
    commit("列 2-2 の id", "amount");
    expect(screenOf().bindings![0]!.item).toBe("res.amount");
    pick("列 2-2 の遷移先", "");
    expect(view().sections[1].list.columns[1].to).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: "セクション 2 は検索あり" }));
    pick("セクション 2 の行の選択", "multiple");
    commit("セクション 2 の 1 ページの行数", "25");
    expect(view().sections[1].list).toMatchObject({ search: true, selection: "multiple", paging: { pageSize: 25 } });

    fireEvent.click(screen.getByRole("button", { name: "列 2-2 を上へ" }));
    expect(view().sections[1].list.columns.map((c: { id: string }) => c.id)).toEqual(["amount", "name"]);
    fireEvent.click(screen.getByRole("button", { name: "列 2-1 を削除" }));
    expect(view().sections[1].list.columns.map((c: { id: string }) => c.id)).toEqual(["name"]);
    // 最後の 1 列は消せない (一覧には列が 1 つ以上要る)
    expect((screen.getByRole("button", { name: "列 2-1 を削除" }) as HTMLButtonElement).disabled).toBe(true);
    // 対応も一緒に外れる
    expect(screenOf().bindings).toBeUndefined();
  });

  it("操作: 主の操作と補助の操作を足し、文言・種類・遷移先・見た目を変え、並べ替え・削除できる", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "＋主の操作" }));
    expect(view().primaryAction).toEqual({ id: "action1", label: "送信する", kind: "submit", style: "primary" });
    commit("主の操作の文言", "登録する");
    pick("主の操作の遷移先", "d2");
    expect(view().primaryAction).toMatchObject({ label: "登録する", kind: "submit", to: "d2" });
    pick("主の操作の種類", "custom");
    expect(view().primaryAction.to).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "主の操作を削除" }));
    expect(view().primaryAction).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "＋補助の操作" }));
    fireEvent.click(screen.getByRole("button", { name: "＋補助の操作" }));
    expect(view().secondaryActions.map((a: { id: string }) => a.id)).toEqual(["action1", "action2"]);
    // 遷移にすると、行き先が自動で入る (遷移は行き先が要る)
    pick("補助の操作 1 の種類", "navigate");
    expect(view().secondaryActions[0]).toMatchObject({ kind: "navigate", to: "d_top" });
    // 遷移の行き先に「なし」は無い (送信のときだけ「なし」を選べる)
    expect(within(screen.getByRole("combobox", { name: "補助の操作 1 の遷移先" })).queryByRole("option", { name: "なし" })).toBeNull();
    pick("補助の操作 1 の遷移先", "d2");
    pick("補助の操作 1 の見た目", "danger");
    commit("補助の操作 1 の文言", "登録へ");
    expect(view().secondaryActions[0]).toMatchObject({ label: "登録へ", to: "d2", style: "danger" });
    fireEvent.click(screen.getByRole("button", { name: "補助の操作 1 を下へ" }));
    expect(view().secondaryActions.map((a: { id: string }) => a.id)).toEqual(["action2", "action1"]);
    fireEvent.click(screen.getByRole("button", { name: "補助の操作 1 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "補助の操作 1 を削除" }));
    expect(view().secondaryActions).toBeUndefined();
  });

  it("編集した結果は、検証 (列の対応が無い項目の警告) にも、プレビューにも反映される", () => {
    render(<ScreenBuilder />);
    expect(checkDesign(st().model, "sys_a").warnings.find((w) => w.type === "bindingUnmapped")!.message).toContain("2 件");
    pick("項目 1-1 の使うデータベース", "db_x");
    pick("項目 1-1 のテーブル", "Item");
    pick("項目 1-1 の列", "name");
    expect(checkDesign(st().model, "sys_a").warnings.find((w) => w.type === "bindingUnmapped")!.message).toContain("1 件");
  });

  it("画面 UI を消すボタンは確認のあとに画面 UI と対応を消す", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "画面 UI を消す" }));
    expect(screenOf().view).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screenOf().view).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "画面 UI を消す" }));
    fireEvent.click(screen.getByRole("button", { name: "消す" }));
    expect(screenOf().view).toBeUndefined();
  });
});

describe("ScreenBuilder: YAML で編集", () => {
  beforeEach(() => {
    setup(VIEW);
  });
  const yamlArea = () => screen.getByRole("textbox", { name: "画面 UI の YAML" }) as HTMLTextAreaElement;

  it("切り替えると view が YAML で出る。bindings は含まない", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    expect(yamlArea().value).toContain("goal: 探す");
    expect(yamlArea().value).toContain("kind: list");
    expect(yamlArea().value).not.toContain("bindings");
    expect(yamlArea().value).not.toContain("databaseId");
  });

  it("検証に通る YAML は blur で保存される (列の対応は残り、view に無い項目の対応は外れる)", () => {
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [{ item: "keyword", databaseId: "db_x", table: "Item", column: "name" }, { item: "res.name", databaseId: "db_x", table: "Item", column: "name" }] }));
    });
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    const before = pastLength();
    fireEvent.change(yamlArea(), { target: { value: yamlArea().value.replace("goal: 探す", "goal: 予約を探す").replace("item: keyword", "item: word") } });
    // 確定前は保存しない
    expect(view().goal).toBe("探す");
    fireEvent.blur(yamlArea());
    expect(view().goal).toBe("予約を探す");
    expect(view().sections[0].fields[0].item).toBe("word");
    expect(screenOf().bindings!.map((b) => b.item)).toEqual(["res.name"]);
    expect(pastLength()).toBe(before + 1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Cmd+Enter でも保存される", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    fireEvent.change(yamlArea(), { target: { value: yamlArea().value.replace("goal: 探す", "goal: 別の目的") } });
    fireEvent.keyDown(yamlArea(), { key: "Enter", metaKey: true });
    expect(view().goal).toBe("別の目的");
  });

  it("YAML として読めない・mokkun の検証に通らない文章は保存せず、理由を下に出して下書きを残す", () => {
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    const before = pastLength();
    fireEvent.change(yamlArea(), { target: { value: yamlArea().value.replace("kind: list", "kind: bogus") } });
    fireEvent.blur(yamlArea());
    expect(screen.getByRole("alert").textContent).toContain("mokkun の検証に通りません");
    expect(screen.getByRole("alert").textContent).toContain("sections[1].kind");
    expect(view().sections[1].kind).toBe("list");
    expect(pastLength()).toBe(before);
    expect(yamlArea().value).toContain("kind: bogus");

    fireEvent.change(yamlArea(), { target: { value: "title: [" } });
    fireEvent.blur(yamlArea());
    expect(screen.getByRole("alert").textContent).toContain("YAML を読めません");
    fireEvent.change(yamlArea(), { target: { value: "- a\n- b" } });
    fireEvent.blur(yamlArea());
    expect(screen.getByRole("alert").textContent).toContain("キーと値");
    expect(view().goal).toBe("探す");

    // 直せば保存できて、エラーも消える
    fireEvent.change(yamlArea(), { target: { value: "goal: 直した\nsections:\n  - id: a\n    title: A\n    kind: readonly\n    note: メモ\n" } });
    fireEvent.blur(yamlArea());
    expect(view().goal).toBe("直した");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("書きかけの下書きは、外からの更新 (同時編集) で壊されない。画面を離れるときは検証に通れば確定する", () => {
    const { unmount } = render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    fireEvent.change(yamlArea(), { target: { value: "書きかけ: [" } });
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: { ...VIEW, goal: "他の人の編集" } }));
    });
    expect(yamlArea().value).toBe("書きかけ: [");
    unmount();
    // 通らない下書きは捨てる (他の人の編集が残る)
    expect(view().goal).toBe("他の人の編集");

    const again = render(<ScreenBuilder />);
    fireEvent.click(again.getByRole("checkbox", { name: "YAML で編集" }));
    fireEvent.change(yamlArea(), { target: { value: yamlArea().value.replace("goal: 他の人の編集", "goal: 離れるとき確定") } });
    again.unmount();
    expect(view().goal).toBe("離れるとき確定");
  });

  it("YAML で項目の対応が外れたときは、外した件数をトーストで知らせる", () => {
    act(() => {
      st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: "d1", view: VIEW, bindings: [{ item: "keyword", databaseId: "db_x", table: "Item", column: "name" }] }));
    });
    render(<ScreenBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    fireEvent.change(yamlArea(), { target: { value: yamlArea().value.replace("item: keyword", "item: word") } });
    fireEvent.blur(yamlArea());
    expect(screenOf().bindings).toBeUndefined();
    expect(toasts().some((t) => t.includes("列の対応 1 件を外しました"))).toBe(true);
  });

  it("YAML のエイリアスで膨らむ入力は、検証の前に「大きすぎます」で断る。深すぎるものも断る", () => {
    // 10 個の要素を持つ配列を 10 段のエイリアスで入れ子にすると 10^5 個の節に膨らむ
    const lines = ["a0: &a0 [1,2,3,4,5,6,7,8,9,10]"];
    for (let i = 1; i < 6; i++) lines.push(`a${i}: &a${i} [${Array.from({ length: 10 }, () => `*a${i - 1}`).join(",")}]`);
    const big = parseViewYaml(lines.join("\n"), { title: "t", goal: "g" }, "d1", ["d1"]);
    expect(big).toMatchObject({ ok: false });
    expect((big as { message: string }).message).toContain("大きすぎます");
    const deep = parseViewYaml(`${"a:\n".concat(...Array.from({ length: 70 }, (_, i) => `${" ".repeat(i + 1)}a:\n`))}${" ".repeat(72)}x: 1\n`, { title: "t", goal: "g" }, "d1", ["d1"]);
    expect(deep).toMatchObject({ ok: false });
    expect((deep as { message: string }).message).toContain("深すぎます");
  });

  it("parseViewYaml: title / goal が無くても画面の名前と説明で補って検証する。他の画面への to は通る", () => {
    const ok = parseViewYaml("sections:\n  - id: a\n    title: A\n    kind: readonly\n    note: x\nsecondaryActions:\n  - id: go\n    label: 行く\n    kind: navigate\n    to: d2\n", { title: "t", goal: "g" }, "d1", ["d1", "d2"]);
    expect(ok.ok).toBe(true);
    const bad = parseViewYaml("sections: []\nsecondaryActions:\n  - id: go\n    label: 行く\n    kind: navigate\n    to: nope\n", { title: "t", goal: "g" }, "d1", ["d1", "d2"]);
    expect(bad.ok).toBe(false);
  });
});

describe("ScreenBuilder: AI で作る", () => {
  const GOOD = {
    view: {
      title: "なんでも",
      goal: "探す",
      sections: [
        { id: "cond", title: "条件", kind: "form", fields: [{ item: "keyword", label: "名前", component: "text" }] },
        { id: "res", title: "結果", kind: "list", list: { columns: [{ id: "name", label: "名前", to: "d2" }] } },
      ],
    },
    bindings: [
      { item: "keyword", databaseId: "db_x", table: "Item", column: "name" },
      { item: "res.name", databaseId: "db_x", table: "Item", column: "name" },
      { item: "res.name", databaseId: "db_x", table: "Ghost", column: "name" },
    ],
  };

  it("API キーが無いあいだは無効で、案内を出す", async () => {
    render(<ScreenBuilder />);
    await waitFor(() => expect(screen.getByText(/API キーを入れてください/)).toBeDefined());
    expect((screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("画面 UI も対応も無ければ、確認なしで作る。title は画面の名前、存在しない列の対応は捨てて数をトーストに出す", async () => {
    ai.key = "k";
    ai.submissions = [GOOD];
    render(<ScreenBuilder />);
    const button = screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(screenOf().view).toBeDefined());
    expect(view().title).toBe("予約検索");
    expect(view().sections).toHaveLength(2);
    expect(screenOf().bindings).toEqual([
      { item: "keyword", databaseId: "db_x", table: "Item", column: "name" },
      { item: "res.name", databaseId: "db_x", table: "Item", column: "name" },
    ]);
    expect(pastLength()).toBe(1);
    expect(toasts().some((t) => t.includes("AI が画面 UI を作りました") && t.includes("1 件は捨てました"))).toBe(true);
    expect(ai.sent[0]).toContain("画面「予約検索」");
  });

  it("画面 UI がすでにあれば、置き換えの確認を出す。キャンセルすれば何もしない", async () => {
    setup(VIEW);
    ai.key = "k";
    ai.submissions = [GOOD];
    render(<ScreenBuilder />);
    const button = screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(screen.getByText("画面 UI を置き換える")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(ai.sent).toHaveLength(0);
    expect(view().sections[0].id).toBe("cond");
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "置き換える" }));
    await waitFor(() => expect(view().sections[0].fields[0].label).toBe("名前"));
  });

  it("mokkun の検証に通らなければ 1 回だけ出し直し、まだ通らなければ失敗のトーストを出して何も変えない", async () => {
    ai.key = "k";
    const bad = { view: { title: "x", goal: "g", sections: [{ id: "a", title: "A", kind: "bogus" }] }, bindings: [] };
    ai.submissions = [bad, bad];
    render(<ScreenBuilder />);
    const button = screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(toasts().some((t) => t.includes("検証に通りませんでした"))).toBe(true));
    expect(ai.results.map((r) => r.ok)).toEqual([false, false]);
    expect(screenOf().view).toBeUndefined();
  });

  it("1 回目が通らなくても、出し直しが通れば置く", async () => {
    ai.key = "k";
    ai.submissions = [{ view: { title: "x", goal: "g", sections: [{ id: "a", title: "A", kind: "bogus" }] }, bindings: [] }, GOOD];
    render(<ScreenBuilder />);
    const button = screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(screenOf().view).toBeDefined());
    expect(ai.results.map((r) => r.ok)).toEqual([false, true]);
  });
});

describe("閲覧専用", () => {
  it("画面 UI を読めるだけで、編集のボタンも入力も使えない。AI も使えない", async () => {
    setup(VIEW);
    ai.key = "k";
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<ScreenBuilder />);
    expect(screen.getByText("閲覧専用です。編集はできません。")).toBeDefined();
    expect((screen.getByRole("textbox", { name: "画面の目的 (goal)" }) as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByRole("combobox", { name: "セクション 1 の種類" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "項目 1-1 の使うデータベース" }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "＋セクション" })).toBeNull();
    expect(screen.queryByRole("button", { name: "セクション 1 を削除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "画面 UI を消す" })).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "AI で作る" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "YAML で編集" }));
    expect((screen.getByRole("textbox", { name: "画面 UI の YAML" }) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("画面 UI が無い画面でも、作るボタンを出さない", () => {
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<ScreenBuilder />);
    expect(screen.queryByRole("button", { name: "画面 UI を作る" })).toBeNull();
  });
});

describe("検証パネルからの移動", () => {
  it("列の対応に関わる問題の行を押すと、画面ボードでその画面を選ぶ", () => {
    setup(VIEW, "");
    const warning = checkDesign(st().model, "sys_a").warnings.find((w) => w.type === "bindingUnmapped")!;
    act(() => revealDesignProblem(warning));
    expect(st().ui.currentBoardId).toBe("design:screen");
    expect(st().ui.designScreenId).toBe("d1");
  });
});
