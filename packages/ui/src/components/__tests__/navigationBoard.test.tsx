import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDesignScreens, addTransition, setDesignLayout, setDesignNavigation, setDesignScreenShell } from "@untie/core/model/commands";
import { checkDesign } from "@untie/core/model/designCheck";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { okModel } from "@untie/core/testing";
import type { ChatOptions } from "../../ai/chat";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { NavigationBoard } from "../design/NavigationBoard";
import { NavigationLeftPane } from "../design/NavigationLeftPane";
import { NavigationProperties } from "../design/NavigationProperties";
import { cachedCheckDesign } from "../design/checkCache";

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
          const r = await o.runTool("submit_navigation", ai.submissions.shift());
          ai.results.push(r);
          if (r.ok) break;
        }
        return ai.text;
      },
    }),
  };
});

const st = () => useUntieStore.getState();

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
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
  { id: "scr_1", kind: "screen", name: "予約検索", description: "予約を探す", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "予約登録", systemId: "sys_a" },
  { id: "scr_3", kind: "screen", name: "請求一覧", systemId: "sys_a" },
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
  m.boards = [{ id: "board_1", name: "全体", nodes: [] }];
  return m;
}

/** 設計あり: サインイン・トップ・予約検索 (d1)・予約登録 (d2)・請求一覧 (d3)。d1 → d2 の遷移 */
function withDesign(): UntieModel {
  const m = okModel(
    addDesignScreens(base(), {
      systemId: "sys_a",
      screens: [
        { id: "d_in", source: { kind: "builtin", builtin: "signIn" } },
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d2", source: { kind: "screen", screenId: "scr_2" } },
        { id: "d3", source: { kind: "screen", screenId: "scr_3" } },
      ],
      transitions: [],
    }),
  );
  return okModel(addTransition(m, { systemId: "sys_a", from: "d1", to: "d2", via: "button", label: "登録へ" }));
}

const layout = () => st().model.designs.find((d) => d.systemId === "sys_a")!.layout;
const toasts = () => st().toasts.map((t) => t.message);

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null });
  ai.key = null;
  ai.sent = [];
  ai.submissions = [];
  ai.results = [];
  ai.text = "";
  resetStore(withDesign());
  act(() => st().enterDesign("sys_a"));
});
afterEach(cleanup);

describe("NavigationBoard: プレビュー", () => {
  it("画面の select に設計の画面が並び、既定はトップページ。iframe の srcdoc にその画面を描く", () => {
    render(<NavigationBoard />);
    const select = screen.getByRole("combobox", { name: "プレビューする画面" }) as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["サインイン", "トップページ", "予約検索", "予約登録", "請求一覧"]);
    expect(select.value).toBe("d_top");
    const src = (screen.getByTitle("画面のプレビュー") as HTMLIFrameElement).getAttribute("srcdoc")!;
    expect(src).toContain('data-view="d_top"');
    expect(src).toContain("予約システム");
  });

  it("選んでいる画面 (ui.designScreenId) があればその画面。select を変えると選択も変わり、プレビューも変わる", () => {
    act(() => st().selectDesignScreen("d2"));
    render(<NavigationBoard />);
    const select = screen.getByRole("combobox", { name: "プレビューする画面" }) as HTMLSelectElement;
    expect(select.value).toBe("d2");
    fireEvent.change(select, { target: { value: "d1" } });
    expect(st().ui.designScreenId).toBe("d1");
    expect((screen.getByTitle("画面のプレビュー") as HTMLIFrameElement).getAttribute("srcdoc")).toContain('data-view="d1"');
  });

  it("プレビュー中の画面がレイアウトを上書きしているときだけ、ツールバーに案内を出す", () => {
    act(() => st().selectDesignScreen("d1"));
    const { unmount } = render(<NavigationBoard />);
    expect(screen.queryByText(/レイアウトを上書きしています/)).toBeNull();
    unmount();
    act(() => {
      const r = st().dispatch((m) => setDesignScreenShell(m, { systemId: "sys_a", screenId: "d1", shell: "plain" }));
      if (!r.ok) throw new Error(r.reason);
    });
    render(<NavigationBoard />);
    expect(screen.getByText("この画面はレイアウトを上書きしています (ヘッダーのみ)。画面ボードで変えられます")).toBeDefined();
  });

  it("トップページが無ければ最初の画面", () => {
    const m = okModel(addDesignScreens(base(), { systemId: "sys_a", screens: [{ id: "d9", source: { kind: "screen", screenId: "scr_2" } }], transitions: [] }));
    act(() => resetStore(m));
    act(() => st().enterDesign("sys_a"));
    render(<NavigationBoard />);
    expect((screen.getByRole("combobox", { name: "プレビューする画面" }) as HTMLSelectElement).value).toBe("d9");
  });

  it("画面が 1 つも無いときは案内を出す", () => {
    act(() => resetStore(base()));
    act(() => st().enterDesign("sys_a"));
    render(<NavigationBoard />);
    expect(screen.getByText("サイトマップで画面を足すとプレビューできます")).toBeDefined();
    expect(screen.queryByTitle("画面のプレビュー")).toBeNull();
  });

  it("画面 UI が mokkun の検証に通らない画面は、仮の画面にして理由を出す", () => {
    const m = withDesign();
    act(() =>
      resetStore({
        ...m,
        designs: m.designs.map((d) => ({ ...d, screens: d.screens.map((s) => (s.id === "d1" ? { ...s, view: { sections: [{ id: "s", title: "x", kind: "bogus" }] } } : s)) })),
      }),
    );
    act(() => st().enterDesign("sys_a"));
    render(<NavigationBoard />);
    // 壊れた画面だけ仮の画面になり、理由はその画面にだけ出る。ほかの画面は理由なし
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "プレビューする画面" }), { target: { value: "d1" } });
    expect(screen.getByRole("alert").textContent).toContain("views.d1.sections[0].kind");
    expect(screen.getByTitle("画面のプレビュー")).toBeDefined();
  });
});

describe("NavigationLeftPane", () => {
  it("レイアウトのラジオを選ぶと shell / plain が変わる (履歴は 1 件)", () => {
    render(<NavigationLeftPane />);
    expect((screen.getByRole("radio", { name: /shell/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("ヘッダー + グローバルナビ + パンくず")).toBeDefined();
    expect(screen.getByText("ヘッダーのみ")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: /plain/ }));
    expect(layout().shell).toBe("plain");
    expect(st().history.past).toHaveLength(1);
  });

  it("ヘッダーの項目を入れ、空にすると消える。システム名の placeholder は対象システムの名前", () => {
    render(<NavigationLeftPane />);
    const systemName = screen.getByRole("textbox", { name: "システム名" }) as HTMLInputElement;
    expect(systemName.placeholder).toBe("予約システム");
    fireEvent.change(systemName, { target: { value: "予約の画面" } });
    fireEvent.blur(systemName);
    const user = screen.getByRole("textbox", { name: "利用者名" });
    fireEvent.change(user, { target: { value: "田中" } });
    fireEvent.blur(user);
    const tenant = screen.getByRole("textbox", { name: "テナント名" });
    fireEvent.change(tenant, { target: { value: "本店" } });
    fireEvent.blur(tenant);
    expect(layout().header).toEqual({ systemName: "予約の画面", userName: "田中", tenantName: "本店" });
    fireEvent.change(systemName, { target: { value: "" } });
    fireEvent.blur(systemName);
    expect(layout().header).toEqual({ userName: "田中", tenantName: "本店" });
  });

  it("閲覧専用では編集できない", () => {
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<NavigationLeftPane />);
    expect((screen.getByRole("radio", { name: /plain/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "利用者名" }) as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("NavigationProperties: ナビゲーションメニュー", () => {
  const groupNames = () => layout().navigation.map((g) => g.group);

  it("＋グループ・＋項目で足し、名前・画面・表示名を編集し、並べ替え・削除ができる", () => {
    render(<NavigationProperties />);
    fireEvent.click(screen.getByRole("button", { name: "＋グループ" }));
    fireEvent.click(screen.getByRole("button", { name: "＋グループ" }));
    expect(layout().navigation.map((g) => g.group)).toEqual(["新しいグループ", "新しいグループ"]);
    expect(layout().navigation.every((g) => g.id.startsWith("nav_"))).toBe(true);
    const name = screen.getByRole("textbox", { name: "グループ名 1" });
    fireEvent.change(name, { target: { value: "予約" } });
    fireEvent.blur(name);
    expect(groupNames()).toEqual(["予約", "新しいグループ"]);

    fireEvent.click(screen.getAllByRole("button", { name: /に項目を足す/ })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: /に項目を足す/ })[0]!);
    // 2 つめは、まだ入っていない画面から選ぶ
    expect(layout().navigation[0]!.items.map((i) => i.screenId)).toEqual(["d_in", "d_top"]);
    const pick = screen.getByRole("combobox", { name: "グループ「予約」の項目 2 の画面" });
    fireEvent.change(pick, { target: { value: "d1" } });
    expect(layout().navigation[0]!.items[1]!.screenId).toBe("d1");
    const label = screen.getByRole("textbox", { name: "項目 2 の表示名" }) as HTMLInputElement;
    expect(label.placeholder).toBe("予約検索");
    fireEvent.change(label, { target: { value: "探す" } });
    fireEvent.blur(label);
    expect(layout().navigation[0]!.items[1]).toEqual({ screenId: "d1", label: "探す" });
    fireEvent.change(label, { target: { value: "" } });
    fireEvent.blur(label);
    expect(layout().navigation[0]!.items[1]).toEqual({ screenId: "d1" });

    // 項目の並べ替え・削除
    fireEvent.click(screen.getByRole("button", { name: "項目「予約検索」を上へ" }));
    expect(layout().navigation[0]!.items.map((i) => i.screenId)).toEqual(["d1", "d_in"]);
    fireEvent.click(screen.getByRole("button", { name: "項目「サインイン」を削除" }));
    expect(layout().navigation[0]!.items.map((i) => i.screenId)).toEqual(["d1"]);
    // グループの並べ替え・削除
    fireEvent.click(screen.getByRole("button", { name: "グループ「予約」を下へ" }));
    expect(groupNames()).toEqual(["新しいグループ", "予約"]);
    fireEvent.click(screen.getByRole("button", { name: "グループ「新しいグループ」を削除" }));
    expect(groupNames()).toEqual(["予約"]);
    // 端では動かせない
    expect((screen.getByRole("button", { name: "グループ「予約」を上へ" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "グループ「予約」を下へ" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("閲覧専用では編集のボタンが出ず、作り方のボタンは無効", () => {
    act(() => {
      st().dispatch((m) => setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: "d1" }] }] }));
    });
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<NavigationProperties />);
    expect(screen.queryByRole("button", { name: "＋グループ" })).toBeNull();
    expect(screen.queryByRole("button", { name: /を削除/ })).toBeNull();
    expect((screen.getByRole("button", { name: "サイトマップから作る" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "グループ名 1" }) as HTMLInputElement).readOnly).toBe(true);
  });

  it("「サイトマップから作る」: ナビが無ければそのまま作る (業務ごと。ホームの先頭はトップ、サインインは入れない)", () => {
    render(<NavigationProperties />);
    fireEvent.click(screen.getByRole("button", { name: "サイトマップから作る" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(layout().navigation.map((g) => [g.group, g.items.map((i) => i.screenId)])).toEqual([
      ["ホーム", ["d_top"]],
      ["予約", ["d1", "d2"]],
      ["請求", ["d3"]],
    ]);
    expect(toasts().some((t) => t.includes("3 個のグループ"))).toBe(true);
    // 辿れない画面の警告は出なくなる
    expect(checkDesign(st().model, "sys_a").warnings.some((w) => w.type === "screenUnreachable")).toBe(false);
  });

  it("既にナビがあれば置き換えの確認を出す。キャンセルすると変わらず、置き換えると作り直す", () => {
    act(() => {
      st().dispatch((m) => setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "手で作った", items: [{ screenId: "d1" }] }] }));
    });
    render(<NavigationProperties />);
    fireEvent.click(screen.getByRole("button", { name: "サイトマップから作る" }));
    const dialog = screen.getByRole("dialog", { name: "ナビゲーションを置き換える" });
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(groupNames()).toEqual(["手で作った"]);
    fireEvent.click(screen.getByRole("button", { name: "サイトマップから作る" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "置き換える" }));
    expect(groupNames()).toEqual(["ホーム", "予約", "請求"]);
  });
});

describe("NavigationProperties: AI で考える", () => {
  const button = () => screen.getByRole("button", { name: /AI で考える|考えています/ }) as HTMLButtonElement;

  it("キーが無いと無効にし、「AI の設定」の案内を出す", async () => {
    render(<NavigationProperties />);
    await waitFor(() => expect(screen.getByText(/API キーを入れてください/)).toBeDefined());
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "AI の設定" }));
  });

  it("閲覧専用では、キーがあっても無効", async () => {
    ai.key = "k";
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<NavigationProperties />);
    await new Promise((r) => setTimeout(r, 20));
    expect(button().disabled).toBe(true);
  });

  it("依頼に画面の材料 (入口・使う操作と業務・遷移) を渡し、提出されたグループ分けを置く。存在しない画面は捨て、サインインは入れない", async () => {
    ai.key = "k";
    render(<NavigationProperties />);
    await waitFor(() => expect(button().disabled).toBe(false));
    ai.submissions.push({
      groups: [
        { group: "ホーム", items: [{ screenId: "d_top", label: "ホーム" }, { screenId: "d_in", label: "ログイン" }] },
        { group: "予約", items: [{ screenId: "d1", label: "探す" }, { screenId: "d_nope", label: "?" }, { screenId: "d2", label: "登録" }] },
        { group: "からっぽ", items: [{ screenId: "d_nope2", label: "?" }] },
      ],
    });
    fireEvent.click(button());
    await waitFor(() => expect(layout().navigation).toHaveLength(2));
    expect(layout().navigation.map((g) => [g.group, g.items])).toEqual([
      ["ホーム", [{ screenId: "d_top", label: "ホーム" }]],
      ["予約", [{ screenId: "d1", label: "探す" }, { screenId: "d2", label: "登録" }]],
    ]);
    expect(layout().navigation.every((g) => g.id.startsWith("nav_"))).toBe(true);
    const request = ai.sent[0]!;
    expect(request).toContain("予約を探す");
    expect(request).toContain("検索する");
    expect(request).toContain('"entry": true');
    expect(request).toContain("登録へ");
    expect(request).not.toContain('"サインイン"');
    expect(st().history.past).toHaveLength(1);
    expect(toasts().some((t) => t.includes("捨てました"))).toBe(true);
    // 捨てたものがあっても、エラーではなくお知らせ
    expect(st().toasts.find((t) => t.message.includes("捨てました"))!.tone).toBe("info");
  });

  it("既にナビがあれば置き換えの確認を出す。キャンセルすると AI を呼ばない", async () => {
    ai.key = "k";
    act(() => {
      st().dispatch((m) => setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "手で作った", items: [{ screenId: "d1" }] }] }));
    });
    render(<NavigationProperties />);
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    fireEvent.click(within(screen.getByRole("dialog", { name: "ナビゲーションを置き換える" })).getByRole("button", { name: "キャンセル" }));
    expect(ai.sent).toHaveLength(0);
    ai.submissions.push({ groups: [{ group: "新", items: [{ screenId: "d2", label: "登録" }] }] });
    fireEvent.click(button());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "置き換える" }));
    await waitFor(() => expect(layout().navigation.map((g) => g.group)).toEqual(["新"]));
  });

  it("道具を呼ばずに文章で JSON を返したときも読む。何も返さなければエラーのトースト", async () => {
    ai.key = "k";
    render(<NavigationProperties />);
    await waitFor(() => expect(button().disabled).toBe(false));
    ai.text = '```json\n{"groups":[{"group":"文章","items":[{"screenId":"d1","label":"探す"}]}]}\n```';
    fireEvent.click(button());
    await waitFor(() => expect(layout().navigation.map((g) => g.group)).toEqual(["文章"]));
    // 空のナビに戻して、今度は何も返さない
    act(() => {
      st().dispatch((m) => setDesignNavigation(m, { systemId: "sys_a", navigation: [] }));
    });
    ai.text = "考えました";
    fireEvent.click(button());
    await waitFor(() => expect(toasts().some((t) => t.includes("提出しませんでした"))).toBe(true));
    expect(layout().navigation).toEqual([]);
  });
});

describe("検証パネルとのつながり", () => {
  it("設計の検証は、メニューにも遷移にも無い画面を警告にする (レイアウトの編集で変わる)", () => {
    const warn = () => cachedCheckDesign(st().model, "sys_a").warnings.filter((w) => w.type === "screenUnreachable").map((w) => w.target!.id);
    expect(warn()).toEqual(["d1", "d3"]);
    act(() => {
      st().dispatch((m) => setDesignNavigation(m, { systemId: "sys_a", navigation: [{ id: "nav_1", group: "g", items: [{ screenId: "d1" }, { screenId: "d3" }] }] }));
    });
    expect(warn()).toEqual([]);
    act(() => {
      st().dispatch((m) => setDesignLayout(m, { systemId: "sys_a", shell: "plain" }));
    });
    // plain ではメニューが出ないので、メニューに入れていても辿れない
    expect(warn()).toEqual(["d1", "d3"]);
  });
});
