import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitField, COMMIT_DELAY_MS } from "../CommitField";

/** 確定値を trim して返す、プロパティ欄の名前欄と同じ振る舞いの入れ物 */
function Harness({ onCommitted }: { onCommitted?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <CommitField
      label="名前"
      value={value}
      onCommit={(v) => {
        const t = v.trim();
        onCommitted?.(t);
        setValue(t);
      }}
    />
  );
}

const input = () => screen.getByLabelText("名前") as HTMLInputElement;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CommitField", () => {
  it("入力が止まって delay たつと確定する", () => {
    const committed: string[] = [];
    render(<Harness onCommitted={(v) => committed.push(v)} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "予約" } });
    expect(committed).toEqual([]);
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS));
    expect(committed).toEqual(["予約"]);
  });

  it("フォーカス中、trim された値が戻ってきてもローカルの末尾の空白を消さない", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "予約 " } });
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS + 10));
    expect(input().value).toBe("予約 ");
    // 全角空白も同様
    fireEvent.change(input(), { target: { value: "予約　" } });
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS + 10));
    expect(input().value).toBe("予約　");
    fireEvent.change(input(), { target: { value: "予約　確認" } });
    expect(input().value).toBe("予約　確認");
  });

  it("フォーカスが外れたあとは確定した値が表示される", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "予約 " } });
    fireEvent.blur(input());
    expect(input().value).toBe("予約");
  });

  it("IME の変換中は確定せず、変換が終わってから確定する", () => {
    const committed: string[] = [];
    render(<Harness onCommitted={(v) => committed.push(v)} />);
    fireEvent.focus(input());
    fireEvent.compositionStart(input());
    fireEvent.change(input(), { target: { value: "よやく" } });
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS * 3));
    expect(committed).toEqual([]);
    fireEvent.change(input(), { target: { value: "予約" } });
    fireEvent.compositionEnd(input());
    expect(committed).toEqual([]);
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS));
    expect(committed).toEqual(["予約"]);
  });

  it("変換中の Enter では確定しない", () => {
    const committed: string[] = [];
    render(<Harness onCommitted={(v) => committed.push(v)} />);
    fireEvent.focus(input());
    fireEvent.compositionStart(input());
    fireEvent.change(input(), { target: { value: "よやく" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(committed).toEqual([]);
  });

  it("500ms で確定したあと何も打たずに blur すると、欄の値が trim 後に揃う", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "予約 " } });
    act(() => vi.advanceTimersByTime(COMMIT_DELAY_MS + 10));
    expect(input().value).toBe("予約 ");
    fireEvent.blur(input());
    expect(input().value).toBe("予約");
  });

  it("keyCode 229 の Enter (WebKit の変換確定) では確定しない", () => {
    const committed: string[] = [];
    render(<Harness onCommitted={(v) => committed.push(v)} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "予約" } });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(committed).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect(committed).toEqual(["予約"]);
  });

  it("外から値が変わった (Undo など) ときは、フォーカスしていなければ取り込む", () => {
    const { rerender } = render(<CommitField label="名前" value="A" onCommit={() => {}} />);
    rerender(<CommitField label="名前" value="B" onCommit={() => {}} />);
    expect(input().value).toBe("B");
  });
});
