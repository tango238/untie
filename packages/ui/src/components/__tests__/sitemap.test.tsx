import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDesignScreenShell, setDesignScreenView } from "@untie/core/model/commands";
import { addSitemapScreens } from "@untie/core/model/sitemap";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { SitemapProperties } from "../design/SitemapProperties";
import { SitemapTree } from "../design/SitemapTree";

// 画面そのものは SitemapCanvas の別のテストで確かめる (React Flow は ResizeObserver を使う)
vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const st = () => useUntieStore.getState();

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "sys_b", kind: "system", name: "会計システム" },
  { id: "actor_1", kind: "actor", name: "受付" },
  { id: "biz_1", kind: "business", name: "予約の受付" },
  { id: "buc_1", kind: "buc", name: "予約の受付", businessId: "biz_1", isDefault: true },
  { id: "biz_2", kind: "business", name: "窓口" },
  { id: "buc_2", kind: "buc", name: "窓口", businessId: "biz_2", isDefault: true },
  { id: "buc_x", kind: "buc", name: "電話", businessId: "biz_2", isDefault: false },
  { id: "biz_3", kind: "business", name: "請求" },
  { id: "buc_3", kind: "buc", name: "請求", businessId: "biz_3", isDefault: true },
  { id: "act_1", kind: "activity", name: "予約を受ける", bucId: "buc_1" },
  { id: "act_2", kind: "activity", name: "予約を確認する", bucId: "buc_1" },
  { id: "act_3", kind: "activity", name: "電話を受ける", bucId: "buc_x" },
  { id: "act_4", kind: "activity", name: "請求書を出す", bucId: "buc_3" },
  { id: "uc_1", kind: "usecase", name: "予約を探す" },
  { id: "uc_2", kind: "usecase", name: "予約を登録する" },
  { id: "uc_3", kind: "usecase", name: "予約の内容を見る" },
  { id: "uc_4", kind: "usecase", name: "電話の内容を残す" },
  { id: "uc_5", kind: "usecase", name: "請求を作る" },
  { id: "scr_1", kind: "screen", name: "予約検索", description: "予約を探す画面", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "予約登録", systemId: "sys_a" },
  { id: "scr_3", kind: "screen", name: "予約詳細", systemId: "sys_a" },
  { id: "scr_4", kind: "screen", name: "電話メモ", systemId: "sys_a" },
  { id: "scr_5", kind: "screen", name: "請求書", systemId: "sys_b" },
  { id: "info_1", kind: "information", name: "予約", contextId: null },
] as Element[];

const PAIRS: [string, string, Relation["kind"]][] = [
  ["actor_1", "act_1", "actorActivity"],
  ["actor_1", "act_2", "actorActivity"],
  ["actor_1", "act_3", "actorActivity"],
  ["actor_1", "act_4", "actorActivity"],
  ["act_1", "uc_1", "activityUsecase"],
  ["act_1", "uc_2", "activityUsecase"],
  ["act_2", "uc_3", "activityUsecase"],
  ["act_3", "uc_4", "activityUsecase"],
  ["act_4", "uc_5", "activityUsecase"],
  ["uc_1", "scr_1", "usecaseScreen"],
  ["uc_2", "scr_2", "usecaseScreen"],
  ["uc_3", "scr_3", "usecaseScreen"],
  ["uc_4", "scr_4", "usecaseScreen"],
  ["uc_5", "scr_5", "usecaseScreen"],
  ["uc_1", "uc_2", "usecaseNext"],
  ["scr_1", "info_1", "screenInformation"],
];

function model(): UntieModel {
  const m = emptyModel();
  m.elements = ELEMENTS.map((e) => ({ ...e }));
  m.relations = PAIRS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  m.boards = [{ id: "board_1", name: "全体", nodes: [] }];
  return m;
}

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null });
  resetStore(model());
  act(() => st().enterDesign("sys_a"));
});

const design = () => st().model.designs.find((d) => d.systemId === "sys_a");
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const nameOfScreen = (id: string) => {
  const s = design()!.screens.find((x) => x.id === id)!;
  if (s.source.kind === "builtin") return s.source.builtin === "top" ? "トップページ" : "サインイン";
  return st().model.elements.find((e) => e.id === (s.source as { screenId: string }).screenId)!.name;
};
const edges = () => design()?.transitions.map((t) => `${nameOfScreen(t.from)}>${nameOfScreen(t.to)}`) ?? [];

describe("SitemapTree: 木とチェックの状態", () => {
  it("組み込みの画面はサインインとトップページだけ。操作の行には対象の画面名を添える", () => {
    render(<SitemapTree />);
    const builtins = within(screen.getByRole("region", { name: "組み込みの画面" }));
    expect(builtins.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["サインイン", "トップページ"]);
    expect(within(document.querySelector('[data-tree-node="uc_1"]') as HTMLElement).getByText("予約検索")).toBeDefined();
    // 窓口 → 電話 (既定でない活動) → 電話を受ける
    expect(document.querySelector('[data-tree-node="biz_2"] [data-tree-node="buc_x"] [data-tree-node="act_3"]')).not.toBeNull();
  });

  it("対象の画面に届かない節は薄く表示し、チェックできない", () => {
    render(<SitemapTree />);
    for (const id of ["biz_3", "act_4", "uc_5"]) {
      expect(document.querySelector(`[data-tree-node="${id}"]`)?.className).toContain("is-dim");
    }
    expect(box("請求").disabled).toBe(true);
    expect(box("請求書を出す").disabled).toBe(true);
    expect(box("請求を作る").disabled).toBe(true);
    expect(box("予約を探す").disabled).toBe(false);
  });

  it("チェックの状態は設計の画面から導く: 全部あれば checked、一部なら indeterminate、無ければ unchecked", () => {
    act(() => {
      st().dispatch((m) => addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_1" }]));
    });
    render(<SitemapTree />);
    expect(box("予約を探す").checked).toBe(true);
    expect(box("予約を登録する").checked).toBe(false);
    expect(box("予約を受ける").checked).toBe(false);
    expect(box("予約を受ける").indeterminate).toBe(true);
    // 業務は、作業 2 つのうち 1 つが一部 → 一部
    expect(box("予約の受付").indeterminate).toBe(true);
    expect(box("予約を確認する").indeterminate).toBe(false);
    expect(box("予約を確認する").checked).toBe(false);
  });
});

describe("SitemapTree: チェックで画面と遷移を足す・外す", () => {
  it("作業にチェックを入れると、届く画面と導いた遷移が 1 回の変更で足される", () => {
    render(<SitemapTree />);
    const before = st().history.past.length;
    fireEvent.click(box("予約を受ける"));
    expect(design()!.screens.map((s) => nameOfScreen(s.id))).toEqual(["予約検索", "予約登録"]);
    expect(edges()).toEqual(["予約検索>予約登録"]);
    expect(st().history.past.length).toBe(before + 1);
    expect(box("予約を受ける").checked).toBe(true);
    expect(box("予約を探す").checked).toBe(true);
    expect(box("予約の受付").indeterminate).toBe(true);
    // ほかの作業のチェックを入れると業務も全部になる
    fireEvent.click(box("予約を確認する"));
    expect(box("予約の受付").checked).toBe(true);
    expect(design()!.screens).toHaveLength(3);
  });

  it("一部だけの節をクリックすると残りが足される。業務の行は部分木ぜんぶ", () => {
    render(<SitemapTree />);
    fireEvent.click(box("予約を探す"));
    expect(design()!.screens).toHaveLength(1);
    fireEvent.click(box("予約を受ける"));
    expect(design()!.screens).toHaveLength(2);
    fireEvent.click(box("窓口"));
    expect(design()!.screens.map((s) => nameOfScreen(s.id))).toEqual(["予約検索", "予約登録", "電話メモ"]);
  });

  it("チェックを外すと、部分木の届く画面をすべて消し、それを指す遷移も消える (確認なし)", () => {
    render(<SitemapTree />);
    fireEvent.click(box("予約を受ける"));
    fireEvent.click(box("予約を探す"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(design()!.screens.map((s) => nameOfScreen(s.id))).toEqual(["予約登録"]);
    expect(design()!.transitions).toEqual([]);
    expect(box("予約を探す").checked).toBe(false);
  });

  it("画面 UI (view) か bindings を持つ画面が消えるときは確認を出し、画面名を並べる。キャンセルなら消えない", () => {
    render(<SitemapTree />);
    fireEvent.click(box("予約を受ける"));
    // 画面設計に進んでいる状態にする
    act(() => {
      useUntieStore.setState((s) => ({
        model: { ...s.model, designs: s.model.designs.map((d) => ({ ...d, screens: d.screens.map((x, i) => (i === 0 ? { ...x, view: { type: "page" } } : x)) })) },
      }));
    });
    fireEvent.click(box("予約を受ける"));
    const dialog = screen.getByRole("dialog", { name: "画面をサイトマップから外す" });
    expect(within(dialog).getByText("次の画面の設計も一緒に消えます。")).toBeDefined();
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["予約検索"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(design()!.screens).toHaveLength(2);
    fireEvent.click(box("予約を受ける"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "外す" }));
    expect(design()!.screens).toHaveLength(0);
  });

  it("組み込みの画面: サインイン・トップページを足すと遷移も付く。外すときの確認の規則は同じ", () => {
    render(<SitemapTree />);
    fireEvent.click(box("予約を受ける"));
    fireEvent.click(box("トップページ"));
    fireEvent.click(box("サインイン"));
    expect(edges()).toEqual(["予約検索>予約登録", "トップページ>予約検索", "サインイン>トップページ"]);
    expect(design()!.transitions.map((t) => t.via)).toEqual([undefined, "nav", "afterSubmit"]);
    expect(box("トップページ").checked).toBe(true);
    act(() => {
      useUntieStore.setState((s) => ({
        model: { ...s.model, designs: s.model.designs.map((d) => ({ ...d, screens: d.screens.map((x) => (x.source.kind === "builtin" && x.source.builtin === "top" ? { ...x, view: { type: "page" } } : x)) })) },
      }));
    });
    fireEvent.click(box("トップページ"));
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["トップページ"]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "外す" }));
    expect(design()!.screens.map((s) => nameOfScreen(s.id))).toEqual(["予約検索", "予約登録", "サインイン"]);
    // トップページが無くなったので、サインインから入口の画面へ付け直される
    expect(edges()).toEqual(["予約検索>予約登録", "サインイン>予約検索"]);
  });

  it("操作の行の画面名は、サイトマップにあれば押してその画面を選べる。チェックボックスには画面名と作業が説明として付く", () => {
    render(<SitemapTree />);
    const uc = document.querySelector('[data-tree-node="uc_1"]') as HTMLElement;
    expect(within(uc).queryByRole("button", { name: "予約検索" })).toBeNull();
    fireEvent.click(box("予約を探す"));
    fireEvent.click(within(uc).getByRole("button", { name: "予約検索" }));
    expect(st().ui.designScreenId).toBe(design()!.screens[0]!.id);
    const described = document.getElementById(box("予約を探す").getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe("画面: 予約検索。作業: 予約を受ける");
  });

  it("閲覧専用ではチェックできない", () => {
    st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    act(() => st().enterDesign("sys_a"));
    render(<SitemapTree />);
    expect(box("予約を探す").disabled).toBe(true);
    expect(box("サインイン").disabled).toBe(true);
  });
});

describe("SitemapProperties", () => {
  const setup = () => {
    act(() => {
      const r = st().dispatch((m) => addSitemapScreens(m, "sys_a", [{ kind: "builtin", builtin: "top" }, { kind: "screen", screenId: "scr_1" }, { kind: "screen", screenId: "scr_2" }, { kind: "screen", screenId: "scr_3" }]));
      if (!r.ok) throw new Error(r.reason);
    });
    const idOf = (name: string) => design()!.screens.find((s) => nameOfScreen(s.id) === name)!.id;
    return idOf;
  };

  it("何も選んでいないときは案内を出す", () => {
    render(<SitemapProperties />);
    expect(screen.getByText("サイトマップの画面を選ぶと、ここに内容が出ます")).toBeDefined();
  });

  it("選んだ画面の名前・説明・使う操作 (作業名つき)・使う情報・入口の注記を出す", () => {
    const idOf = setup();
    act(() => st().selectDesignScreen(idOf("予約検索")));
    render(<SitemapProperties />);
    const panel = within(screen.getByTestId("sitemap-properties"));
    expect(panel.getByText("予約検索")).toBeDefined();
    expect(panel.getByText("予約を探す画面")).toBeDefined();
    expect(panel.getByText("予約を探す")).toBeDefined();
    expect(panel.getByText("(予約を受ける)")).toBeDefined();
    expect(panel.getByText("予約")).toBeDefined();
    expect(panel.getByTestId("sitemap-entry-notes")).toBeDefined();
  });

  it("「分析の画面ボードで見る」で分析モードの画面ボードへ移り、その画面を選ぶ", () => {
    const idOf = setup();
    act(() => st().selectDesignScreen(idOf("予約検索")));
    render(<SitemapProperties />);
    fireEvent.click(screen.getByRole("button", { name: "分析の画面ボードで見る" }));
    expect(st().ui.mode).toBe("analysis");
    expect(st().ui.currentBoardId).toBe("fixed:screen");
    expect(st().ui.selection).toEqual({ type: "element", id: "scr_1" });
  });

  it("出ていく遷移のきっかけ・文言を変え、削除し、追加できる", () => {
    const idOf = setup();
    act(() => st().selectDesignScreen(idOf("予約検索")));
    render(<SitemapProperties />);
    const via = screen.getByRole("combobox", { name: "予約登録 へのきっかけ" }) as HTMLSelectElement;
    expect(via.value).toBe("");
    expect(Array.from(via.options).map((o) => o.textContent)).toEqual(["未定", "ボタン", "一覧の行", "メニュー", "送信のあと"]);
    fireEvent.change(via, { target: { value: "row" } });
    expect(design()!.transitions.find((t) => nameOfScreen(t.to) === "予約登録")!.via).toBe("row");
    fireEvent.change(via, { target: { value: "" } });
    expect(design()!.transitions.find((t) => nameOfScreen(t.to) === "予約登録")!.via).toBeUndefined();

    const label = screen.getByRole("textbox", { name: "予約登録 への文言" });
    fireEvent.change(label, { target: { value: "登録へ進む" } });
    fireEvent.blur(label);
    expect(design()!.transitions.find((t) => nameOfScreen(t.to) === "予約登録")!.label).toBe("登録へ進む");

    // 追加: すでに遷移がある画面と自分は出ない
    const add = screen.getByRole("combobox", { name: "遷移を追加" }) as HTMLSelectElement;
    expect(Array.from(add.options).map((o) => o.textContent)).toEqual(["遷移を追加…", "トップページ", "予約詳細"]);
    fireEvent.change(add, { target: { value: idOf("予約詳細") } });
    expect(edges()).toContain("予約検索>予約詳細");

    fireEvent.click(screen.getByRole("button", { name: "予約登録 への遷移を削除" }));
    expect(edges()).not.toContain("予約検索>予約登録");
  });

  it("入ってくる遷移は読み取りで、画面名を押すとその画面を選ぶ", () => {
    const idOf = setup();
    act(() => st().selectDesignScreen(idOf("予約登録")));
    render(<SitemapProperties />);
    fireEvent.click(screen.getByRole("button", { name: "予約検索" }));
    expect(st().ui.designScreenId).toBe(idOf("予約検索"));
  });

  it("エッジから選んだ遷移を強調する", () => {
    const idOf = setup();
    const tr = design()!.transitions.find((t) => t.from === idOf("予約検索"))!;
    act(() => st().selectDesignScreen(idOf("予約検索"), tr.id));
    render(<SitemapProperties />);
    expect(document.querySelector(`[data-transition="${tr.id}"]`)?.className).toContain("is-highlight");
  });

  it("「画面ボードで開く」は design:screen へ移り、選択は変えない", () => {
    const idOf = setup();
    act(() => st().selectDesignScreen(idOf("予約検索")));
    render(<SitemapProperties />);
    fireEvent.click(screen.getByRole("button", { name: "画面ボードで開く" }));
    expect(st().ui.currentBoardId).toBe("design:screen");
    expect(st().ui.designScreenId).toBe(idOf("予約検索"));
  });

  it("「サイトマップから外す」は木のチェックを外すのと同じ (view があれば確認)", () => {
    const idOf = setup();
    const id = idOf("予約詳細");
    act(() => st().selectDesignScreen(id));
    render(<SitemapProperties />);
    fireEvent.click(screen.getByRole("button", { name: "サイトマップから外す" }));
    expect(design()!.screens.some((s) => s.id === id)).toBe(false);
    expect(st().ui.designScreenId).toBeUndefined();

    const id2 = idOf("予約登録");
    act(() => {
      useUntieStore.setState((s) => ({
        model: { ...s.model, designs: s.model.designs.map((d) => ({ ...d, screens: d.screens.map((x) => (x.id === id2 ? { ...x, bindings: [{ item: "名前", databaseId: "db_default", table: "R", column: "c" }] } : x)) })) },
      }));
      st().selectDesignScreen(id2);
    });
    fireEvent.click(screen.getByRole("button", { name: "サイトマップから外す" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["予約登録"]);
    expect(design()!.screens.some((s) => s.id === id2)).toBe(true);
  });

  it("画面 UI の有無を出し、無い画面には作れる案内を出す", () => {
    const idOf = setup();
    const withUi = idOf("予約検索");
    act(() => {
      const r = st().dispatch((m) => setDesignScreenView(m, { systemId: "sys_a", id: withUi, view: { title: "t", goal: "g", sections: [] } }));
      if (!r.ok) throw new Error(r.reason);
      st().selectDesignScreen(withUi);
    });
    const { unmount } = render(<SitemapProperties />);
    let ui = screen.getByText("画面 UI").parentElement!;
    expect(within(ui).getByText("あり")).toBeDefined();
    expect(within(ui).queryByText("画面ボードで作れます")).toBeNull();
    unmount();
    act(() => st().selectDesignScreen(idOf("予約登録")));
    render(<SitemapProperties />);
    ui = screen.getByText("画面 UI").parentElement!;
    expect(within(ui).getByText("なし")).toBeDefined();
    expect(within(ui).getByText("画面ボードで作れます")).toBeDefined();
  });

  it("レイアウトを読み取りで 1 行出す: 設計に従う (shell)、上書きがあればその値", () => {
    const idOf = setup();
    const id = idOf("予約検索");
    act(() => st().selectDesignScreen(id));
    const { unmount } = render(<SitemapProperties />);
    expect(within(screen.getByText("レイアウト").parentElement!).getByText("設計に従う (ヘッダー + グローバルナビ + パンくず)")).toBeDefined();
    unmount();
    act(() => {
      const r = st().dispatch((m) => setDesignScreenShell(m, { systemId: "sys_a", screenId: id, shell: "plain" }));
      if (!r.ok) throw new Error(r.reason);
    });
    render(<SitemapProperties />);
    expect(within(screen.getByText("レイアウト").parentElement!).getByText("ヘッダーのみ (上書き)")).toBeDefined();
  });

  it("閲覧専用では画面 UI が無くても作れる案内を出さない", () => {
    const idOf = setup();
    st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    act(() => {
      st().enterDesign("sys_a");
      st().selectDesignScreen(idOf("予約検索"));
    });
    render(<SitemapProperties />);
    const ui = screen.getByText("画面 UI").parentElement!;
    expect(within(ui).getByText("なし")).toBeDefined();
    expect(within(ui).queryByText("画面ボードで作れます")).toBeNull();
  });

  it("閲覧専用では編集できない", () => {
    const idOf = setup();
    st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    act(() => {
      st().enterDesign("sys_a");
      st().selectDesignScreen(idOf("予約検索"));
    });
    render(<SitemapProperties />);
    expect((screen.getByRole("combobox", { name: "予約登録 へのきっかけ" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "サイトマップから外す" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "予約登録 への遷移を削除" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("combobox", { name: "遷移を追加" })).toBeNull();
  });
});
