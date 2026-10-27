import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../ai/providers";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { AiSettingsDialog } from "../ai/AiSettingsDialog";

const st = () => useUntieStore.getState();

beforeEach(() => resetStore());

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
});
