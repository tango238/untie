import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement } from "@untie/core/model/commands";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { PropertyPanel } from "../PropertyPanel";
import { OperationBoard } from "../workflow/OperationBoard";
import { canvasApi } from "../canvas/canvasApi";
import App from "../../App";

const st = () => useUntieStore.getState();
const selectedId = () => {
  const sel = st().ui.selection;
  return sel?.type === "element" ? sel.id : null;
};

beforeEach(() => {
  resetStore();
  useUntieStore.setState({ cloud: null });
  act(() => st().setCurrentBoard("simple:operation"));
});

const renderBoth = () =>
  render(
    <>
      <OperationBoard />
      <PropertyPanel />
    </>,
  );
const frame = (name: RegExp | string) => screen.getByRole("region", { name });
const dialog = () => screen.queryByRole("dialog", { name: "削除の確認" });

describe("システム操作ボードの描画", () => {
  it("外側の枠 (活動・業務) の中に、作業の行、操作の枠、画面の縦の一覧が入る", () => {
    render(<OperationBoard />);
    // 業務に直接の作業は業務の枠、活動のある業務は活動の枠 (どの業務の活動かを添える)
    const reservation = frame("業務 予約受付");
    const row = within(reservation).getByRole("group", { name: /^作業 予約内容を確認する の行/ });
    const confirm = within(row).getByRole("region", { name: "操作 予約を確定する" });
    expect(within(within(confirm).getByRole("list", { name: "画面の一覧" })).getByRole("button", { name: /^画面 予約の確定画面/ })).toBeDefined();
    expect(within(confirm).getByText("システム: 宿泊管理システム")).toBeDefined();
    const buc = frame("活動 客室対応");
    expect(within(buc).getByText(/業務: 滞在中の対応/)).toBeDefined();
    expect(screen.queryByRole("region", { name: "業務 滞在中の対応" })).toBeNull();
    // 活動の枠は作業が無くても出る。作業の行には「操作はまだありません」
    expect(within(buc).getByText("操作はまだありません")).toBeDefined();
  });

  it("対象のシステム・帳票は種別付きのチップで、きっかけのイベントも添える。どれも選べる", () => {
    render(<OperationBoard />);
    const reg = frame("操作 予約を登録する");
    fireEvent.click(within(reg).getByRole("button", { name: "システム 予約サイト" }));
    expect(selectedId()).toBe("sys_booking_site");
    fireEvent.click(within(frame("操作 請求書を発行する")).getByRole("button", { name: /^きっかけのイベント 請求金額が計算された/ }));
    expect(selectedId()).toBe("ev_charge_calculated");
    expect(within(frame("操作 請求書を発行する")).getByText("きっかけ")).toBeDefined();
  });

  it("1 つの操作が複数の作業に結ばれていれば、それぞれの行に出る。作業に結ばれていない操作は別の区画に出る", () => {
    render(<OperationBoard />);
    expect(screen.getAllByRole("region", { name: "操作 予約を検索する" })).toHaveLength(2);
    const unlinked = frame("作業に結ばれていない操作");
    expect(within(unlinked).getByRole("button", { name: /^操作 請求金額を計算する/ })).toBeDefined();
    act(() => void st().dispatch((m) => addElement(m, { kind: "screen", name: "宙の画面", id: "scr_float", init: { systemId: "sys_pms" } })));
    expect(within(frame("操作に結ばれていない画面")).getByRole("button", { name: /^画面 宙の画面/ })).toBeDefined();
  });

  it("用語はユーザー向けの言葉 (BUC・ユースケースなどを出さない)", () => {
    render(<OperationBoard />);
    expect(document.body.textContent).not.toMatch(/BUC|ユースケース|集約|ドメイン/);
  });

  it("canvasApi.focus は登録され、片付けで外れる", () => {
    const { unmount } = render(<OperationBoard />);
    expect(canvasApi.focus).toBeDefined();
    unmount();
    expect(canvasApi.focus).toBeUndefined();
  });
});

describe("選択", () => {
  it("作業のカード・操作の枠・画面の行・枠の見出しを押すと選択してプロパティに出し、aria-current が付く。操作や画面は直せる種類として削除も出る", () => {
    renderBoth();
    for (const [name, id] of [
      ["作業 予約内容を確認する", "act_confirm_reservation"],
      ["操作 予約を確定する", "uc_confirm_reservation"],
      ["画面 予約の確定画面", "scr_reservation_confirm"],
      ["業務 予約受付", "biz_reservation"],
    ] as const) {
      const button = screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]!;
      fireEvent.click(button);
      expect(selectedId()).toBe(id);
      expect(button.getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("button", { name: "削除" })).toBeDefined();
    }
  });

  it("システムなど、このボードで直せない種類を選んだときは、詳細で直すよう案内して削除を出さない", () => {
    renderBoth();
    fireEvent.click(within(frame("操作 予約を登録する")).getByRole("button", { name: "システム 予約サイト" }));
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(screen.getByText(/分析（詳細）で直せます/)).toBeDefined();
  });
});

describe("足す", () => {
  it("＋作業 (外側の枠) → ＋操作 (作業) → ＋画面 (操作)。足した直後に選んで名前の入力へ移る", () => {
    renderBoth();
    const nonce = st().ui.nameFocusNonce;
    fireEvent.click(screen.getByRole("button", { name: "「予約受付」に作業を足す" }));
    const act1 = st().model.elements.find((e) => e.kind === "activity" && e.name === "新しい作業")!;
    expect(selectedId()).toBe(act1.id);
    expect(st().ui.nameFocusNonce).toBe(nonce + 1);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
    fireEvent.click(screen.getByRole("button", { name: "「新しい作業」に操作を足す" }));
    const uc = st().model.elements.find((e) => e.kind === "usecase" && e.name === "新しい操作")!;
    expect(st().model.relations.some((r) => r.kind === "activityUsecase" && r.sourceId === act1.id && r.targetId === uc.id)).toBe(true);
    expect(selectedId()).toBe(uc.id);
    // システムが複数あるので、足すシステムを選ぶ
    fireEvent.change(screen.getByRole("combobox", { name: "「新しい操作」に画面を足す" }), { target: { value: "sys_pms" } });
    const scr = st().model.elements.find((e) => e.kind === "screen" && e.name === "新しい画面")!;
    expect(scr.kind === "screen" && scr.systemId).toBe("sys_pms");
    expect(st().model.relations.some((r) => r.kind === "usecaseScreen" && r.sourceId === uc.id && r.targetId === scr.id)).toBe(true);
    expect(selectedId()).toBe(scr.id);
    // 画面 (対象) の付いた操作には、もう「＋画面」を出さない
    expect(screen.queryByRole("combobox", { name: "「新しい操作」に画面を足す" })).toBeNull();
    // 1 件ずつ undo で戻せる
    const past = st().history.past.length;
    act(() => st().undo());
    expect(st().history.past.length).toBe(past - 1);
  });

  it("対象のシステム・帳票のある操作には「＋画面」を出さない。システムが 1 つなら押すだけ", () => {
    render(<OperationBoard />);
    expect(within(frame("操作 予約を登録する")).queryByRole("combobox")).toBeNull();
    expect(within(frame("操作 予約を登録する")).queryByRole("button", { name: /に画面を足す/ })).toBeNull();
  });

  it("システムが無いときは、画面を足せない旨を出す。システムが 1 つだけなら「＋画面」のボタン", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "usecase", name: "葉の操作", id: "uc_leaf" })));
    for (const id of ["sys_accounting", "sys_booking_site", "sys_payment"]) act(() => void st().dispatch((m) => removeElement(m, { id })));
    const { unmount } = render(<OperationBoard />);
    // 残ったシステム (宿泊管理システム) だけ: ボタン
    fireEvent.click(within(frame("作業に結ばれていない操作")).getByRole("button", { name: "「葉の操作」に画面を足す" }));
    expect(st().model.elements.some((e) => e.kind === "screen" && e.name === "新しい画面")).toBe(true);
    unmount();
    act(() => void st().dispatch((m) => removeElement(m, { id: "sys_pms" })));
    render(<OperationBoard />);
    expect(screen.getByText(/先に分析（詳細）の「登場人物」でシステムを作ってください/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /に画面を足す/ })).toBeNull();
  });

  it("閲覧専用では、足す操作を出さない。選ぶことはできる", () => {
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    render(<OperationBoard />);
    expect(screen.queryByRole("button", { name: /を足す/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 予約を確定する/ })[0]!);
    expect(selectedId()).toBe("uc_confirm_reservation");
  });
});

describe("削除の確認と「移動」", () => {
  it("操作に子 (画面・イベント) があれば、残ることを書いて確認する。子の無い操作はそのまま消える", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 請求書を発行する/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const d = within(dialog()!);
    expect(d.getByText("画面 1 件: 削除されず残ります (操作との結び付きが外れます)")).toBeDefined();
    expect(d.getByText("イベント 1 件: 削除されず残ります (操作との結び付きが外れます)")).toBeDefined();
    fireEvent.click(d.getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === "uc_issue_invoice")).toBe(false);
    expect(st().model.elements.some((e) => e.id === "scr_invoice")).toBe(true);
    // 子の無い操作
    act(() => void st().dispatch((m) => addElement(m, { kind: "usecase", name: "葉の操作", id: "uc_leaf" })));
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 葉の操作/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(dialog()).toBeNull();
    expect(st().model.elements.some((e) => e.id === "uc_leaf")).toBe(false);
  });

  it("画面を消すときは、使っていた操作が残ることを書く", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^画面 請求書の発行画面/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/操作 1 件: 削除されず残ります \(対象の画面が外れます\)/)).toBeDefined();
  });

  it("作業と操作の結び付きを外すとき、操作に子があれば確認を出す", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 請求書を発行する/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /^関係「使う 請求を作成する」を削除$/ }));
    const d = within(screen.getByRole("dialog", { name: "結び付きを外す確認" }));
    expect(d.getByText(/画面 1 件: 削除されず残ります \(操作ごと残り、「作業に結ばれていない操作」に移ります\)/)).toBeDefined();
  });

  it("トレース表では、操作・画面の行の「移動」も出さない", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 予約を確定する/ })[0]!);
    for (const layer of ["操作", "画面", "作業"]) expect(screen.queryByRole("button", { name: `固定ボード「${layer}」へ移る` })).toBeNull();
  });
});

describe("App での表示", () => {
  it("簡易モードのシステム操作のボードを開くと、ボードが出てツールバーのボードの選択もそれになる", () => {
    render(<App />);
    expect(screen.getByTestId("operation-board")).toBeDefined();
    expect((screen.getByLabelText("ボード") as HTMLSelectElement).value).toBe("simple:operation");
    fireEvent.change(screen.getByLabelText("ボード"), { target: { value: "simple:workflow" } });
    expect(screen.getByTestId("workflow-board")).toBeDefined();
  });
});

describe("イベントの削除の確認", () => {
  it("システム操作ボードのイベントのチップを選んで削除すると、結ばれた操作が外れることを確認する", () => {
    renderBoth();
    fireEvent.click(within(frame("操作 請求書を発行する")).getByRole("button", { name: /^きっかけのイベント 請求金額が計算された/ }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/操作 \d+ 件: 削除されず残ります \(きっかけ・発生の結び付きが外れます\)/)).toBeDefined();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "削除する" }));
    expect(st().model.elements.some((e) => e.id === "ev_charge_calculated")).toBe(false);
    expect(st().model.elements.some((e) => e.id === "uc_issue_invoice")).toBe(true);
  });

  it("操作を消すと見えなくなる詳細の結び付き (扱う情報・判断する条件・状態) も、確認で数える", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^操作 予約を登録する/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const d = within(dialog()!);
    expect(d.getByText(/^扱う情報 \d+ 件: 削除されず残ります/)).toBeDefined();
    expect(d.getByText(/^判断する条件 \d+ 件: 削除されず残ります/)).toBeDefined();
    expect(d.getByText(/^前提・次の状態 \d+ 件: 削除されず残ります/)).toBeDefined();
  });
});

describe("不正なモデルと失敗の扱い", () => {
  it("対象が複数ある不正な操作 (画面とシステムの両方) は、画面とチップの両方を出す。「＋画面」は出さない", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, relations: [...s.model.relations, { id: "rel_bad", kind: "usecaseSystem", sourceId: "uc_confirm_reservation", targetId: "sys_pms" } as never] } }));
    });
    render(<OperationBoard />);
    const box = screen.getAllByRole("region", { name: "操作 予約を確定する" })[0]!;
    expect(within(box).getByRole("button", { name: /^画面 予約の確定画面/ })).toBeDefined();
    expect(within(box).getByRole("button", { name: "システム 宿泊管理システム" })).toBeDefined();
    expect(within(box).queryByRole("combobox")).toBeNull();
  });

  it("既定の活動が無い業務で「＋作業」を押すと、トーストで理由を出し、モデルは変わらない", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "business", name: "壊れた業務", id: "biz_broken" })));
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.filter((e) => !(e.kind === "buc" && e.businessId === "biz_broken")) } }));
    });
    render(<OperationBoard />);
    const before = st().model;
    fireEvent.click(screen.getByRole("button", { name: "「壊れた業務」に作業を足す" }));
    expect(st().model).toBe(before);
    expect(st().toasts.some((t) => t.tone === "error" && t.message.includes("既定の活動"))).toBe(true);
  });
});

describe("情報", () => {
  it("操作の枠に、扱う情報が縦の一覧で出て、取得・保存の区別を添える。選べる", () => {
    render(<OperationBoard />);
    const reg = screen.getAllByRole("region", { name: "操作 予約を登録する" })[0]!;
    const list = within(reg).getByRole("list", { name: "情報の一覧" });
    const rows = within(list).getAllByRole("button");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toMatch(/取得・保存|取得|保存/);
    fireEvent.click(rows[0]!);
    expect(st().model.elements.find((e) => e.id === selectedId())?.kind).toBe("information");
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  });

  it("＋情報で、その操作が扱う情報を足して選び、名前の入力へ移る。閲覧専用では出さない", () => {
    renderBoth();
    const nonce = st().ui.nameFocusNonce;
    fireEvent.click(screen.getAllByRole("button", { name: "「予約を確定する」に情報を足す" })[0]!);
    const info = st().model.elements.find((e) => e.kind === "information" && e.name === "新しい情報")!;
    expect(st().model.relations.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_confirm_reservation" && r.targetId === info.id)).toBe(true);
    expect(selectedId()).toBe(info.id);
    expect(st().ui.nameFocusNonce).toBe(nonce + 1);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    renderBoth();
    expect(screen.queryByRole("button", { name: /に情報を足す/ })).toBeNull();
  });

  it("どの操作にも扱われていない情報は「操作に結ばれていない情報」に出る", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "information", name: "宙の情報", id: "info_float" })));
    render(<OperationBoard />);
    expect(within(frame("操作に結ばれていない情報")).getByRole("button", { name: "情報 宙の情報" })).toBeDefined();
  });

  it("情報を消すときは、扱っていた操作が残ることと、見えない結び付きを確認で書く。設計データは別の見出しで出す。「移動」は出さない", () => {
    renderBoth();
    const reg = screen.getAllByRole("region", { name: "操作 予約を登録する" })[0]!;
    fireEvent.click(within(within(reg).getByRole("list", { name: "情報の一覧" })).getAllByRole("button")[0]!);
    for (const layer of ["情報", "操作"]) expect(screen.queryByRole("button", { name: `固定ボード「${layer}」へ移る` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/^操作 \d+ 件: 削除されず残ります \(扱う情報としての結び付きが外れます\)/)).toBeDefined();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "キャンセル" }));
    // 操作と情報の結び付きを外すのは確認なし
    fireEvent.click(screen.getAllByRole("button", { name: /^関係「扱う .*」を削除$/ })[0]!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("結び付きに付いた代替パターン", () => {
  it("操作と条件の結び付きを外すとき、代替パターンがあれば一緒に消えると確認する。キャンセルすれば残る", () => {
    const alt = st().model.relations.find((r) => r.kind === "usecaseCondition" && r.alternate !== undefined)!;
    const usecase = st().model.elements.find((e) => e.id === alt.sourceId)!;
    const condition = st().model.elements.find((e) => e.id === alt.targetId)!;
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^操作 ${usecase.name}`) })[0]!);
    const x = screen.getAllByRole("button", { name: `関係「判断 ${condition.name}」を削除` })[0]!;
    fireEvent.click(x);
    const d = within(screen.getByRole("dialog", { name: "結び付きを外す確認" }));
    expect(d.getByText("代替パターン 1 件: 一緒に削除されます")).toBeDefined();
    fireEvent.click(d.getByRole("button", { name: "キャンセル" }));
    expect(st().model.relations.some((r) => r.id === alt.id)).toBe(true);
    fireEvent.click(x);
    fireEvent.click(within(screen.getByRole("dialog", { name: "結び付きを外す確認" })).getByRole("button", { name: "外す" }));
    expect(st().model.relations.some((r) => r.id === alt.id)).toBe(false);
  });

  it("画面を消すとき、課題の対象になっていれば、課題が残って対象から外れることを確認で書く", () => {
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.map((e) => (e.kind === "issue" && e.id === "issue_extra_missing" ? { ...e, targetIds: ["scr_invoice"] } : e)) } }));
    });
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: /^画面 請求書の発行画面/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText("課題 1 件: 削除されず残ります (対象から外れます)")).toBeDefined();
  });
});

describe("条件", () => {
  const withAlt = () => st().model.relations.find((r) => r.kind === "usecaseCondition" && r.alternate !== undefined)!;

  it("操作の枠に、判断する条件が縦の一覧で出て、代替パターンのあるものには添え書きが付く。選べる", () => {
    const alt = withAlt();
    const usecase = st().model.elements.find((e) => e.id === alt.sourceId)!;
    const condition = st().model.elements.find((e) => e.id === alt.targetId)!;
    render(<OperationBoard />);
    const box = screen.getAllByRole("region", { name: new RegExp(`^操作 ${usecase.name}`) })[0]!;
    const row = within(within(box).getByRole("list", { name: "条件の一覧" })).getByRole("button", { name: new RegExp(`^条件 ${condition.name}`) });
    // 代替パターンは「いつ」だけでなく、どうなるかの全文とそのあとの状態まで出す (「代替パターンあり」という前置きは出さない)
    expect(row.textContent).toContain("満たすとき: 予約を受けず、別の日か別の部屋タイプを案内する。(状態は変わらない)");
    expect(row.textContent).not.toContain("代替パターンあり");
    expect(row.getAttribute("aria-label")).toContain("満たすとき: 予約を受けず、別の日か別の部屋タイプを案内する。(状態は変わらない)");
    fireEvent.click(row);
    expect(selectedId()).toBe(condition.id);
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("＋条件で、その操作が判断する条件を足して選び、名前の入力へ移る。閲覧専用では出さない", () => {
    renderBoth();
    fireEvent.click(screen.getAllByRole("button", { name: "「予約を確定する」に条件を足す" })[0]!);
    const c = st().model.elements.find((e) => e.kind === "condition" && e.name === "新しい条件")!;
    expect(st().model.relations.some((r) => r.kind === "usecaseCondition" && r.sourceId === "uc_confirm_reservation" && r.targetId === c.id)).toBe(true);
    expect(selectedId()).toBe(c.id);
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
    useUntieStore.setState({ cloud: { role: "viewer" } as never });
    renderBoth();
    expect(screen.queryByRole("button", { name: /に条件を足す/ })).toBeNull();
  });

  it("どの操作にも結ばれていない条件は「操作に結ばれていない条件」に出る。条件を消すと、代替パターンが一緒に消えると確認する。「移動」は出さない", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "condition", name: "宙の条件", id: "cond_float" })));
    renderBoth();
    expect(within(frame("操作に結ばれていない条件")).getByRole("button", { name: /^条件 宙の条件/ })).toBeDefined();
    const alt = withAlt();
    const condition = st().model.elements.find((e) => e.id === alt.targetId)!;
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^条件 ${condition.name}`) })[0]!);
    expect(screen.queryByRole("button", { name: "固定ボード「条件」へ移る" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(dialog()!).getByText(/^代替パターン \d+ 件: 一緒に削除されます/)).toBeDefined();
    expect(within(dialog()!).getByText(/^操作 \d+ 件: 削除されず残ります \(判断の結び付きが外れます\)/)).toBeDefined();
  });
});

describe("条件に添える区分と状態", () => {
  const conditionRow = (name: string) => screen.getAllByRole("button", { name: new RegExp(`^条件 ${name}`) })[0]!;

  it("条件の名前の下に「区分: …」「状態: …」(状態グループがあれば括弧で添える)、そのあとに代替パターンを、区分 → 状態 → 代替パターンの順で出す。読み上げ名にも含める", () => {
    render(<OperationBoard />);
    const row = conditionRow("満室である");
    const notes = [...row.querySelectorAll(".wf-assignees")].map((n) => n.textContent);
    const state = st().model.elements.find((e) => e.id === "st_room_inuse") as { name: string; group?: string };
    expect(notes[0]).toBe("区分: 部屋タイプ");
    expect(notes[1]).toBe(`状態: ${state.name}${state.group ? ` (${state.group})` : ""}`);
    expect(notes[2]).toBe("満たすとき: 予約を受けず、別の日か別の部屋タイプを案内する。(状態は変わらない)");
    for (const n of notes) expect(row.getAttribute("aria-label")).toContain(n!);
    // 添え書きどうしは「。」で区切る (区分・状態の中の並びの「、」と紛れない)
    expect(row.getAttribute("aria-label")).toBe(`条件 満室である (${notes.join("。")})`);
    // 見えているものは文字だけ (区分・状態そのものを選ぶチップにはしない)
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    // 前方一致のセレクタは壊れない
    fireEvent.click(row);
    expect(selectedId()).toBe("cond_full");
  });

  it("状態グループ名の前後の空白は除いて出す。空白だけならグループ無しとして名前だけを出す", () => {
    const setGroup = (group: string) =>
      act(() => {
        useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.map((e) => (e.id === "st_room_inuse" ? { ...e, group } : e)) as typeof s.model.elements } }));
      });
    setGroup("  部屋の状態 ");
    const { unmount } = render(<OperationBoard />);
    expect([...conditionRow("満室である").querySelectorAll(".wf-assignees")].map((n) => n.textContent)).toContain("状態: 使用中 (部屋の状態)");
    unmount();
    setGroup("   ");
    render(<OperationBoard />);
    expect([...conditionRow("満室である").querySelectorAll(".wf-assignees")].map((n) => n.textContent)).toContain("状態: 使用中");
  });

  it("区分も状態も無い条件には、添え書きの行を出さない", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "condition", name: "素の条件", id: "cond_plain" })));
    render(<OperationBoard />);
    const row = within(frame("操作に結ばれていない条件")).getByRole("button", { name: /^条件 素の条件/ });
    expect(row.querySelectorAll(".wf-assignees")).toHaveLength(0);
    expect(row.getAttribute("aria-label")).toBe("条件 素の条件");
  });

  it("操作に結ばれていない条件の区画にも、区分・状態を出す (代替パターンは操作との結び付きに付くので出さない)", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "condition", name: "宙の条件", id: "cond_float" }));
      st().dispatch((m) => addRelation(m, { sourceId: "cond_float", targetId: "var_room_type" }));
    });
    render(<OperationBoard />);
    const row = within(frame("操作に結ばれていない条件")).getByRole("button", { name: /^条件 宙の条件/ });
    expect([...row.querySelectorAll(".wf-assignees")].map((n) => n.textContent)).toEqual(["区分: 部屋タイプ"]);
    expect(row.getAttribute("aria-label")).toBe("条件 宙の条件 (区分: 部屋タイプ)");
  });
});

describe("操作の枠の前提の状態・次の状態", () => {
  const notesOf = (box: HTMLElement) => [...box.querySelectorAll(".wf-op-note")].map((n) => n.textContent);
  const titleButton = (box: HTMLElement) => within(box).getAllByRole("button")[0]!;

  it("見出しのすぐ下に「前提の状態: …」「次の状態: …」を、この順に文字だけで出す。状態グループは括弧で添える。読み上げ名にも含める", () => {
    render(<OperationBoard />);
    const box = screen.getAllByRole("region", { name: "操作 予約を確定する" })[0]!;
    const notes = notesOf(box);
    const stateName = (id: string) => {
      const e = st().model.elements.find((x) => x.id === id) as { name: string; group?: string };
      return e.group?.trim() ? `${e.name} (${e.group.trim()})` : e.name;
    };
    const premise = st().model.relations.filter((r) => r.kind === "stateUsecase" && r.targetId === "uc_confirm_reservation").map((r) => stateName(r.sourceId));
    const next = st().model.relations.filter((r) => r.kind === "usecaseState" && r.sourceId === "uc_confirm_reservation").map((r) => stateName(r.targetId));
    expect(notes).toEqual([`前提の状態: ${premise.join("、")}`, `次の状態: ${next.join("、")}`]);
    expect(notes[0]).toContain("仮予約 (予約の状態)");
    // 見出しのすぐ下 (見出し → 添え書き → 画面など)
    const header = box.querySelector("header")!;
    expect(header.nextElementSibling?.classList.contains("wf-op-notes")).toBe(true);
    expect(titleButton(box).getAttribute("aria-label")).toBe(`操作 予約を確定する (${notes.join("。")})`);
    // 状態を選ぶチップにはしない
    expect(box.querySelectorAll(".wf-op-note button")).toHaveLength(0);
    // 前方一致のセレクタで選べる
    fireEvent.click(titleButton(box));
    expect(selectedId()).toBe("uc_confirm_reservation");
  });

  it("状態の無い操作には添え書きを出さず、読み上げ名は名前だけ。同じ操作が複数の作業の行に出るときは、それぞれに出る", () => {
    act(() => void st().dispatch((m) => addElement(m, { kind: "usecase", name: "葉の操作", id: "uc_leaf" })));
    render(<OperationBoard />);
    const leaf = within(frame("作業に結ばれていない操作")).getByRole("region", { name: "操作 葉の操作" });
    expect(notesOf(leaf)).toEqual([]);
    expect(titleButton(leaf).getAttribute("aria-label")).toBe("操作 葉の操作");
    const searches = screen.getAllByRole("region", { name: "操作 予約を検索する" });
    expect(searches).toHaveLength(2);
    expect(notesOf(searches[0]!)).toEqual(notesOf(searches[1]!));
  });

  it("「作業に結ばれていない操作」の区画にも、前提の状態・次の状態を出す。状態グループ名の空白は除き、空なら括弧なし", () => {
    act(() => {
      st().dispatch((m) => addElement(m, { kind: "usecase", name: "宙の操作", id: "uc_float" }));
      st().dispatch((m) => addRelation(m, { sourceId: "st_res_confirmed", targetId: "uc_float" }));
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.map((e) => (e.id === "st_res_confirmed" ? { ...e, group: "  予約の状態 " } : e)) as typeof s.model.elements } }));
    });
    render(<OperationBoard />);
    const box = within(frame("作業に結ばれていない操作")).getByRole("region", { name: "操作 宙の操作" });
    expect(notesOf(box)).toEqual(["前提の状態: 確定 (予約の状態)"]);
    act(() => {
      useUntieStore.setState((s) => ({ model: { ...s.model, elements: s.model.elements.map((e) => (e.id === "st_res_confirmed" ? { ...e, group: "   " } : e)) as typeof s.model.elements } }));
    });
    expect(notesOf(within(frame("作業に結ばれていない操作")).getByRole("region", { name: "操作 宙の操作" }))).toEqual(["前提の状態: 確定"]);
  });
});
