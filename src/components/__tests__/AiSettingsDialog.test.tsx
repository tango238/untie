import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../ai/providers";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { AiSettingsDialog } from "../ai/AiSettingsDialog";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  localStorage.clear();
});

describe("AiSettingsDialog", () => {
  it("API キーを発行するページの URL を出し、コピーできる", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AiSettingsDialog />);
    const url = screen.getByLabelText("API キーを発行するページの URL") as HTMLInputElement;
    expect(url.value).toBe(PROVIDERS.claude.keyUrl);
    expect(url.readOnly).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "URL をコピー" }));
    });
    expect(writeText).toHaveBeenCalledWith(PROVIDERS.claude.keyUrl);
    expect(st().toasts[st().toasts.length - 1]?.message).toBe("URL をコピーしました");

    fireEvent.change(screen.getByLabelText("使う AI"), { target: { value: "gemini" } });
    expect(url.value).toBe(PROVIDERS.gemini.keyUrl);
  });

  it("コピーに失敗したら、URL を選んでコピーするよう伝える", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<AiSettingsDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "URL をコピー" }));
    });
    expect(st().toasts[st().toasts.length - 1]).toMatchObject({ tone: "error" });
  });

  it("キーチェーンから読み出せないときは「(読み出せません)」と理由を出し、保存し直すと消える", async () => {
    const keys = await import("../../ai/keys");
    const get = vi.spyOn(keys, "getApiKey").mockImplementation(async (p) => {
      if (p === "claude") throw new Error("User interaction is not allowed.");
      return null;
    });
    const save = vi.spyOn(keys, "setApiKey").mockResolvedValue(undefined);
    await act(async () => {
      render(<AiSettingsDialog />);
    });
    expect(screen.getByText(/API キー \(読み出せません\)/)).toBeDefined();
    expect(screen.getByRole("alert").textContent).toMatch(/User interaction is not allowed/);
    fireEvent.change(screen.getByLabelText("API キー"), { target: { value: "sk-test" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(save).toHaveBeenCalledWith("claude", "sk-test", { remember: false });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/API キー \(このタブを閉じるまで\)/)).toBeDefined();
    get.mockRestore();
    save.mockRestore();
  });

  it("ブラウザでは「このブラウザに保存する」を選んだときだけ、次に開いたときも API キーが残る", async () => {
    const keys = await import("../../ai/keys");
    await act(async () => {
      render(<AiSettingsDialog />);
    });
    const remember = screen.getByRole("checkbox", { name: /このブラウザに保存する/ }) as HTMLInputElement;
    expect(remember.checked).toBe(false);
    fireEvent.change(screen.getByLabelText("API キー"), { target: { value: "sk-tab" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(screen.getByText(/API キー \(このタブを閉じるまで\)/)).toBeDefined();
    expect(keys.isApiKeyRemembered("claude")).toBe(false);
    // 保存済みのキーは、チェックを入れるとすぐこのブラウザに移る
    await act(async () => {
      fireEvent.click(remember);
    });
    expect(screen.getByText(/API キー \(このブラウザに保存済み\)/)).toBeDefined();
    expect(localStorage.getItem("untie.apiKey.claude")).toBe("sk-tab");
    // 外すとブラウザからは消える (タブの間は使える)
    await act(async () => {
      fireEvent.click(remember);
    });
    expect(localStorage.getItem("untie.apiKey.claude")).toBeNull();
    expect(await keys.getApiKey("claude")).toBe("sk-tab");
    // 消すと両方から消える
    await act(async () => {
      fireEvent.click(remember);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "消す" }));
    });
    expect(localStorage.getItem("untie.apiKey.claude")).toBeNull();
    expect(await keys.getApiKey("claude")).toBeNull();
    expect((screen.getByRole("checkbox", { name: /このブラウザに保存する/ }) as HTMLInputElement).checked).toBe(false);
  });
});
