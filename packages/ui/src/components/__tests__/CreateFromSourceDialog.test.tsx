import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../../ai/agentStore";
import type { ReverseOptions, ReverseResult } from "../../ai/reverse";
import { reverseEngineer } from "../../ai/reverse";
import { PROVIDERS } from "../../ai/providers";
import { memorySourceTree } from "../../ai/sourceTree";
import { emptyModel } from "@untie/core";
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
