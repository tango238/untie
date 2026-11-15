import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addElement, emptyModel } from "@untie/core";
import { useAgentStore } from "../../ai/agentStore";
import { PROVIDERS } from "../../ai/providers";
import { getApiKey } from "../../ai/keys";
import { reverseLogic, type LogicResult } from "../../ai/reverseLogic";
import { reverseScreens, type ScreensResult } from "../../ai/reverseScreens";
import { forgetSources } from "../../ai/sourceRegistry";
import { MAX_SOURCES, memorySourceTree, type SourceTree } from "../../ai/sourceTree";
import { getPlatform } from "../../platform";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import { useUntieStore } from "../../store";
import { CreateFromSourceDialog, recommendNext, stageProgress } from "../ai/CreateFromSourceDialog";
import { FIXTURE_DSL } from "../../ai/__tests__/fixtures/reverseDraft";

vi.mock("../../ai/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/keys")>()),
  getApiKey: vi.fn().mockResolvedValue("sk-test"),
}));
vi.mock("../../ai/reverseScreens", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../ai/reverseScreens")>()), reverseScreens: vi.fn() }));
vi.mock("../../ai/reverseLogic", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../ai/reverseLogic")>()), reverseLogic: vi.fn() }));
// sqlImport は別の担当が実装している。SQL に CREATE TABLE があれば、FIXTURE_DSL (Order・OrderItem・Product) を返す偽物にする
vi.mock("@untie/core/model/sqlImport", () => ({
  sqlFilesToPrismaDsl: (files: { path: string; text: string }[]) => {
    const has = files.some((f) => /CREATE TABLE/i.test(f.text));
    return { dsl: has ? FIXTURE_DSL : "", tables: [], enums: [], notes: has ? [{ file: files[0]!.path, line: 2, message: "COMMENT ON の文を読み飛ばしました" }] : [], dslErrors: [] };
  },
}));

const mockedScreens = vi.mocked(reverseScreens);
const mockedLogic = vi.mocked(reverseLogic);
const tree = memorySourceTree("shop-app", {
  "src/orders.ts": "export const a = 1;",
  "src/ship.ts": "export const b = 2;",
  ".env": "SECRET=1",
  "node_modules/x/index.js": "x",
});
const treeWithSql = memorySourceTree("aozora-api", {
  "src/orders.ts": "a",
  "db/schema.sql": "CREATE TABLE a (id INT);\n",
  "db/migrations/001_init.sql": "CREATE TABLE a (id INT);\n",
  ".env": "S=1",
});

/** 画面・業務の段階の、偽の結果 (今のモデルに名前の違う業務を足したモデルを返す) */
function logicResult(over: Partial<LogicResult> = {}): LogicResult {
  const base = useUntieStore.getState().model;
  const added = addElement(base, { kind: "business", name: "受注" });
  return {
    model: added.ok ? added.model : base,
    added: { business: 1 },
    mappedInformations: 0,
    survey: "調査結果",
    warnings: [],
    seed: [{ role: "user", text: "seed" }],
    summary: "業務を足しました",
    ...over,
  };
}
function screensResult(over: Partial<ScreensResult> = {}): ScreensResult {
  const base = useUntieStore.getState().model;
  const sys = addElement(base, { kind: "system", name: "ネットショップ" });
  const m = sys.ok ? sys.model : base;
  const scr = sys.ok ? addElement(m, { kind: "screen", name: "注文入力", init: { systemId: sys.id } }) : { ok: false as const };
  return {
    model: scr.ok ? scr.model : m,
    added: { systems: 1, screens: 1, transitions: 0, ui: 0 },
    survey: "調査結果",
    warnings: [],
    seed: [{ role: "user", text: "seed" }],
    summary: "画面を足しました",
    ...over,
  };
}

async function fill(request = "受注から出荷まで") {
  fireEvent.change(screen.getByLabelText("モデルに起こしたい業務"), { target: { value: request } });
}
async function pickFolder(t: SourceTree = tree) {
  memory().sourceTree = t;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^(フォルダを選ぶ|選び直す)…$/ }));
  });
}
const card = (heading: RegExp) => within(screen.getByRole("heading", { name: heading }).closest("section")!);
const dataCard = () => card(/^1\. データ/);
const screensCard = () => card(/^2\. 画面/);
const logicCard = () => card(/^3\. 業務/);
const goButton = (c: ReturnType<typeof card>) => c.getByRole("button", { name: /^(進める|もう一度)$/ }) as HTMLButtonElement;
/** 業務の段階の「進める」 */
const startButton = () => goButton(logicCard());
const progressOf = (c: ReturnType<typeof card>) => c.getByText(/^進み具合: /).textContent!.replace("進み具合: ", "");

beforeEach(() => {
  resetStore(emptyModel("テスト"));
  forgetSources();
  mockedScreens.mockReset();
  mockedLogic.mockReset();
  vi.mocked(getApiKey).mockResolvedValue("sk-test");
  memory().sourceTree = null;
  memory().opened = null;
  memory().openedQueue = [];
});

describe("CreateFromSourceDialog: 段階のカード", () => {
  it("データ・画面・業務の 3 つのカードが並び、まだ何も無いときの進み具合は「まだ」。ソースの登録欄が上にある", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["1. データ", "2. 画面", "3. 業務"]);
    expect([dataCard(), screensCard(), logicCard()].map(progressOf)).toEqual(["まだ", "まだ", "まだ"]);
    expect(screen.getByRole("list", { name: "ソースコードの場所" })).toBeDefined();
    expect(screen.getByText(/置き換えません/)).toBeDefined();
    expect(screen.getByText(/おすすめはこの順/)).toBeDefined();
  });

  it("進み具合は、いまのモデルの状態から導く (データベースとテーブル・画面と画面 UI・業務)", () => {
    const db = useUntieStore.getState().model;
    const withDb = { ...db, databases: [{ id: "db1", name: "DB", dsl: FIXTURE_DSL, tables: [] }] };
    expect(stageProgress(withDb).data).toEqual({ text: "データベース 1 つ・テーブル 3", done: true });
    expect(stageProgress(db).data).toEqual({ text: "まだ", done: false });
    resetStore(withDb);
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(progressOf(dataCard())).toBe("データベース 1 つ・テーブル 3");
    expect(goButton(screensCard()).textContent).toBe("進める");
  });

  it("次に勧める段階: データのあとは画面、画面のあとは業務、業務のあとはデータが無ければデータ", () => {
    const m = useUntieStore.getState().model;
    expect(recommendNext(m, "data")?.stage).toBe("screens");
    expect(recommendNext(m, "screens")?.stage).toBe("logic");
    expect(recommendNext(m, "logic")?.stage).toBe("data");
    const full = { ...m, databases: [{ id: "d", name: "D", dsl: FIXTURE_DSL, tables: [] }] };
    expect(recommendNext(full, "logic")).toBeNull();
  });

  it("説明: データの段階は AI に何も送らないと明記し、画面・業務の段階は AI に送るものを段階ごとに書く", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(dataCard().getByText(/AI には何も送りません/)).toBeDefined();
    const label = PROVIDERS[useAgentStore.getState().settings.provider].label;
    expect(screensCard().getByText(/の API に送られるのは/).textContent).toContain(label);
    expect(screensCard().getByText(/対象の範囲の文/)).toBeDefined();
    expect(logicCard().getByText(/起こしたい業務の文/)).toBeDefined();
    expect(screen.getByText(/node_modules/)).toBeDefined();
    expect(screensCard().getByText(/数分かかり、API の利用料がかかります/)).toBeDefined();
    expect(logicCard().getByText(/数分かかり、API の利用料がかかります/)).toBeDefined();
  });

  it("画面・業務の段階は、ソース (全部) を登録するまで、業務はさらに入力するまで、始められない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(goButton(screensCard()).disabled).toBe(true);
    expect(startButton().disabled).toBe(true);
    await pickFolder();
    expect(goButton(screensCard()).disabled).toBe(false);
    expect(startButton().disabled).toBe(true);
    await fill();
    expect(startButton().disabled).toBe(false);
    await fill("  ");
    expect(startButton().disabled).toBe(true);
  });

  it("フォルダを選ぶと名前と読めるファイル数 (除外後) が出る。取り消しでは変わらない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    expect(screen.getByText("shop-app")).toBeDefined();
    expect(screen.getByText("読めるファイル 2 件")).toBeDefined();
    memory().sourceTree = null;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "選び直す…" }));
    });
    expect(screen.getByText("shop-app")).toBeDefined();
  });

  it("読めるファイルが 0 件なら始められない旨を出す。打ち切られた木はその旨を出す", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    memory().sourceTree = { ...memorySourceTree("empty", { ".env": "x" }), truncated: true };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "フォルダを選ぶ…" }));
    });
    await fill();
    expect(screen.getByText(/AI が読めるファイルがありません/)).toBeDefined();
    expect(screen.getByText(/途中までしか数えていません/)).toBeDefined();
    expect(startButton().disabled).toBe(true);
    expect(goButton(screensCard()).disabled).toBe(true);
  });

  it("前の段階が無いときの案内が出る (止めはしない)", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screensCard().getByText(/データの段階がまだです/)).toBeDefined();
    expect(logicCard().getByText(/データと画面の段階がまだです/)).toBeDefined();
    await pickFolder();
    await fill();
    expect(startButton().disabled).toBe(false);
  });
});

describe("CreateFromSourceDialog: 段階 1 データ (AI を使わない)", () => {
  async function open(t: SourceTree = treeWithSql) {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder(t);
    await waitFor(() => expect(dataCard().getByRole("list", { name: "スキーマ定義の候補" })).toBeDefined());
  }
  const convert = async () => {
    await act(async () => {
      fireEvent.click(dataCard().getByRole("button", { name: "変換して確かめる" }));
    });
    await waitFor(() => expect(dataCard().getByText(/^変換の結果/)).toBeDefined());
  };
  const importIt = async () => {
    await act(async () => {
      fireEvent.click(dataCard().getByRole("button", { name: "取り込む" }));
    });
  };

  it("ソースから SQL の候補を探して一覧に出す (パス・大きさ・CREATE TABLE の有無)。既定は、マイグレーションではない CREATE TABLE のある SQL", async () => {
    await open();
    const list = dataCard().getByRole("list", { name: "スキーマ定義の候補" });
    const rows = within(list).getAllByRole("checkbox");
    expect(rows).toHaveLength(2);
    const byName = (n: RegExp) => within(list).getByRole("checkbox", { name: n }) as HTMLInputElement;
    expect(byName(/db\/schema\.sql/).checked).toBe(true);
    expect(byName(/001_init\.sql/).checked).toBe(false);
    expect(within(list).getAllByText(/CREATE TABLE あり/)).toHaveLength(2);
    expect(within(list).getByText(/マイグレーション/)).toBeDefined();
  });

  it("候補が無いときはその旨を出す。ソースを登録していなければ、登録を促す", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(dataCard().getByText(/ソースを登録すると/)).toBeDefined();
    await pickFolder(tree);
    await waitFor(() => expect(dataCard().getByText(/SQL と schema.prisma は見つかりませんでした/)).toBeDefined());
    expect(dataCard().getByText(/ORM のモデル定義だけ/)).toBeDefined();
  });

  it("変換して確かめる: テーブルの数・列の数・名前・気づいたこと (どのファイルのどの行か) を見せる。変換するまで取り込めない", async () => {
    await open();
    expect(dataCard().queryByRole("button", { name: "取り込む" })).toBeNull();
    await convert();
    expect(dataCard().getByText("変換の結果: テーブル 3 (列 11)")).toBeDefined();
    const tables = dataCard().getByRole("list", { name: "変換したテーブル" });
    expect(within(tables).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Order 列 4", "OrderItem 列 4", "Product 列 3"]);
    expect(dataCard().getByText("db/schema.sql:2: COMMENT ON の文を読み飛ばしました")).toBeDefined();
    expect((dataCard().getByRole("button", { name: "取り込む" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("取り込む: データベースの名前の既定は「ソースのフォルダ名のデータベース」。モデルに足され、1 件の履歴になり、AI のキーも要らない。次の段階を勧める", async () => {
    vi.mocked(getApiKey).mockResolvedValue(null);
    await open();
    expect((dataCard().getByLabelText("データベースの名前") as HTMLInputElement).value).toBe("aozora-apiのデータベース");
    fireEvent.change(dataCard().getByLabelText("データベースの名前"), { target: { value: "注文DB" } });
    await convert();
    await importIt();
    const m = useUntieStore.getState().model;
    expect(m.databases.map((d) => d.name)).toEqual(["注文DB"]);
    expect(m.designs).toEqual([]);
    expect(progressOf(dataCard())).toBe("データベース 1 つ・テーブル 3");
    expect(screen.getByText(/データの段階が終わりました。データベース「注文DB」に、テーブル 3 \(列 11\) を取り込みました。/)).toBeDefined();
    expect(screen.getByText(/次に勧める段階:/).textContent).toContain("画面");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockedScreens).not.toHaveBeenCalled();
    expect(useUntieStore.getState().history.past).toHaveLength(1);
    useUntieStore.getState().undo();
    expect(useUntieStore.getState().model.databases).toEqual([]);
    expect(useAgentStore.getState().items.some((i) => i.text.includes("取り込みました"))).toBe(true);
  });

  it("同じ名前のデータベースがあれば、置き換えるかを確かめる (外れる対応の件数つき)。やめれば何も変わらない", async () => {
    const seeded = { ...useUntieStore.getState().model, databases: [{ id: "db1", name: "aozora-apiのデータベース", dsl: FIXTURE_DSL.replace("  status     String\n", ""), tables: [] }] };
    resetStore(seeded);
    await open();
    await convert();
    await importIt();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/データベース「aozora-apiのデータベース」はすでにあります/);
    expect(alert.textContent).toMatch(/外れる対応はありません/);
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(useUntieStore.getState().model.databases[0]!.dsl).not.toContain("status");
    await importIt();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置き換える" }));
    });
    expect(useUntieStore.getState().model.databases).toHaveLength(1);
    expect(useUntieStore.getState().model.databases[0]!.id).toBe("db1");
    expect(useUntieStore.getState().model.databases[0]!.dsl).toContain("status");
  });

  it("置き換えで外れる画面の対応の件数を、確認に出す", async () => {
    const base = useUntieStore.getState().model;
    const sys = addElement(base, { kind: "system", name: "S" });
    if (!sys.ok) throw new Error(sys.reason);
    const withDesign = {
      ...sys.model,
      databases: [{ id: "db1", name: "aozora-apiのデータベース", dsl: FIXTURE_DSL + "\nmodel Extra {\n  id String @id\n  note String\n}\n", tables: [{ table: "Extra", informationIds: [] }] }],
      designs: [
        {
          systemId: sys.id,
          databaseIds: ["db1"],
          screens: [{ id: "ds1", source: { kind: "builtin" as const, builtin: "home" as const }, view: { title: "x" }, bindings: [{ item: "a", databaseId: "db1", table: "Extra", column: "note" }, { item: "b", databaseId: "db1", table: "Order", column: "customer" }] }],
          transitions: [],
          layout: { shell: "shell" as const, navigation: [] },
        },
      ],
    };
    resetStore(withDesign as never);
    await open();
    await convert();
    await importIt();
    expect(screen.getByRole("alert").textContent).toMatch(/画面の項目と列の対応 1 件/);
  });

  it("SQL のファイルを直接選べる (何度でも足せる・外せる)。選べる種類を SQL・Prisma に絞って渡す", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    memory().openedQueue = [
      { path: null, name: "dump1.sql", text: "CREATE TABLE a (id INT);" },
      { path: null, name: "dump2.sql", text: "-- 2" },
    ];
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(dataCard().getByRole("button", { name: "SQL のファイルを選ぶ…" }));
      });
    }
    expect(memory().openOptions).toEqual([{ description: "SQL・Prisma のスキーマ", extensions: ["sql", "prisma"] }, { description: "SQL・Prisma のスキーマ", extensions: ["sql", "prisma"] }]);
    const picked = dataCard().getByRole("list", { name: "直接選んだファイル" });
    expect(within(picked).getAllByRole("listitem")).toHaveLength(2);
    expect((dataCard().getByLabelText("データベースの名前") as HTMLInputElement).value).toBe("データベース");
    await convert();
    fireEvent.click(dataCard().getByRole("button", { name: "dump2.sql を外す" }));
    expect(within(dataCard().getByRole("list", { name: "直接選んだファイル" })).getAllByRole("listitem")).toHaveLength(1);
    // 選ぶ組が替わったら、変換の結果は古いので消える
    expect(dataCard().queryByText(/^変換の結果/)).toBeNull();
    await convert();
    await importIt();
    expect(useUntieStore.getState().model.databases.map((d) => d.name)).toEqual(["データベース"]);
  });

  it("テーブルが見つからない変換の結果は、取り込めない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    memory().opened = { path: null, name: "empty.sql", text: "SELECT 1;" };
    await act(async () => {
      fireEvent.click(dataCard().getByRole("button", { name: "SQL のファイルを選ぶ…" }));
    });
    await convert().catch(() => {});
    await waitFor(() => expect(dataCard().getByText("テーブルが 1 つも見つかりませんでした。")).toBeDefined());
    expect((dataCard().getByRole("button", { name: "取り込む" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("DSL に解析エラーがあるときは、エラーを出して取り込めない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    memory().opened = { path: null, name: "bad.prisma", text: "model {" };
    await act(async () => {
      fireEvent.click(dataCard().getByRole("button", { name: "SQL のファイルを選ぶ…" }));
    });
    await act(async () => {
      fireEvent.click(dataCard().getByRole("button", { name: "変換して確かめる" }));
    });
    await waitFor(() => expect(dataCard().getByText(/DSL のエラー/)).toBeDefined());
    expect((dataCard().getByRole("button", { name: "取り込む" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("クラウドのファイルには取り込まず、理由を出す", async () => {
    await open();
    await convert();
    useUntieStore.setState({ cloud: { fileId: "f", role: "owner", status: "connected" } as never });
    await importIt();
    expect(screen.getByRole("alert").textContent).toMatch(/クラウドのファイル/);
    useUntieStore.setState({ cloud: null });
  });
});

describe("CreateFromSourceDialog: 段階 2 画面・段階 3 業務 (AI)", () => {
  it("画面の段階: 今のモデルを土台に reverseScreens が呼ばれ、範囲が渡る。進み具合が出て、終わると結果と次の段階を出して閉じない", async () => {
    let opts!: Parameters<typeof reverseScreens>[2];
    mockedScreens.mockImplementation(async (base, _s, o) => {
      opts = o;
      expect(base).toBe(useUntieStore.getState().model);
      return screensResult({ warnings: ["画面 UI: 画面「注文入力」は置けませんでした"] });
    });
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    fireEvent.change(screen.getByLabelText("対象の画面の範囲 (任意)"), { target: { value: "注文まわりだけ" } });
    await act(async () => {
      fireEvent.click(goButton(screensCard()));
    });
    await waitFor(() => expect(screen.getByText(/画面の段階が終わりました/)).toBeDefined());
    expect(opts.scope).toBe("注文まわりだけ");
    expect(opts.rebuild).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/気づいたことが 1 件あります/)).toBeDefined();
    expect(screen.getByText("画面 UI: 画面「注文入力」は置けませんでした")).toBeDefined();
    expect(screen.getByText(/次に勧める段階:/).textContent).toContain("業務");
    expect(progressOf(screensCard())).toBe("画面 1 (画面 UI 0)");
    expect(goButton(screensCard()).textContent).toBe("もう一度");
    // 登録欄と、ほかの段階は、また使える
    expect(screen.getByRole("list", { name: "ソースコードの場所" })).toBeDefined();
    expect(useUntieStore.getState().model.elements.some((e) => e.kind === "system" && e.name === "ネットショップ")).toBe(true);
    expect(useUntieStore.getState().history.past).toHaveLength(1);
  });

  it("実行中は、その段階の進み具合 (手順・読んだ場所・調査結果・提出と画面ごとの結果) を出し、登録欄とほかの段階は畳む。中断できる", async () => {
    let opts!: Parameters<typeof reverseScreens>[2];
    mockedScreens.mockImplementation((_b, _s, o) => {
      opts = o;
      return new Promise(() => {});
    });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await act(async () => {
      fireEvent.click(goButton(screensCard()));
    });
    await waitFor(() => expect(mockedScreens).toHaveBeenCalled());
    act(() => {
      opts.onStep?.("survey");
      opts.onSourceTool?.("読む", "src/orders.ts");
      opts.onText?.("注文は orders.ts にある");
    });
    expect(screen.getAllByText(/1\/3 ソースコードを調べる/).length).toBeGreaterThan(0);
    expect(screen.getByText("読んだ場所 (1 件)")).toBeDefined();
    expect(screen.getByText("読む src/orders.ts")).toBeDefined();
    expect(screen.getByText("注文は orders.ts にある")).toBeDefined();
    act(() => {
      opts.onStep?.("ui");
      opts.onSubmit?.(true, "受け付けました: システム 1");
      opts.onScreen?.(2, 5, "注文一覧", true);
    });
    expect(screen.getAllByText(/3\/3 画面 UI を作る/).length).toBeGreaterThan(0);
    expect(screen.getByText("✓ 受け付けました: システム 1")).toBeDefined();
    expect(screen.getByText("画面 2/5")).toBeDefined();
    // 畳む: 登録欄・カード・入力欄は無く、要約と段階の進み具合
    expect(screen.queryByRole("list", { name: "ソースコードの場所" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^1\. データ/ })).toBeNull();
    expect(screen.queryByLabelText("モデルに起こしたい業務")).toBeNull();
    expect(document.querySelector(".source-summary-sources")!.textContent).toBe("ソースコード「shop-app」");
    expect(document.querySelector(".source-summary-request")!.textContent).toBe("画面の段階");
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(opts.signal?.aborted).toBe(true);
  });

  it("業務の段階: 起こしたい業務が reverseLogic に渡り、結果が今のモデルに足され、AI のペインへ要約を引き継ぐ。次は、データが無ければデータ", async () => {
    mockedLogic.mockImplementation(async (_b, _s, req) => {
      expect(req).toBe("受注から出荷まで");
      return logicResult();
    });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(/業務の段階が終わりました/)).toBeDefined());
    expect(screen.getByText(/気づいたことはありません/)).toBeDefined();
    expect(screen.getByText(/次に勧める段階:/).textContent).toContain("データ");
    expect(progressOf(logicCard())).toBe("業務 1");
    expect(useAgentStore.getState().items.some((m) => m.text === "業務を足しました")).toBe(true);
    expect(useAgentStore.getState().open).toBe(true);
  });

  it("段階をまたいで引き継ぐ会話に、前の段階の要約が残る", async () => {
    mockedScreens.mockImplementation(async () => screensResult());
    mockedLogic.mockImplementation(async () => logicResult({ seed: [{ role: "user", text: "業務の seed" }] }));
    const spy = vi.spyOn(useAgentStore.getState(), "continueFrom");
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(goButton(screensCard()));
    });
    await waitFor(() => expect(screen.getByText(/画面の段階が終わりました/)).toBeDefined());
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(/業務の段階が終わりました/)).toBeDefined());
    const seeds = spy.mock.calls.map((c) => c[0].map((t) => t.text));
    expect(seeds[seeds.length - 1]).toEqual(["ソースコードから「画面」の段階を実行しました。", "画面を足しました", "業務の seed"]);
    spy.mockRestore();
  });

  it("API キーが無ければ、画面・業務の段階では理由を出して始めない (データの段階は使える)", async () => {
    vi.mocked(getApiKey).mockResolvedValue(null);
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await act(async () => {
      fireEvent.click(goButton(screensCard()));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/API キーが設定されていません/);
    expect(mockedScreens).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "ソースコードの場所" })).toBeDefined();
  });

  it("失敗するとエラーを出し、モデルは変わらず、もう一度できる", async () => {
    mockedLogic.mockRejectedValueOnce(new Error("boom"));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    const before = useUntieStore.getState().model;
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(document.querySelector(".prompt-error")).not.toBeNull());
    expect(useUntieStore.getState().model).toBe(before);
    expect(useUntieStore.getState().history.past).toHaveLength(0);
    expect((screen.getByLabelText("モデルに起こしたい業務") as HTMLTextAreaElement).value).toBe("受注から出荷まで");
    mockedLogic.mockImplementationOnce(async () => logicResult());
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/業務の段階が終わりました/)).toBeDefined());
  });

  it("「進める」を続けて押しても、実行は 1 本だけ", async () => {
    mockedLogic.mockImplementation(() => new Promise(() => {}));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalled());
    expect(mockedLogic).toHaveBeenCalledTimes(1);
  });

  it("中断すると「中断しました。」を出し、結果が届いてもモデルに反映しない", async () => {
    let opts!: Parameters<typeof reverseLogic>[3];
    let resolve!: (r: LogicResult) => void;
    mockedLogic.mockImplementation((_b, _s, _r, o) => {
      opts = o;
      return new Promise((r) => (resolve = r));
    });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    const before = useUntieStore.getState().model;
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(opts.signal?.aborted).toBe(true);
    await act(async () => {
      resolve(logicResult());
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("中断しました。"));
    expect(useUntieStore.getState().model).toBe(before);
    expect(screen.getByRole("list", { name: "ソースコードの場所" })).toBeDefined();
  });

  it("実行中にダイアログが外れたら中断し、あとで結果が届いてもモデルも会話も変えない", async () => {
    let opts!: Parameters<typeof reverseLogic>[3];
    let resolve!: (r: LogicResult) => void;
    mockedLogic.mockImplementation((_b, _s, _r, o) => {
      opts = o;
      return new Promise((r) => (resolve = r));
    });
    const view = render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    const before = useUntieStore.getState().model;
    const itemsBefore = useAgentStore.getState().items.length;
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalled());
    view.unmount();
    expect(opts.signal?.aborted).toBe(true);
    await act(async () => {
      resolve(logicResult());
    });
    expect(useUntieStore.getState().model).toBe(before);
    expect(useAgentStore.getState().items).toHaveLength(itemsBefore);
  });

  it("実行している間にモデルが替わったら、結果は反映せず、理由を出す", async () => {
    let resolve!: (r: LogicResult) => void;
    mockedLogic.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalled());
    const result = logicResult();
    useUntieStore.setState({ model: { ...useUntieStore.getState().model, meta: { ...useUntieStore.getState().model.meta, name: "手で直した" } } });
    await act(async () => {
      resolve(result);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/モデルが変わったので/));
    expect(useUntieStore.getState().model.meta.name).toBe("手で直した");
    expect(useUntieStore.getState().model.elements.some((e) => e.kind === "business")).toBe(false);
  });

  it("AI のペインが作業中は、画面・業務の段階を始められない", async () => {
    useAgentStore.setState({ running: true });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    expect(startButton().disabled).toBe(true);
    expect(goButton(screensCard()).disabled).toBe(true);
    expect(screen.getAllByText(/AI のペインが作業中です/).length).toBeGreaterThan(0);
    useAgentStore.setState({ running: false });
  });

  it("今のモデルに足すので、「保存していない変更」の確認は出さない", async () => {
    useUntieStore.setState((s) => ({ savedModel: { ...s.model, meta: { ...s.model.meta, name: "別" } } }));
    memory().discard = false;
    mockedLogic.mockImplementation(async () => logicResult());
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mockedLogic).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/業務の段階が終わりました/)).toBeDefined());
    memory().discard = true;
  });

  it("画面 UI を作り直す画面は、画面 UI がすでにある画面から選べる。選んだ画面が rebuild に渡る", async () => {
    const base = useUntieStore.getState().model;
    const sys = addElement(base, { kind: "system", name: "ネットショップ" });
    if (!sys.ok) throw new Error(sys.reason);
    const scr = addElement(sys.model, { kind: "screen", name: "注文入力", init: { systemId: sys.id } });
    if (!scr.ok) throw new Error(scr.reason);
    const seeded = {
      ...scr.model,
      designs: [{ systemId: sys.id, databaseIds: [], screens: [{ id: "ds1", source: { kind: "screen" as const, screenId: scr.id }, view: { title: "注文入力" } }], transitions: [], layout: { shell: "shell" as const, navigation: [] } }],
    };
    resetStore(seeded as never);
    mockedScreens.mockImplementation(async () => screensResult());
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    fireEvent.click(screen.getByText("画面 UI を作り直す画面を選ぶ (任意)"));
    fireEvent.click(screen.getByRole("checkbox", { name: /ネットショップ \/ 注文入力/ }));
    await act(async () => {
      fireEvent.click(goButton(screensCard()));
    });
    await waitFor(() => expect(mockedScreens).toHaveBeenCalled());
    expect(mockedScreens.mock.calls[0]![2].rebuild).toEqual([{ system: "ネットショップ", screen: "注文入力" }]);
  });
});

describe("CreateFromSourceDialog: 登録したソースを覚える", () => {
  it("ダイアログを閉じて開き直しても、登録したソース (ラベル・フォルダ) が残り、段階ごとに選び直さなくてよい", async () => {
    const first = render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    fireEvent.change(screen.getByLabelText("ラベル (任意)"), { target: { value: "バックエンド" } });
    first.unmount();
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screen.getByText("shop-app")).toBeDefined();
    expect(screen.getByText("読めるファイル 2 件")).toBeDefined();
    expect((screen.getByLabelText("ラベル (任意)") as HTMLInputElement).value).toBe("バックエンド");
    await fill();
    expect(startButton().disabled).toBe(false);
  });

  it("複数のソースも覚える", async () => {
    const first = render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    addRow();
    await pickRow(2, adminTree);
    first.unmount();
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: "選び直す…" })).toHaveLength(2);
    expect(labelBox(1).value).toBe("aozora-api");
    expect(labelBox(2).value).toBe("管理画面");
  });

  it("別のモデルを開いたら (docSeq が替わったら) 忘れる。ファイルやモデルには保存しない", async () => {
    const first = render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    first.unmount();
    useUntieStore.getState().newDocument(emptyModel("別のモデル"));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screen.queryByText("shop-app")).toBeNull();
    expect(screen.getAllByRole("button", { name: "フォルダを選ぶ…" })).toHaveLength(1);
    expect(JSON.stringify(useUntieStore.getState().model)).not.toContain("shop-app");
  });
});

// ---------------------------------------------------------------- 複数のソース

const backTree = memorySourceTree("aozora-api", { "src/routes/orders.ts": "a", "prisma/schema.prisma": "b", ".env": "S=1" });
const adminTree = memorySourceTree("aozora-admin", { "src/pages/Pending.tsx": "c" });
const shopTree = memorySourceTree("aozora-shop", { "src/pages/OrderNew.tsx": "d", "src/pages/OrderStatus.tsx": "e", "README.md": "f" });

/** n 番目 (1 始まり) の行でフォルダを選ぶ */
async function pickRow(n: number, t: SourceTree) {
  memory().sourceTree = t;
  const buttons = screen.getAllByRole("button", { name: /^(フォルダを選ぶ|選び直す)…$/ });
  await act(async () => {
    fireEvent.click(buttons[n - 1]!);
  });
}
const addRow = () => fireEvent.click(screen.getByRole("button", { name: "ソースコードの場所を足す" }));
const labelBox = (n: number) => screen.getByLabelText(`ソース ${n} のラベル`) as HTMLInputElement;
const setLabel = (n: number, value: string) => fireEvent.change(labelBox(n), { target: { value } });

async function threeSources() {
  render(<CreateFromSourceDialog onClose={() => {}} />);
  await pickRow(1, backTree);
  addRow();
  await pickRow(2, adminTree);
  addRow();
  await pickRow(3, shopTree);
}

describe("CreateFromSourceDialog: ソースの登録 (複数のソース)", () => {
  it("開いた直後は 1 行だけで、ラベルは任意。ソースを足す行がある", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: "フォルダを選ぶ…" })).toHaveLength(1);
    expect(screen.getByLabelText("ラベル (任意)")).toBeDefined();
    expect(screen.getByRole("button", { name: "ソースコードの場所を足す" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /を外す/ })).toBeNull(); // 選んでいない 1 行は外せない
    expect(screen.queryByText(/合計 読めるファイル/)).toBeNull();
  });

  it("行を足すと、使っていない候補がラベルに入り、フォーカスが新しい行のラベルへ移る。1 つ目が空なら 1 つ目にも入る", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    addRow();
    expect(labelBox(1).value).toBe("バックエンド");
    expect(labelBox(2).value).toBe("管理画面");
    expect(document.activeElement).toBe(labelBox(2));
    addRow();
    expect(labelBox(3).value).toBe("フロント画面");
    expect(document.activeElement).toBe(labelBox(3));
    // 候補は <datalist> で選べて、自由にも書ける
    expect(document.querySelectorAll("datalist option")).toHaveLength(6);
    expect(labelBox(3).getAttribute("list")).toBe(document.querySelector("datalist")!.id);
    setLabel(3, "お客様サイト");
    expect(labelBox(3).value).toBe("お客様サイト");
  });

  it("上限の数まで足せて、それ以上は足せない", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    for (let i = 1; i < MAX_SOURCES; i++) addRow();
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("source-row"))).toHaveLength(MAX_SOURCES);
    expect((screen.getByRole("button", { name: "ソースコードの場所を足す" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`${MAX_SOURCES} か所まで登録できます`)).toBeDefined();
  });

  it("1 行だけのときは、フォルダを選んでもラベルを自動で入れない。2 行目を足すと、空のラベルへフォルダ名を規則に合う形に整えて入れる", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    expect((screen.getByLabelText("ラベル (任意)") as HTMLInputElement).value).toBe("");
    addRow();
    expect(labelBox(1).value).toBe("aozora-api");
    await pickRow(2, adminTree);
    expect(labelBox(2).value).toBe("管理画面"); // 入っていれば変えない
    setLabel(1, "");
    await pickRow(1, shopTree); // 2 行以上のときの選び直し: 空ならフォルダ名
    expect(labelBox(1).value).toBe("aozora-shop");
  });

  it("2 行目を足したとき、規則に当たるフォルダ名は整えて入る (40 文字まで・~ を取る)", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, memorySourceTree(`~${"y".repeat(60)}`, { "a.ts": "a" }));
    addRow();
    expect(labelBox(1).value).toBe("y".repeat(40));
    await pickRow(2, adminTree);
    await fill();
    expect(startButton().disabled).toBe(false);
  });

  it("3 つ登録すると、行ごとのフォルダ名と読めるファイル数、合計が出る。作成できる", async () => {
    await threeSources();
    const rows = Array.from(document.querySelectorAll(".source-row"));
    expect(rows.map((r) => r.querySelector(".source-folder-name strong")!.textContent)).toEqual(["aozora-api", "aozora-admin", "aozora-shop"]);
    expect(rows.map((r) => r.querySelector(".source-folder-count")!.textContent)).toEqual(["読めるファイル 2 件", "読めるファイル 1 件", "読めるファイル 3 件"]);
    expect(screen.getByText("合計 読めるファイル 6 件")).toBeDefined();
    expect(screen.getByText(/ラベルが、どのソースのファイルかを示すパスの先頭/)).toBeDefined();
    expect(screen.getAllByText(/フォルダ名とラベル、ファイルの一覧/).length).toBeGreaterThan(0);
    await fill();
    expect(startButton().disabled).toBe(false);
  });

  it("行を外せる。外す名前に行の内容が入る。最後の 1 行を外すと空の行に戻る", async () => {
    await threeSources();
    expect(screen.getByRole("button", { name: "ソース 2「管理画面」を外す" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "ソース 2「管理画面」を外す" }));
    expect(screen.queryByText("aozora-admin")).toBeNull();
    expect(screen.getByText("合計 読めるファイル 5 件")).toBeDefined();
    expect(screen.getByRole("button", { name: "ソース 2「フロント画面」を外す" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "ソース 2「フロント画面」を外す" }));
    expect(screen.queryByText(/合計 読めるファイル/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ソース 1「aozora-api」を外す" }));
    expect(screen.getAllByRole("button", { name: "フォルダを選ぶ…" })).toHaveLength(1);
    expect((screen.getByLabelText("ラベル (任意)") as HTMLInputElement).value).toBe("");
  });

  it("選び直しで、その行だけ替わる", async () => {
    await threeSources();
    await pickRow(2, shopTree);
    expect(Array.from(document.querySelectorAll(".source-row")).map((r) => r.querySelector(".source-folder-name strong")!.textContent)).toEqual(["aozora-api", "aozora-shop", "aozora-shop"]);
    expect(labelBox(2).value).toBe("管理画面"); // ラベルは変わらない
  });

  it("2 つ以上なら、ラベルは必須。空・使えない文字・重複はその場でエラーを出し、作成を押せない", async () => {
    await threeSources();
    await fill();
    setLabel(2, "");
    expect(screen.getByText("ラベルを入力してください")).toBeDefined();
    expect(startButton().disabled).toBe(true);
    expect(labelBox(2).getAttribute("aria-invalid")).toBe("true");
    setLabel(2, "管理/画面");
    expect(screen.getByText(/「\/」「\\」「:」は使えません/)).toBeDefined();
    expect(startButton().disabled).toBe(true);
    setLabel(2, "..");
    expect(screen.getByText(/「.」「..」はラベルに使えません/)).toBeDefined();
    setLabel(2, "aozora-api");
    expect(screen.getByText(/1 番目のソースと重なっています/)).toBeDefined();
    expect(startButton().disabled).toBe(true);
    // 大文字小文字・全角半角の違いだけでも重複
    setLabel(1, "API");
    setLabel(2, "ａｐｉ");
    expect(screen.getByText(/1 番目のソースと重なっています/)).toBeDefined();
    setLabel(2, "管理画面");
    expect(document.querySelector(".source-row-problem")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it("見えない文字・glob の記号を含むラベルは断る", async () => {
    await threeSources();
    await fill();
    for (const bad of ["\u00ad", "\u3164", "管理\u00ad画面", "x\u{e0041}", "管理*", "管理{a}", "管理\u034f"]) {
      setLabel(2, bad);
      expect(startButton().disabled, JSON.stringify(bad)).toBe(true);
      expect(labelBox(2).getAttribute("aria-invalid")).toBe("true");
    }
    setLabel(2, "管理画面");
    expect(startButton().disabled).toBe(false);
  });

  it("行を足した直後は、空のラベルのエラーを読み上げない (alert にしない)。欄を離れてから出し、入力中のエラーは aria-live polite", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    for (let i = 1; i < 7; i++) addRow();
    // 7 行目は候補が尽きて、ラベルが空で足される (足した直後は、エラーを出さない)
    expect(labelBox(7).value).toBe("");
    expect(document.querySelector(".source-row-problem")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(labelBox(7));
    const problem = document.querySelector(".source-row-problem")!;
    expect(problem.textContent).toBe("ラベルを入力してください");
    expect(problem.getAttribute("role")).toBeNull();
    expect(problem.getAttribute("aria-live")).toBe("polite");
  });

  it("ソースが 1 つのときは、ラベルが空でも作れる。使えないラベルは断る", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    setLabel1("");
    await fill();
    expect(startButton().disabled).toBe(false);
    setLabel1("a/b");
    expect(startButton().disabled).toBe(true);
    function setLabel1(v: string) {
      fireEvent.change(screen.getByLabelText("ラベル (任意)"), { target: { value: v } });
    }
  });

  it("フォルダを選んでいない行があると作れない。読めるファイルが 0 件の行があっても作れない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    addRow();
    await fill();
    expect(startButton().disabled).toBe(true);
    await pickRow(2, memorySourceTree("empty", { ".env": "x" }));
    expect(screen.getByText(/AI が読めるファイルがありません/)).toBeDefined();
    expect(startButton().disabled).toBe(true);
    await pickRow(2, adminTree);
    expect(startButton().disabled).toBe(false);
  });

  it("同じフォルダを重ねて登録したら、警告を出す (作成は止めない)。別のフォルダなら出さない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    addRow();
    await pickRow(2, adminTree);
    await waitFor(() => expect(screen.queryByText(/重ねて登録していませんか/)).toBeNull());
    await pickRow(2, memorySourceTree("aozora-api", Object.fromEntries(backTree.files.map((f) => [f.path, "x".repeat(f.size)]))));
    await waitFor(() => expect(screen.getByText(/同じフォルダを、ソース 1 と重ねて登録していませんか/)).toBeDefined());
    await fill();
    expect(startButton().disabled).toBe(false);
    // isSameEntry で確かめられる木は、それを優先する (名前もファイルも同じでも、別のフォルダなら警告しない)
    const other = { ...adminTree, sameFolderAs: async () => false } as SourceTree;
    await pickRow(2, other);
    await waitFor(() => expect(screen.queryByText(/重ねて登録していませんか/)).toBeNull());
    const same = { ...shopTree, name: "x", sameFolderAs: async () => true } as SourceTree;
    await pickRow(2, same);
    await waitFor(() => expect(screen.getByText(/重ねて登録していませんか/)).toBeDefined());
  });

  it("フォルダをたどっている間 (選び直し中) は作成を押せない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, backTree);
    await fill();
    expect(startButton().disabled).toBe(false);
    let release!: (t: SourceTree | null) => void;
    const spy = vi.spyOn(getPlatform(), "pickSourceFolder").mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "選び直す…" }));
    });
    expect(startButton().disabled).toBe(true);
    await act(async () => {
      release(adminTree);
    });
    expect(startButton().disabled).toBe(false);
    spy.mockRestore();
  });

  it("同じ名前の別のフォルダに選び直したら、同じフォルダの警告を見直す (消える。逆も検出される)", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    const a = memorySourceTree("same-name", { "src/a.ts": "aaa" });
    const b = memorySourceTree("other-name", { "src/b.ts": "bbbb" });
    await pickRow(1, a);
    addRow();
    await pickRow(2, memorySourceTree("same-name", { "src/a.ts": "aaa" })); // 名前もファイルも同じ
    await waitFor(() => expect(screen.getByText(/重ねて登録していませんか/)).toBeDefined());
    // 同じ名前 (same-name) のまま、中身が違うフォルダに選び直す → 警告は消える
    await pickRow(2, memorySourceTree("same-name", { "src/zzz.ts": "z" }));
    await waitFor(() => expect(screen.queryByText(/重ねて登録していませんか/)).toBeNull());
    // 逆: 名前が同じで中身も同じものへ選び直すと検出される
    await pickRow(2, memorySourceTree("same-name", { "src/a.ts": "aaa" }));
    await waitFor(() => expect(screen.getByText(/重ねて登録していませんか/)).toBeDefined());
    await pickRow(1, b);
    await waitFor(() => expect(screen.queryByText(/重ねて登録していませんか/)).toBeNull());
  });

  it("合計が上限を超えるとき、打ち切られたソースがあっても、分け合うことを知らせる (読めない・検索されないことも)", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    const many = (n: number, name: string) => memorySourceTree(name, Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.ts`, "x"])));
    await pickRow(1, { ...many(15000, "big1"), truncated: true } as SourceTree);
    addRow();
    await pickRow(2, many(9000, "big2"));
    expect(screen.getByText(/合計が上限 \(20,000 件\) を超えるため/)).toBeDefined();
    expect(screen.getAllByText(/読み取りも検索もできません/)).toHaveLength(2); // 分け合いの知らせと、打ち切られた行の知らせ
    expect(screen.getByText(/途中までしか数えていません/)).toBeDefined();
  });

  it("合計が上限を超えるとき、ソースごとに分け合うことを知らせる。打ち切られたソースにはその旨を出す", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, { ...backTree, truncated: true } as SourceTree);
    expect(screen.getByText(/途中までしか数えていません/)).toBeDefined();
    addRow();
    await pickRow(2, { ...adminTree, depthTruncated: true } as SourceTree);
    expect(screen.getByText(/深すぎるフォルダは読んでいません/)).toBeDefined();
  });

  it("行の操作の名前: ラベル欄は行の番号つき、フォルダを選ぶボタンは行の見出しに結ばれる", async () => {
    await threeSources();
    const buttons = screen.getAllByRole("button", { name: "選び直す…" });
    expect(buttons).toHaveLength(3);
    const titles = buttons.map((b) => document.getElementById(b.getAttribute("aria-describedby")!)!.textContent);
    expect(titles).toEqual(["ソース 1", "ソース 2", "ソース 3"]);
  });
});
