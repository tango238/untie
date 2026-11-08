import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDatabase, setDatabaseDsl, setDesignDatabases, setTableInformation } from "@untie/core/model/commands";
import { emptyModel, type Element, type Relation, type UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import type { ChatOptions } from "../../ai/chat";
import App from "../../App";
import { DataLeftPane } from "../design/DataLeftPane";
import { DataProperties } from "../design/DataProperties";
import { DesignCheckPanel } from "../design/DesignCheckPanel";
import { DslEditor } from "../design/DslEditor";
import { Toolbar } from "../Toolbar";

vi.mock("../canvas/Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));
vi.mock("../design/SitemapCanvas", () => ({ SitemapCanvas: () => <div data-testid="sitemap-canvas" /> }));

const ai = vi.hoisted(() => ({ key: null as string | null, sent: [] as string[], submissions: [] as unknown[], results: [] as { ok: boolean; content: string }[] }));
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
          const r = await o.runTool("submit_database", ai.submissions.shift());
          ai.results.push(r);
          if (r.ok) break;
        }
        return "提出しました";
      },
    }),
  };
});

const st = () => useUntieStore.getState();

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "scr_1", kind: "screen", name: "予約一覧", systemId: "sys_a" },
  { id: "info_a", kind: "information", name: "予約", contextId: null },
  { id: "info_b", kind: "information", name: "客", description: "宿泊客", contextId: null },
  { id: "info_c", kind: "information", name: "部屋", contextId: null },
  { id: "info_x", kind: "information", name: "他システムの情報", contextId: null },
] as Element[];

const RELATIONS: [string, string, Relation["kind"]][] = [
  ["info_a", "sys_a", "informationSystem"],
  ["scr_1", "info_b", "screenInformation"],
  ["scr_1", "info_c", "screenInformation"],
];

function model(): UntieModel {
  const m = emptyModel();
  m.elements = ELEMENTS.map((e) => ({ ...e }));
  m.relations = RELATIONS.map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  m.boards = [{ id: "board_1", name: "全体", nodes: [] }];
  return m;
}

const DSL = `model Reservation {
  id    String @id
  guest Guest  @relation(fields: [guestId], references: [id])
  guestId String
  note  String?
  @@map("reservations")
}
model Guest {
  id String @id
}`;

/** 既定のデータベース (DSL と対応つき) に別のデータベース「分析用」を足した状態で、データボードを開く */
function prepare(withDsl = true) {
  let m = model();
  m = ok(addDatabase(m, { id: "db_default", name: "既定のデータベース" }));
  m = ok(addDatabase(m, { id: "db_x", name: "分析用" }));
  if (withDsl) {
    m = ok(setDatabaseDsl(m, { id: "db_default", dsl: DSL }));
    m = ok(setTableInformation(m, { id: "db_default", table: "Reservation", informationIds: ["info_a"] }));
    m = ok(setTableInformation(m, { id: "db_default", table: "Ghost", informationIds: ["info_c"] }));
  }
  resetStore(m);
  act(() => st().enterDesign("sys_a"));
  act(() => st().setCurrentBoard("design:data"));
}
function ok(r: { ok: boolean; model?: UntieModel; reason?: string }): UntieModel {
  if (!r.ok) throw new Error(r.reason);
  return r.model!;
}

beforeEach(() => {
  localStorage.clear();
  useUntieStore.setState({ cloud: null });
  ai.key = null;
  ai.sent = [];
  ai.submissions = [];
  ai.results = [];
});

const dbOf = (id: string) => st().model.databases.find((d) => d.id === id)!;
const area = () => screen.getByLabelText("DSL") as HTMLTextAreaElement;

describe("データボードの左ペイン", () => {
  it("データベースが無いと案内を出し、追加すると選ばれる (db_ の id)", () => {
    resetStore(model());
    act(() => st().enterDesign("sys_a"));
    render(<DataLeftPane />);
    expect(screen.getByText("データベースがまだありません。")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "＋データベース" }));
    fireEvent.change(screen.getByLabelText("新しいデータベースの名前"), { target: { value: "  売上  " } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(st().model.databases).toHaveLength(1);
    expect(st().model.databases[0]!.id.startsWith("db_")).toBe(true);
    expect(st().model.databases[0]!.name).toBe("売上");
    expect(st().ui.designDatabaseId).toBe(st().model.databases[0]!.id);
    expect(screen.queryByLabelText("新しいデータベースの名前")).toBeNull();
  });

  it("何もチェックが無いと、既定の規則で使われるデータベースに「既定」の印と 1 行の説明を出す", () => {
    prepare();
    render(<DataLeftPane />);
    const row = (id: string) => document.querySelector(`[data-database="${id}"]`) as HTMLElement;
    expect(within(row("db_default")).getByText("既定")).toBeDefined();
    expect(within(row("db_x")).queryByText("既定")).toBeNull();
    expect(screen.getByText(/何もチェックしないと/)).toBeDefined();
    expect((screen.getByLabelText("既定のデータベース をこの設計で使う") as HTMLInputElement).checked).toBe(false);
  });

  it("使うチェックで designs[].databaseIds を変え、設計が無ければ作る。チェックを外すと既定に戻る", () => {
    prepare();
    expect(st().model.designs).toEqual([]);
    render(<DataLeftPane />);
    fireEvent.click(screen.getByLabelText("分析用 をこの設計で使う"));
    expect(st().model.designs[0]!.databaseIds).toEqual(["db_x"]);
    expect((screen.getByLabelText("分析用 をこの設計で使う") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("既定")).toBeNull();
    fireEvent.click(screen.getByLabelText("分析用 をこの設計で使う"));
    expect(st().model.designs[0]!.databaseIds).toEqual([]);
    expect(screen.getByText("既定")).toBeDefined();
  });

  it("名前を押すとそのデータベースを選び、テーブルの一覧が切り替わる", () => {
    prepare();
    render(<DataLeftPane />);
    expect(screen.getByRole("button", { name: "Reservation" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "分析用" }));
    expect(st().ui.designDatabaseId).toBe("db_x");
    expect(screen.queryByRole("button", { name: "Reservation" })).toBeNull();
    expect(screen.getByText("DSL に model がありません。")).toBeDefined();
  });

  it("テーブルの一覧: 名前と情報の数。対応はあるのに DSL に無いテーブルは薄く「DSL にありません」と出す", () => {
    prepare();
    render(<DataLeftPane />);
    const tables = screen.getByRole("region", { name: "テーブル" });
    const items = within(tables).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Reservation情報 1", "Guest情報 0", "GhostDSL にありません (情報 1)"]);
    fireEvent.click(within(tables).getByRole("button", { name: "Ghost" }));
    expect(st().ui.designTableName).toBe("Ghost");
    fireEvent.click(within(tables).getByRole("button", { name: "Guest" }));
    expect(st().ui.designTableName).toBe("Guest");
  });

  it("選んだデータベースの名前を変えられる (空にはできない)", () => {
    prepare();
    render(<DataLeftPane />);
    const input = screen.getByLabelText("データベースの名前");
    fireEvent.change(input, { target: { value: "本番" } });
    fireEvent.blur(input);
    expect(dbOf("db_default").name).toBe("本番");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(dbOf("db_default").name).toBe("本番");
  });

  it("空のデータベースは確認なしで削除する", () => {
    prepare();
    render(<DataLeftPane />);
    fireEvent.click(screen.getByRole("button", { name: "分析用" }));
    fireEvent.click(screen.getByRole("button", { name: "このデータベースを削除" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(st().model.databases.map((d) => d.id)).toEqual(["db_default"]);
    // 選んでいたものが消えたので、既定の規則で使われるものに代わる
    expect(st().ui.designDatabaseId).toBe("db_default");
  });

  it("DSL や対応があるデータベースの削除は、消えるものと使っている設計を並べて確認する", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_default"] }));
    });
    render(<DataLeftPane />);
    fireEvent.click(screen.getByRole("button", { name: "このデータベースを削除" }));
    const dialog = screen.getByRole("dialog", { name: "データベースを削除" });
    const details = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(details).toEqual(["DSL (2 個の model)", "テーブルと情報の対応 2 件", "使っている設計: 予約システム", expect.stringContaining("既定の規則")]);
    expect(within(dialog).getByRole("button", { name: "削除" }).className).toContain("danger");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(st().model.databases).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "このデータベースを削除" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }));
    expect(st().model.databases.map((d) => d.id)).toEqual(["db_x"]);
    expect(st().model.designs[0]!.databaseIds).toEqual([]);
  });

  it("閲覧専用では追加・削除・チェックができない", () => {
    prepare();
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<DataLeftPane />);
    expect(screen.queryByRole("button", { name: "＋データベース" })).toBeNull();
    expect(screen.queryByRole("button", { name: "このデータベースを削除" })).toBeNull();
    expect((screen.getByLabelText("分析用 をこの設計で使う") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("DSL のエディタ", () => {
  it("選んだデータベースの DSL を出し、解析エラーが無いと要約を出す", () => {
    prepare();
    render(<DslEditor />);
    expect(area().value).toBe(DSL);
    expect(screen.getByText("エラーなし (model 2、enum 0)")).toBeDefined();
  });

  it("入力中は下書きで、blur で確定する。Cmd+Enter でも確定する", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.change(area(), { target: { value: "model A {\n  id String @id\n}" } });
    expect(dbOf("db_default").dsl).toBe(DSL);
    fireEvent.blur(area());
    expect(dbOf("db_default").dsl).toBe("model A {\n  id String @id\n}");
    expect(st().history.past).toHaveLength(1);
    fireEvent.change(area(), { target: { value: "model B { id Int }" } });
    fireEvent.keyDown(area(), { key: "Enter", metaKey: true });
    expect(dbOf("db_default").dsl).toBe("model B { id Int }");
    fireEvent.change(area(), { target: { value: "model C { id Int }" } });
    fireEvent.keyDown(area(), { key: "Enter", ctrlKey: true });
    expect(dbOf("db_default").dsl).toBe("model C { id Int }");
  });

  it("同時編集の更新があっても下書きを壊さず、下書きが無いときだけ外の値に追従する", () => {
    prepare();
    render(<DslEditor />);
    act(() => {
      st().dispatch((m) => setDatabaseDsl(m, { id: "db_default", dsl: "model Other { id Int }" }));
    });
    expect(area().value).toBe("model Other { id Int }");
    fireEvent.change(area(), { target: { value: "書きかけ" } });
    act(() => {
      st().dispatch((m) => setDatabaseDsl(m, { id: "db_default", dsl: "model Remote { id Int }" }));
    });
    expect(area().value).toBe("書きかけ");
  });

  it("書きかけのまま別のボードへ移る (アンマウント) と確定する", () => {
    prepare();
    const { unmount } = render(<DslEditor />);
    fireEvent.change(area(), { target: { value: "model Saved { id Int }" } });
    unmount();
    expect(dbOf("db_default").dsl).toBe("model Saved { id Int }");
  });

  it("解析エラーを行:列つきで並べ、押すとその行にカーソルを移す。壊れていても保存する", () => {
    prepare();
    render(<DslEditor />);
    const broken = "model A {\n  id String @id\n  1x Int\n}";
    fireEvent.change(area(), { target: { value: broken } });
    fireEvent.blur(area());
    expect(dbOf("db_default").dsl).toBe(broken);
    expect(screen.getByText("解析エラー 1 件")).toBeDefined();
    const button = screen.getByRole("button", { name: "3:3" });
    fireEvent.click(button);
    expect(area().selectionStart).toBe("model A {\n  id String @id\n".length + 2);
    expect(document.activeElement).toBe(area());
  });

  it("閲覧専用では読み取りで、ボタンも押せない", () => {
    prepare();
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<DslEditor />);
    expect(area().readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "雛形を足す" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "情報から作る (AI)" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("雛形を足す: 対応していない情報の model と対応を末尾に足す。足すものが無ければ何もしない", () => {
    prepare();
    act(() => {
      st().selectDesignDatabase("db_default");
    });
    render(<DslEditor />);
    fireEvent.click(screen.getByRole("button", { name: "雛形を足す" }));
    // 予約 (info_a) は Reservation、部屋 (info_c) は Ghost に対応済み。客 (info_b) だけ足す
    const db = dbOf("db_default");
    expect(db.dsl.startsWith(DSL)).toBe(true);
    expect(db.dsl).toContain('// TODO: 名前を直す\nmodel Table1 {\n  id String @id\n  @@map("客")\n}');
    expect(db.tables.find((t) => t.table === "Table1")?.informationIds).toEqual(["info_b"]);
    expect(area().value).toBe(db.dsl);
    expect(screen.getByText(/エラーなし/)).toBeDefined();
    const before = st().model;
    fireEvent.click(screen.getByRole("button", { name: "雛形を足す" }));
    expect(st().model).toBe(before);
    expect(st().toasts.some((t) => t.message.includes("対応していない情報はありません"))).toBe(true);
  });

  it("書きかけの下書きがあっても、雛形を足す前に確定する", () => {
    prepare(false);
    act(() => st().selectDesignDatabase("db_default"));
    render(<DslEditor />);
    fireEvent.change(area(), { target: { value: "model Mine { id Int }" } });
    fireEvent.click(screen.getByRole("button", { name: "雛形を足す" }));
    expect(dbOf("db_default").dsl.startsWith("model Mine { id Int }")).toBe(true);
    expect(dbOf("db_default").tables).toHaveLength(3);
  });
});

describe("情報から作る (AI)", () => {
  const button = () => screen.getByRole("button", { name: /情報から作る/ }) as HTMLButtonElement;

  it("API キーが無いとボタンを無効にし、「AI の設定」でキーを入れる旨を添える", async () => {
    prepare();
    render(<DslEditor />);
    await waitFor(() => expect(screen.getByText(/API キーを入れてください/)).toBeDefined());
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "AI の設定" }));
  });

  it("キーがあれば押せる。空の DSL なら確認なしで生成して、DSL と対応を置き換える", async () => {
    ai.key = "k";
    prepare(false);
    render(<DslEditor />);
    await waitFor(() => expect(button().disabled).toBe(false));
    ai.submissions.push({
      dsl: "model Reservation {\n  id String @id\n}\nmodel Guest {\n  id String @id\n}",
      tables: [
        { table: "Reservation", informationIds: ["info_a", "info_nope"] },
        { table: "Guest", informationIds: ["info_b"] },
        { table: "NotInDsl", informationIds: ["info_c"] },
      ],
    });
    fireEvent.click(button());
    await waitFor(() => expect(dbOf("db_default").dsl).toContain("model Guest"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dbOf("db_default").tables).toEqual([
      { table: "Reservation", informationIds: ["info_a"] },
      { table: "Guest", informationIds: ["info_b"] },
    ]);
    // 依頼にシステムが使う情報 (説明つき) が入り、他システムの情報は入らない
    expect(ai.sent[0]).toContain("宿泊客");
    expect(ai.sent[0]).not.toContain("他システムの情報");
    expect(st().history.past).toHaveLength(1);
  });

  it("DSL があれば置き換えの確認を出し、キャンセルすると生成しない。確認すると解析エラーを 1 回だけやり直させる", async () => {
    ai.key = "k";
    prepare();
    render(<DslEditor />);
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    fireEvent.click(within(screen.getByRole("dialog", { name: "DSL と対応を置き換える" })).getByRole("button", { name: "キャンセル" }));
    expect(ai.sent).toHaveLength(0);
    expect(dbOf("db_default").dsl).toBe(DSL);

    ai.submissions.push({ dsl: "model A {\n 1x Int\n}", tables: [] }, { dsl: "model A {\n  id String @id\n}", tables: [{ table: "A", informationIds: ["info_a"] }] });
    fireEvent.click(button());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "置き換える" }));
    await waitFor(() => expect(dbOf("db_default").dsl).toBe("model A {\n  id String @id\n}"));
    expect(ai.results.map((r) => r.ok)).toEqual([false, true]);
    expect(ai.results[0]!.content).toContain("解析エラー");
    expect(dbOf("db_default").tables).toEqual([{ table: "A", informationIds: ["info_a"] }]);
  });
});

describe("データボード全体", () => {
  it("DB を選んでいなくても、テーブルを押すと右のペインにテーブルのプロパティが出る", () => {
    prepare();
    act(() => st().setRightPanel("properties"));
    expect(st().ui.designDatabaseId).toBeUndefined();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Guest" }));
    expect(screen.getByTestId("table-properties")).toBeDefined();
    expect(within(screen.getByTestId("table-properties")).getByText("Guest")).toBeDefined();
  });

  it("別の文書を開いたあとにアンマウントしても、前の文書の下書きを書かない", () => {
    prepare();
    const { unmount } = render(<DslEditor />);
    fireEvent.change(area(), { target: { value: "model Stale { id Int }" } });
    const other = ok(addDatabase(model(), { id: "db_default", name: "別のファイルの DB" }));
    act(() => st().newDocument(other));
    unmount();
    expect(dbOf("db_default").dsl).toBe("");
  });

  it("解析エラーは先頭 100 件までで、残りは件数で出す", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.change(area(), { target: { value: "model A {\n" + "1x Int\n".repeat(150) + "}" } });
    expect(screen.getAllByRole("button", { name: /^\d+:\d+$/ })).toHaveLength(100);
    expect(screen.getByText("ほか 50 件")).toBeDefined();
  });

  it("検証の「使うデータベースが無い」はデータボードへ、画面 UI が無い警告は画面ボードへ移る。バッジはエラーだけ数える", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: [] }));
      st().dispatch((m) => ({ ok: true, model: { ...m, databases: [], designs: m.designs.map((d) => ({ ...d, screens: [{ id: "ds_1", source: { kind: "screen", screenId: "scr_1" } }] })) } as UntieModel }));
      st().setRightPanel("trace");
      st().setCurrentBoard("design:navigation");
    });
    render(<Toolbar />);
    expect(within(screen.getByRole("button", { name: /^検証/ })).getByText("1")).toBeDefined();
    expect(screen.getByRole("button", { name: /^検証/ }).textContent).toBe("検証1");
    cleanup();
    render(<DesignCheckPanel />);
    fireEvent.click(screen.getByRole("button", { name: /使うデータベースがありません/ }));
    expect(st().ui.currentBoardId).toBe("design:data");
  });
});

describe("データボードの右ペイン", () => {
  it("何も選んでいないとき: 概要と、システムが使う情報に対応するテーブル (無ければ未対応)", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_default"] }));
    });
    render(<DataProperties />);
    const overview = screen.getByTestId("data-overview");
    expect(within(overview).getByText("2 個 (enum 0 個)")).toBeDefined();
    expect(within(overview).getByText("予約システム")).toBeDefined();
    const row = (id: string) => overview.querySelector(`[data-information="${id}"]`) as HTMLElement;
    expect(within(row("info_a")).getByRole("button", { name: "Reservation" })).toBeDefined();
    expect(within(row("info_b")).getByText("未対応").className).toContain("unmapped");
    expect(overview.querySelector('[data-information="info_x"]')).toBeNull();
    fireEvent.click(within(row("info_c")).getByRole("button", { name: "Ghost" }));
    expect(st().ui.designTableName).toBe("Ghost");
  });

  it("テーブルを選ぶと列の一覧と表す情報のチェックを出す。チェックで対応を変える", () => {
    prepare();
    act(() => st().selectDesignDatabase("db_default", "Reservation"));
    render(<DataProperties />);
    const props = screen.getByTestId("table-properties");
    expect(within(props).getByText(/@@map: reservations/)).toBeDefined();
    const cols = Array.from(props.querySelectorAll("[data-column]")).map((li) => li.textContent);
    expect(cols).toEqual(["idString @id", "guestGuest @relation(guestId → id)", "guestIdString", "noteString?"]);
    // 対象システムが使う情報 (予約・客・部屋) を先に、ほかを「その他の情報」に
    expect((within(props).getByLabelText("予約") as HTMLInputElement).checked).toBe(true);
    expect((within(props).getByLabelText("客") as HTMLInputElement).checked).toBe(false);
    const others = props.querySelector("details.other-infos") as HTMLElement;
    expect(within(others).getByLabelText("他システムの情報")).toBeDefined();
    fireEvent.click(within(props).getByLabelText("客"));
    expect(dbOf("db_default").tables.find((t) => t.table === "Reservation")?.informationIds).toEqual(["info_a", "info_b"]);
    fireEvent.click(within(props).getByLabelText("予約"));
    fireEvent.click(within(props).getByLabelText("客"));
    expect(dbOf("db_default").tables.some((t) => t.table === "Reservation")).toBe(false);
    fireEvent.click(within(props).getByLabelText("他システムの情報"));
    expect(dbOf("db_default").tables.find((t) => t.table === "Reservation")?.informationIds).toEqual(["info_x"]);
  });

  it("DSL に無いテーブルを選ぶとその旨を出し、概要に戻れる", () => {
    prepare();
    act(() => st().selectDesignDatabase("db_default", "Ghost"));
    render(<DataProperties />);
    expect(screen.getByText("DSL にありません")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "データベースの概要に戻る" }));
    expect(st().ui.designTableName).toBeUndefined();
  });
});

describe("設計モードの検証", () => {
  it("「検証」のバッジと中身を、設計の検証に切り替える。分析モードは今までどおり", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: [] }));
    });
    render(<App />);
    const toolbarButton = () => screen.getByRole("button", { name: /^検証/ });
    // 客・部屋のうち、部屋は Ghost (DSL に無い) に、客は未対応。エラー: 未対応 1 + DSL に無い 1
    expect(within(toolbarButton()).getByText("2")).toBeDefined();
    fireEvent.click(toolbarButton());
    const panel = screen.getByRole("complementary", { name: "検証" });
    expect(within(panel).getByRole("heading", { name: "検証: 設計" })).toBeDefined();
    expect(within(panel).getByText(/客」が、使うデータベースのどのテーブルにも対応していません/)).toBeDefined();
    expect(within(panel).getByText(/Ghost がありません/)).toBeDefined();
    act(() => st().setMode("analysis"));
    expect(screen.getByRole("heading", { name: "検証: 担い手まで辿れるか" })).toBeDefined();
  });

  it("行を押すと該当へ移る: テーブル → データボードでそのテーブル、情報 → データボードの概要", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: [] }));
      st().setRightPanel("trace");
      st().selectDesignDatabase("db_x");
    });
    render(<DesignCheckPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Ghost がありません/ }));
    expect(st().ui.currentBoardId).toBe("design:data");
    expect(st().ui.designDatabaseId).toBe("db_default");
    expect(st().ui.designTableName).toBe("Ghost");
    expect(st().ui.rightPanel).toBe("properties");
    act(() => st().setRightPanel("trace"));
    fireEvent.click(screen.getByRole("button", { name: /客」が/ }));
    expect(st().ui.designTableName).toBeUndefined();
    expect(st().ui.currentBoardId).toBe("design:data");
  });

  it("警告の行(遷移・画面)を押すと、サイトマップでその画面を選ぶ", () => {
    prepare();
    act(() => {
      st().dispatch((m) => ({
        ok: true,
        model: {
          ...m,
          designs: [
            {
              systemId: "sys_a",
              databaseIds: [],
              screens: [
                { id: "ds_1", source: { kind: "screen", screenId: "scr_1" } },
                { id: "ds_top", source: { kind: "builtin", builtin: "top" } },
              ],
              transitions: [{ id: "tr_1", from: "ds_top", to: "ds_1" }],
              layout: { shell: "shell", navigation: [] },
            },
          ],
        },
      }));
      st().setRightPanel("trace");
    });
    render(<DesignCheckPanel />);
    expect(screen.getByRole("region", { name: "警告: きっかけが未定の遷移" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /「トップページ」→「予約一覧」/ }));
    expect(st().ui.currentBoardId).toBe("design:sitemap");
    expect(st().ui.designScreenId).toBe("ds_top");
    expect(st().ui.designTransitionId).toBe("tr_1");
    act(() => st().setRightPanel("trace"));
    fireEvent.click(screen.getByRole("button", { name: /画面 UI がまだ無い画面が 2 件/ }));
    expect(st().ui.currentBoardId).toBe("design:screen");
  });

  it("Toolbar の「検証」の件数は設計の検証の件数", () => {
    prepare();
    act(() => {
      st().dispatch((m) => setDesignDatabases(m, { systemId: "sys_a", databaseIds: [] }));
    });
    render(<Toolbar />);
    expect(within(screen.getByRole("button", { name: /^検証/ })).getByText("2")).toBeDefined();
  });
});

describe("ストアの選択", () => {
  it("データベースが無くなると既定の規則で使われるものに代わり、モードや対象を変えると消える", () => {
    prepare();
    act(() => st().selectDesignDatabase("db_x", "T"));
    act(() => {
      st().dispatch((m) => ({ ok: true, model: { ...m, databases: m.databases.filter((d) => d.id !== "db_x") } }));
    });
    expect(st().ui.designDatabaseId).toBe("db_default");
    expect(st().ui.designTableName).toBeUndefined();
    act(() => st().selectDesignDatabase("db_default", "Guest"));
    expect(st().ui.designTableName).toBe("Guest");
    act(() => st().setMode("analysis"));
    expect(st().ui.designDatabaseId).toBeUndefined();
    expect(st().ui.designTableName).toBeUndefined();
  });

  it("DSL から無くなったテーブル (対応も無い) の選択は消える", () => {
    prepare();
    act(() => st().selectDesignDatabase("db_default", "Guest"));
    act(() => {
      st().dispatch((m) => setDatabaseDsl(m, { id: "db_default", dsl: "model Reservation { id Int }" }));
    });
    expect(st().ui.designTableName).toBeUndefined();
    expect(st().ui.designDatabaseId).toBe("db_default");
  });
});
