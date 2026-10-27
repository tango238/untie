import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  // React Flow を使わない固定ボードで確かめる
  st().setCurrentBoard("fixed:activity");
});

describe("右のペイン", () => {
  it("閉じると中身を隠して細い帯だけにし、帯かボタンで開き直せる", () => {
    const { container } = render(<App />);
    expect(screen.getByRole("complementary", { name: "プロパティ" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    expect(st().ui.rightPanelOpen).toBe(false);
    expect(screen.queryByRole("complementary", { name: "プロパティ" })).toBeNull();
    expect(container.querySelector(".main")!.classList.contains("panel-closed")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "プロパティ" }));
    expect(screen.getByRole("complementary", { name: "プロパティ" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "右のペインを開く" }));
    expect(st().ui.rightPanelOpen).toBe(true);
  });

  it("閉じているとき「課題一覧」を押すと、開いて課題一覧を出す", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "右のペインを閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "課題一覧" }));
    expect(screen.getByRole("complementary", { name: "課題一覧" })).toBeDefined();
  });
});
