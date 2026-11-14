import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../../ai/agentStore";
import type { ReverseOptions, ReverseResult } from "../../ai/reverse";
import { reverseEngineer } from "../../ai/reverse";
import { PROVIDERS } from "../../ai/providers";
import { MAX_SOURCES, memorySourceTree, type LabeledSource, type SourceTree } from "../../ai/sourceTree";
import { emptyModel } from "@untie/core";
import { getPlatform } from "../../platform";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import { useUntieStore } from "../../store";
import { CreateFromSourceDialog } from "../ai/CreateFromSourceDialog";

vi.mock("../../ai/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/keys")>()),
  getApiKey: vi.fn().mockResolvedValue("sk-test"),
}));
vi.mock("../../ai/reverse", () => ({ reverseEngineer: vi.fn() }));

const mocked = vi.mocked(reverseEngineer);
const tree = memorySourceTree("shop-app", {
  "src/orders.ts": "export const a = 1;",
  "src/ship.ts": "export const b = 2;",
  ".env": "SECRET=1",
  "node_modules/x/index.js": "x",
});

function result(warnings: string[] = []): ReverseResult {
  return {
    build: { model: emptyModel("受注"), counts: {} } as unknown as ReverseResult["build"],
    survey: "調査結果",
    warnings,
    seed: [{ role: "user", content: "seed" }] as unknown as ReverseResult["seed"],
    summary: "作りました",
  };
}

async function fill(request = "受注から出荷まで") {
  fireEvent.change(screen.getByLabelText("モデルに起こしたい業務"), { target: { value: request } });
}
async function pickFolder() {
  memory().sourceTree = tree;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "フォルダを選ぶ…" }));
  });
}
const startButton = () => screen.getByRole("button", { name: /^(作成|やり直す)$|生成中/ }) as HTMLButtonElement;

beforeEach(() => {
  resetStore();
  mocked.mockReset();
});

describe("CreateFromSourceDialog", () => {
  it("フォルダ未選択・業務未入力では始められない", async () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(startButton().disabled).toBe(true);
    await fill();
    expect(startButton().disabled).toBe(true);
    await pickFolder();
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
  });

  it("送信前の説明に、API の送り先 (プロバイダー名) と読まないものが出る", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    const label = PROVIDERS[useAgentStore.getState().settings.provider].label;
    expect(screen.getByText(/の API に送られるのは/).textContent).toContain(label);
    expect(screen.getByText(/node_modules/)).toBeDefined();
  });

  it("進み具合のコールバックが画面に出て、中断で signal が abort される", async () => {
    let opts!: ReverseOptions;
    mocked.mockImplementation((_t, _r, o) => {
      opts = o;
      return new Promise(() => {});
    });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    act(() => {
      opts.onStep?.("survey");
      opts.onSourceTool?.("読む", "src/orders.ts");
      opts.onText?.("受注は orders.ts にある");
    });
    expect(screen.getAllByText(/1\/4 ソースコードを調べる/).length).toBeGreaterThan(0);
    expect(screen.getByText("読んだ場所 (1 件)")).toBeDefined();
    expect(screen.getByText("読む src/orders.ts")).toBeDefined();
    expect(screen.getByText("受注は orders.ts にある")).toBeDefined();
    act(() => {
      opts.onStep?.("screens");
      opts.onSubmit?.(true, "業務を提出しました");
      opts.onScreen?.(2, 5, "受注一覧", true);
    });
    expect(screen.getAllByText(/4\/4 画面を作る/).length).toBeGreaterThan(0);
    expect(screen.getByText("✓ 業務を提出しました")).toBeDefined();
    expect(screen.getByText("画面 2/5")).toBeDefined();
    expect(startButton().textContent).toBe("生成中…");
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(opts.signal?.aborted).toBe(true);
  });

  it("成功すると新しいモデルとして開き、会話を引き継いで閉じる", async () => {
    mocked.mockResolvedValue(result());
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useUntieStore.getState().model.meta.name).toBe("受注");
    expect(mocked.mock.calls[0]![1]).toBe("受注から出荷まで");
    const messages = useAgentStore.getState().items;
    expect(messages.some((m) => m.text === "作りました")).toBe(true);
  });

  it("気づいたことがあれば、閉じる前に件数と中身を見せる", async () => {
    mocked.mockResolvedValue(result(["画面「在庫」は置けませんでした"]));
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(/気づいたことが 1 件/)).toBeDefined());
    expect(screen.getByText("画面「在庫」は置けませんでした")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(useUntieStore.getState().model.meta.name).toBe("受注");
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("失敗するとエラーを出し、やり直せる", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(document.querySelector(".prompt-error")).not.toBeNull());
    expect(startButton().textContent).toBe("やり直す");
    mocked.mockResolvedValueOnce(result());
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
  });

  it("説明に、AI に送るものと、時間・利用料がかかることが出る", () => {
    render(<CreateFromSourceDialog onClose={() => {}} />);
    expect(screen.getByText(/ファイルの一覧 \(名前と大きさ\)、AI が開いたファイルの中身、検索で見つかった行/)).toBeDefined();
    expect(screen.getByText(/直接書かれたキーや個人情報は送られる/)).toBeDefined();
    expect(screen.getByText(/数分かかり、API の利用料がかかります/)).toBeDefined();
  });

  it("「作成」を続けて押しても、生成は 1 本だけ", async () => {
    mocked.mockImplementation(() => new Promise(() => {}));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("中断すると「中断しました。」を出し、結果が届いてもモデルを置き換えない", async () => {
    let opts!: ReverseOptions;
    let finish!: (r: ReverseResult) => void;
    mocked.mockImplementation((_t, _r, o) => {
      opts = o;
      return new Promise((resolve) => (finish = resolve));
    });
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    await act(async () => {
      finish(result());
    });
    expect(opts.signal?.aborted).toBe(true);
    expect(screen.getByText("中断しました。")).toBeDefined();
    expect(useUntieStore.getState().model.meta.name).not.toBe("受注");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("実行中にダイアログが外れたら中断し、あとで結果が届いてもモデルも会話も変えない", async () => {
    let opts!: ReverseOptions;
    let finish!: (r: ReverseResult) => void;
    mocked.mockImplementation((_t, _r, o) => {
      opts = o;
      return new Promise((resolve) => (finish = resolve));
    });
    const before = useUntieStore.getState().model.meta.name;
    const items = useAgentStore.getState().items;
    const onClose = vi.fn();
    const { unmount } = render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    unmount();
    expect(opts.signal?.aborted).toBe(true);
    await act(async () => {
      finish(result());
    });
    expect(useUntieStore.getState().model.meta.name).toBe(before);
    expect(useAgentStore.getState().items).toBe(items);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("進み具合の live region は段階の行だけ (調査結果の文章は含まない)", async () => {
    mocked.mockImplementation((_t, _r, o) => {
      o.onStep?.("data");
      o.onText?.("調査結果の文章");
      return new Promise(() => {});
    });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getAllByRole("status").length).toBeGreaterThan(0));
    const live = screen.getAllByRole("status");
    expect(live.map((n) => n.textContent)).toEqual(["3/4 データを作る"]);
  });

  it("読めるファイルの数は、木が替わったときだけ数える (入力や調査中の再描画では数え直さない)", async () => {
    let reads = 0;
    const counted = { ...tree, get files() { reads++; return tree.files; } } as typeof tree;
    memory().sourceTree = counted;
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "フォルダを選ぶ…" }));
    });
    expect(screen.getByText(/読めるファイル 2 件/)).toBeDefined();
    const after = reads;
    expect(after).toBeGreaterThan(0);
    for (const v of ["a", "ab", "abc"]) fireEvent.change(screen.getByLabelText("モデルに起こしたい業務"), { target: { value: v } });
    expect(reads).toBe(after);
  });

  it("調査結果の文章は届くたびに末尾までスクロールし、利用者が上へスクロールしているときは戻さない", async () => {
    let opts: ReverseOptions | undefined;
    mocked.mockImplementation((_t, _r, o) => {
      opts = o;
      o.onStep?.("survey");
      o.onText?.("最初の文\n");
      return new Promise(() => {});
    });
    const { container } = render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    const box = container.querySelector<HTMLElement>(".prompt-analysis")!;
    // jsdom は寸法を持たないので、枠の寸法とスクロール位置を差し込む
    let top = 0;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(box, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
    act(() => opts!.onText?.("次の文\n"));
    expect(top).toBe(500);
    // 上へスクロールした (末尾から離れた) ら、文章が届いても戻さない
    top = 50;
    fireEvent.scroll(box);
    act(() => opts!.onText?.("さらに次の文\n"));
    expect(top).toBe(50);
    // 末尾まで戻したら、また追う
    top = 400;
    fireEvent.scroll(box);
    act(() => opts!.onText?.("最後の文\n"));
    expect(top).toBe(500);
  });

  it("完了時の気づいたことの一覧は、全体ではなく件数の行だけが status (live region)", async () => {
    mocked.mockResolvedValue(result(["一つ目", "二つ目"]));
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(/気づいたことが 2 件/)).toBeDefined());
    const live = screen.getAllByRole("status");
    expect(live.map((n) => n.textContent)).toContain("モデルを作りました。気づいたことが 2 件あります。");
    expect(live.every((n) => !n.textContent!.includes("一つ目"))).toBe(true);
  });

  it("保存していない変更があって破棄しないなら、始めない", async () => {
    useUntieStore.setState((s) => ({ savedModel: { ...s.model } }));
    memory().discard = false;
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    expect(mocked).not.toHaveBeenCalled();
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

describe("CreateFromSourceDialog: 複数のソース", () => {
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

  it("フォルダ名がラベルの規則に当たっても (41 文字以上・~ で始まる)、1 行だけなら作成できる。2 行目を足すと整えた名前が入る", async () => {
    mocked.mockResolvedValue(result());
    const long = memorySourceTree("x".repeat(60), { "a.ts": "a" });
    render(<CreateFromSourceDialog onClose={() => {}} />);
    await pickRow(1, long);
    await fill();
    expect(startButton().disabled).toBe(false);
    await pickRow(1, memorySourceTree("~home-app", { "a.ts": "a" }));
    expect(startButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    // ラベルは空のまま渡る (調査の依頼にフォルダ名を重ねて入れない)
    expect((mocked.mock.calls[0]![0] as unknown as LabeledSource[]).map((x) => x.label)).toEqual([""]);
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
    expect(screen.getByText(/フォルダ名とラベル、ファイルの一覧/)).toBeDefined();
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
    for (const bad of ["\u00ad", "\u3164", "管理\u00ad画面", "x\u{e0041}", "管理*"]) {
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

  it("複数のソースが、ラベル付きで reverseEngineer に渡り、会話の最初の発言が複数と分かる形になる", async () => {
    mocked.mockResolvedValue(result());
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickRow(1, backTree);
    addRow();
    await pickRow(2, adminTree);
    addRow();
    await pickRow(3, shopTree);
    setLabel(1, " バックエンド ");
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sources = mocked.mock.calls[0]![0] as unknown as LabeledSource[];
    expect(sources.map((s) => [s.label, s.tree.name])).toEqual([["バックエンド", "aozora-api"], ["管理画面", "aozora-admin"], ["フロント画面", "aozora-shop"]]);
    expect(useAgentStore.getState().items.some((m) => m.text === "ソースコード 3 か所 (バックエンド (aozora-api)、管理画面 (aozora-admin)、フロント画面 (aozora-shop))から作成: 受注から出荷まで")).toBe(true);
  });

  it("ソースが 1 つのときの最初の発言は、これまでどおり", async () => {
    mocked.mockResolvedValue(result());
    const onClose = vi.fn();
    render(<CreateFromSourceDialog onClose={onClose} />);
    await pickFolder();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useAgentStore.getState().items.some((m) => m.text === "ソースコード「shop-app」から作成: 受注から出荷まで")).toBe(true);
    expect((mocked.mock.calls[0]![0] as unknown as LabeledSource[]).map((s) => s.label)).toEqual([""]);
  });

  it("実行中は行の操作ができず、二度押しでも 1 本だけ。中断できる", async () => {
    let opts!: ReverseOptions;
    mocked.mockImplementation((_t, _r, o) => {
      opts = o;
      return new Promise(() => {});
    });
    await threeSources();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked).toHaveBeenCalledTimes(1);
    // 生成が始まったら、登録欄・説明・入力欄は畳んで要約になる (行の操作はできない)
    expect(screen.queryByRole("button", { name: "ソースコードの場所を足す" })).toBeNull();
    expect(screen.queryByLabelText("モデルに起こしたい業務")).toBeNull();
    expect(document.querySelector(".source-summary-sources")!.textContent).toBe("ソースコード 3 か所 (aozora-api・管理画面・フロント画面)");
    expect(document.querySelector(".source-summary-request")!.textContent).toBe("業務: 受注から出荷まで");
    expect(document.querySelector(".source-rows")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(opts.signal?.aborted).toBe(true);
  });

  it("生成中も、進み具合は登録欄の下ではなく本文の先頭に近い位置に出る。失敗したら登録欄に戻って、やり直せる。終わって気づいたことを出すときも畳んだまま", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));
    await threeSources();
    await fill();
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(document.querySelector(".prompt-error")).not.toBeNull());
    // 失敗: 登録欄・入力欄が戻り、入力は残っている
    expect(document.querySelector(".source-summary")).toBeNull();
    expect(document.querySelectorAll(".source-row")).toHaveLength(3);
    expect((screen.getByLabelText("モデルに起こしたい業務") as HTMLTextAreaElement).value).toBe("受注から出荷まで");
    expect(startButton().textContent).toBe("やり直す");
    mocked.mockResolvedValueOnce(result(["気づいたこと 1"]));
    await act(async () => {
      fireEvent.click(startButton());
    });
    await waitFor(() => expect(screen.getByText(/気づいたことが 1 件/)).toBeDefined());
    expect(document.querySelector(".source-summary")).not.toBeNull();
    expect(document.querySelector(".source-rows")).toBeNull();
    expect(document.querySelector(".source-dialog-body")!.contains(screen.getByText("気づいたこと 1"))).toBe(true);
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
