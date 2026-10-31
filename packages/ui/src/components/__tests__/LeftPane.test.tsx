import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { LeftPane } from "../LeftPane";

const st = () => useUntieStore.getState();

beforeEach(() => resetStore());

describe("左のペイン (要素一覧)", () => {
  it("閉じると一覧を隠して細い帯だけにし、帯かボタンで開き直せる", () => {
    render(<LeftPane />);
    expect(screen.getByRole("complementary", { name: "要素一覧" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "要素一覧を閉じる" }));
    expect(st().ui.elementListOpen).toBe(false);
    expect(screen.queryByRole("complementary", { name: "要素一覧" })).toBeNull();
    // 帯で開き直す
    fireEvent.click(screen.getByRole("button", { name: "要素一覧" }));
    expect(st().ui.elementListOpen).toBe(true);
    expect(screen.getByRole("complementary", { name: "要素一覧" })).toBeDefined();
    // ボタンでも開き直せる
    fireEvent.click(screen.getByRole("button", { name: "要素一覧を閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "要素一覧を開く" }));
    expect(st().ui.elementListOpen).toBe(true);
  });

  it("開閉は履歴に積まない", () => {
    render(<LeftPane />);
    fireEvent.click(screen.getByRole("button", { name: "要素一覧を閉じる" }));
    expect(st().history.past).toHaveLength(0);
  });
});
