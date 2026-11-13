import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";
import { InformationBoard } from "../workflow/InformationBoard";
import { canvasApi } from "../canvas/canvasApi";
import App from "../../App";

const st = () => useUntieStore.getState();
const selectedId = () => {
  const sel = st().ui.selection;
  return sel?.type === "element" ? sel.id : null;
};
const dialog = () => screen.queryByRole("dialog", { name: "削除の確認" });

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setCurrentBoard("simple:information"));
});

const renderBoth = () =>
  render(
    <>
      <InformationBoard />
      <PropertyPanel />
    </>,
  );
const contexts = () => st().model.elements.filter((e) => e.kind === "context");

describe("情報と状態ボードの描画", () => {
  it("コンテキストの枠の中に、情報の行 (バリエーションの枠つき) と、状態グループごとの状態が入る。条件は出さない", () => {
    render(<InformationBoard />);
    const ctx = contexts()[0]!;
    const frame = screen.getByRole("region", { name: `コンテキスト ${ctx.name}` });
    expect(within(frame).getAllByRole("group", { name: /^情報 .* の行$/ }).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("information-board")).queryAllByRole("button", { name: /^条件 / })).toHaveLength(0);
    expect(screen.getAllByRole("region", { name: /^状態グループ / }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("list", { name: "バリエーションの一覧" }).length).toBeGreaterThan(0);
  });

  it("コンテキストが決まっていない要素は、別の枠に出る。用語はユーザー向け (集約などを出さない)", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "information", name: "宙の情報", id: "info_float" })));
    render(<InformationBoard />);
    const none = screen.getByRole("region", { name: "コンテキストが決まっていない" });
    expect(within(none).getByRole("button", { name: /^情報 宙の情報/ })).toBeDefined();
    expect(document.body.textContent).not.toMatch(/集約|境界づけ|ドメイン|BUC/);
  });

  it("canvasApi.focus は登録され、片付けで外れる", () => {
    const { unmount } = render(<InformationBoard />);
    expect(canvasApi.focus).toBeDefined();
    unmount();
    expect(canvasApi.focus).toBeUndefined();
  });
});

describe("選択", () => {
  it("コンテキスト・情報・バリエーション・状態を押すと選択してプロパティに出し、aria-current が付く。削除も出る", () => {
    renderBoth();
    const ctx = contexts()[0]!;
    const pick = (name: RegExp) => screen.getAllByRole("button", { name })[0]!;
    const kinds: [RegExp, string][] = [
      [new RegExp(`^コンテキスト ${ctx.name}`), "context"],
      [/^情報 /, "information"],
      [/^バリエーション .*\(/, "variation"],
      [/^状態 /, "state"],
    ];
    for (const [name, kind] of kinds) {
      const button = pick(name);
      fireEvent.click(button);
      expect(st().model.elements.find((e) => e.id === selectedId())?.kind).toBe(kind);
      expect(button.getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("button", { name: "削除" })).toBeDefined();
    }
  });

  it("読み上げ名に、見えている文字 (バリエーションの値・情報の関連) を含める", () => {
    render(<InformationBoard />);
    const v = screen.getAllByRole("button", { name: /^バリエーション .*\(/ })[0]!;
    expect(v.textContent).toMatch(/値/);
    expect(v.getAttribute("aria-label")).toMatch(/値/);
  });
});

describe("足す", () => {
  it("＋コンテキスト → ＋情報 → ＋バリエーション / ＋状態。足した直後に選んで名前の入力へ移る", () => {
    renderBoth();
    const nonce = st().ui.nameFocusNonce;
    fireEvent.click(screen.getByRole("button", { name: "コンテキストを足す" }));
    const ctx = st().model.elements.find((e) => e.kind === "context" && e.name === "新しいコンテキスト")!;
    expect(selectedId()).toBe(ctx.id);
    expect(st().ui.nameFocusNonce).toBe(nonce + 1);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
    fireEvent.click(screen.getByRole("button", { name: "「新しいコンテキスト」に情報を足す" }));
    const info = st().model.elements.find((e) => e.kind === "information" && e.name === "新しい情報")!;
    expect((info as { contextId: string | null }).contextId).toBe(ctx.id);
    fireEvent.click(screen.getByRole("button", { name: "「新しい情報」にバリエーションを足す" }));
    const variation = st().model.elements.find((e) => e.kind === "variation" && e.name === "新しいバリエーション")!;
    expect(st().model.relations.some((r) => r.kind === "informationVariation" && r.sourceId === info.id && r.targetId === variation.id)).toBe(true);
    expect((variation as { contextId: string | null }).contextId).toBe(ctx.id);
    fireEvent.click(screen.getByRole("button", { name: "「新しいコンテキスト」に状態を足す" }));
    const state = st().model.elements.find((e) => e.kind === "state" && e.name === "新しい状態")!;
    expect((state as { contextId: string | null }).contextId).toBe(ctx.id);
    expect(selectedId()).toBe(state.id);
    const past = st().history.past.length;
    act(() => st().undo());
    expect(st().history.past.length).toBe(past - 1);
  });

  it("状態グループの「＋状態」は、その状態グループの状態として足す", () => {
    renderBoth();
    const g = st().model.elements.find((e): e is Extract<typeof e, { kind: "state" }> => e.kind === "state" && !!e.group)!;
    fireEvent.click(screen.getAllByRole("button", { name: `状態グループ「${g.group}」に状態を足す` })[0]!);
    const added = st().model.elements.find((e) => e.kind === "state" && e.name === "新しい状態") as { group?: string; contextId: string | null };
    expect(added.group).toBe(g.group);
    expect(added.contextId).toBe(g.contextId);
  });

  it("閲覧専用では、足す操作を出さない。選ぶことはできる", () => {
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<InformationBoard />);
    expect(screen.queryByRole("button", { name: /を足す/ })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^情報 / })[0]!);
    expect(st().model.elements.find((e) => e.id === selectedId())?.kind).toBe("information");
  });
});

describe("削除の確認と「移動」", () => {
  it("コンテキストを消すときは、属していた要素が残ること (決まっていない要素になること) を書く", () => {
    renderBoth();
    const ctx = st().model.elements.find((e) => e.kind === "context" && st().model.elements.some((x) => x.kind === "state" && x.contextId === e.id))!;
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^コンテキスト ${ctx.name}`) })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/^状態 \d+ 件: 削除されず残ります \(コンテキストが決まっていない要素になります\)/)).toBeDefined();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === ctx.id)).toBe(false);
    // 要素は残り、「コンテキストが決まっていない」枠に出る
    expect(screen.getByRole("region", { name: "コンテキストが決まっていない" })).toBeDefined();
  });

  it("状態を消すときは、結んだ操作の前提の状態・次の状態が外れることを書く。バリエーションは種別の情報が外れることを書く", () => {
    renderBoth();
    const st1 = st().model.elements.find((e) => e.kind === "state" && st().model.relations.some((r) => (r.kind === "usecaseState" || r.kind === "stateUsecase") && (r.sourceId === e.id || r.targetId === e.id)))!;
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^状態 ${st1.name}`) })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/^操作 \d+ 件: 削除されず残ります \(「前提の状態」「次の状態」の結び付きが外れます\)/)).toBeDefined();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "キャンセル" }));
    const v = st().model.elements.find((e) => e.kind === "variation" && st().model.relations.some((r) => r.kind === "informationVariation" && r.targetId === e.id))!;
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^バリエーション ${v.name}`) })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/^情報 \d+ 件: 削除されず残ります \(「種別」の結び付きが外れます\)/)).toBeDefined();
  });

  it("トレース表では、コンテキスト・情報・状態・バリエーション・条件の行の「移動」も出さない", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^情報 / })[0]!);
    for (const layer of ["コンテキスト", "情報", "状態", "バリエーション", "条件"]) expect(screen.queryByRole("button", { name: `固定ボード「${layer}」へ移る` })).toBeNull();
  });
});

describe("App での表示", () => {
  it("情報と状態のボードを開くと、ボードが出て、ツールバーの選択もそれになる", () => {
    render(<App />);
    expect(screen.getByTestId("information-board")).toBeDefined();
    expect((screen.getByLabelText("ボード", { selector: "select" }) as HTMLSelectElement).value).toBe("simple:information");
  });
});
