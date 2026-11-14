import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFromPrompt } from "../../ai/generate";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { CreateFromPromptDialog } from "../ai/CreateFromPromptDialog";

vi.mock("../../ai/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/keys")>()),
  getApiKey: vi.fn().mockResolvedValue("sk-test"),
}));
vi.mock("../../ai/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/generate")>()),
  // 分析に入ったまま終わらない生成
  generateFromPrompt: vi.fn((_request: string, o: { onStep?: (s: "analysis") => void }) => {
    o.onStep?.("analysis");
    return new Promise(() => {});
  }),
}));

beforeEach(() => resetStore());

describe("CreateFromPromptDialog", () => {
  it("生成中はボタンを「生成中…」にしてクルクルを出し、押せなくする", async () => {
    render(<CreateFromPromptDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("初期要望"), { target: { value: "旅館の予約業務" } });
    const button = screen.getByRole("button", { name: "作成" });
    expect(button.querySelector(".spinner")).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("生成中…");
    expect(button.querySelector(".spinner")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "中断" })).toBeDefined();
  });

  it("「作成」を続けて押しても、生成は 1 本だけ", async () => {
    vi.mocked(generateFromPrompt).mockClear();
    render(<CreateFromPromptDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("初期要望"), { target: { value: "旅館の予約業務" } });
    const button = screen.getByRole("button", { name: "作成" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(generateFromPrompt).toHaveBeenCalledTimes(1);
  });

  it("実行中にダイアログが外れたら中断し、あとで結果が届いてもモデルを置き換えない", async () => {
    let signal: AbortSignal | undefined;
    let finish!: (r: unknown) => void;
    vi.mocked(generateFromPrompt).mockImplementationOnce(((_r: string, o: { signal?: AbortSignal; onStep?: (s: "analysis") => void }) => {
      signal = o.signal;
      o.onStep?.("analysis");
      return new Promise((resolve) => (finish = resolve));
    }) as never);
    const before = useUntieStore.getState().model.meta.name;
    const { unmount } = render(<CreateFromPromptDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("初期要望"), { target: { value: "旅館の予約業務" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "作成" }));
    });
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish({ build: { model: { ...useUntieStore.getState().model, meta: { ...useUntieStore.getState().model.meta, name: "別" } } }, seed: [], summary: "x" });
    });
    expect(useUntieStore.getState().model.meta.name).toBe(before);
  });

  it("中断すると「中断しました。」を出す", async () => {
    vi.mocked(generateFromPrompt).mockImplementationOnce(((_r: string, o: { signal?: AbortSignal; onStep?: (s: "analysis") => void }) => {
      o.onStep?.("analysis");
      return new Promise((_res, rej) => o.signal?.addEventListener("abort", () => rej(new Error("Request was aborted."))));
    }) as never);
    render(<CreateFromPromptDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("初期要望"), { target: { value: "旅館の予約業務" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "作成" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "中断" }));
    });
    expect(screen.getByText("中断しました。")).toBeDefined();
  });
});
