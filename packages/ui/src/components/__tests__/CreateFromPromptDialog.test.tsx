import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
