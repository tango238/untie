import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { addElement, moveToContext } from "../../model/commands";
import { PropertyPanel } from "../PropertyPanel";

const st = () => useUntieStore.getState();
const el = (id: string) => st().model.elements.find((e) => e.id === id)!;
const selectEl = (id: string) => act(() => st().select({ type: "element", id }));
/** 所属・関係・削除は固定ボードで編集する */
const onFixedBoard = () => act(() => st().setCurrentBoard("fixed:activity"));

beforeEach(() => resetStore());
afterEach(() => vi.useRealTimers());

describe("PropertyPanel", () => {
  it("選択がないときは案内を出す", () => {
    render(<PropertyPanel />);
    expect(screen.getByText(/選ぶと/)).toBeDefined();
  });

  it("名前は入力中は履歴に積まず、フォーカスアウトで 1 件として確定する", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "フロ" } });
    fireEvent.change(input, { target: { value: "フロント責任者" } });
    expect(el("actor_front").name).toBe("フロント担当");
    expect(st().history.past).toHaveLength(0);
    fireEvent.blur(input);
    expect(el("actor_front").name).toBe("フロント責任者");
    expect(st().history.past).toHaveLength(1);
    fireEvent.blur(input); // 変更なしなら増えない
    expect(st().history.past).toHaveLength(1);
  });

  it("500ms 入力が止まると 1 件として確定する", () => {
    vi.useFakeTimers();
    selectEl("actor_front");
    render(<PropertyPanel />);
    const input = screen.getByLabelText("名前");
    fireEvent.change(input, { target: { value: "A" } });
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.change(input, { target: { value: "AB" } });
    act(() => void vi.advanceTimersByTime(300));
    expect(el("actor_front").name).toBe("フロント担当");
    act(() => void vi.advanceTimersByTime(300));
    expect(el("actor_front").name).toBe("AB");
    expect(st().history.past).toHaveLength(1);
  });

  it("別の要素を選ぶ前に入力中の内容を確定する", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("説明"), { target: { value: "受付の担当" } });
    selectEl("actor_manager");
    expect(el("actor_front").description).toBe("受付の担当");
    expect(el("actor_manager").description).toBeUndefined();
  });

  it("作業の業務と活動を変えられる (未所属を含む)", () => {
    onFixedBoard();
    selectEl("act_room_request");
    render(<PropertyPanel />);
    const biz = screen.getByLabelText("業務") as HTMLSelectElement;
    const buc = screen.getByLabelText("活動") as HTMLSelectElement;
    expect(biz.value).toBe("biz_stay");
    expect(buc.value).toBe("buc_room_care");
    fireEvent.change(buc, { target: { value: "buc_dining" } });
    expect(el("act_room_request")).toMatchObject({ bucId: "buc_dining" });
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "biz_checkin" } });
    expect(el("act_room_request")).toMatchObject({ bucId: "buc_default_checkin" });
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "" } });
    expect(el("act_room_request")).toMatchObject({ bucId: null });
    expect((screen.getByLabelText("活動") as HTMLSelectElement).disabled).toBe(true);
  });

  it("活動の業務を変えられる", () => {
    onFixedBoard();
    selectEl("buc_dining");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("業務"), { target: { value: "biz_checkout" } });
    expect(el("buc_dining")).toMatchObject({ businessId: "biz_checkout" });
  });

  it("バリエーションの値を追加・並べ替え・削除できる", () => {
    onFixedBoard();
    selectEl("var_room_type");
    render(<PropertyPanel />);
    const values = () => (el("var_room_type") as { values: string[] }).values;
    expect(values()).toEqual(["シングル", "ツイン", "スイート"]);
    fireEvent.change(screen.getByLabelText("追加する値"), { target: { value: "和室" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(values()).toEqual(["シングル", "ツイン", "スイート", "和室"]);
    fireEvent.click(screen.getByRole("button", { name: "値「和室」を上へ" }));
    expect(values()).toEqual(["シングル", "ツイン", "和室", "スイート"]);
    fireEvent.click(screen.getByRole("button", { name: "値「ツイン」を削除" }));
    expect(values()).toEqual(["シングル", "和室", "スイート"]);
  });

  it("情報のコンテキスト・状態のグループを編集できる", () => {
    onFixedBoard();
    selectEl("info_reservation");
    const { unmount } = render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("コンテキスト"), { target: { value: "ctx_customer" } });
    expect(el("info_reservation")).toMatchObject({ contextId: "ctx_customer" });
    fireEvent.change(screen.getByLabelText("コンテキスト"), { target: { value: "" } });
    expect(el("info_reservation")).toMatchObject({ contextId: null });
    unmount();
    selectEl("st_res_tentative");
    render(<PropertyPanel />);
    expect(screen.getByLabelText("状態グループ")).toBeDefined();
  });

  it("帳票は情報と取得元・保存先で結べ、担当の候補には出ない。システムは作業の担当に結べる", () => {
    onFixedBoard();
    selectEl("ldg_guest_register");
    const { unmount } = render(<PropertyPanel />);
    expect(screen.getByText("帳票", { selector: ".kind-line" })).toBeDefined();
    const options = () => [...(screen.getByLabelText("関係を追加") as HTMLSelectElement).querySelectorAll("optgroup")].map((g) => g.label);
    expect(options().some((l) => l.includes("担当"))).toBe(false);
    fireEvent.change(screen.getByLabelText("関係を追加"), { target: { value: "ldg_guest_register>info_room" } });
    fireEvent.change(screen.getByLabelText("関係を追加"), { target: { value: "info_reservation>ldg_guest_register" } });
    const kinds = st()
      .model.relations.filter((r) => r.sourceId === "ldg_guest_register" || r.targetId === "ldg_guest_register")
      .map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["systemInformation", "informationSystem"]));
    unmount();
    selectEl("sys_accounting");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("関係を追加"), { target: { value: "sys_accounting>act_settle" } });
    expect(st().model.relations.some((r) => r.kind === "actorActivity" && r.sourceId === "sys_accounting" && r.targetId === "act_settle")).toBe(true);
  });

  it("名前欄の下に書き方を出す (課題は除く)", () => {
    selectEl("act_hand_key");
    const { unmount } = render(<PropertyPanel />);
    expect(screen.getByText(/担当の動きで書きます/)).toBeDefined();
    unmount();
    selectEl("actor_front");
    const r2 = render(<PropertyPanel />);
    expect(screen.getByText(/役割名で書きます/)).toBeDefined();
    r2.unmount();
    selectEl("issue_manual_entry");
    render(<PropertyPanel />);
    expect(screen.queryByText(/で書きます/)).toBeNull();
  });

  it("課題の重要度と対象を編集できる", () => {
    onFixedBoard();
    selectEl("issue_cancel_explain");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("重要度"), { target: { value: "5" } });
    expect(el("issue_cancel_explain")).toMatchObject({ severity: 5 });
    fireEvent.click(screen.getByRole("button", { name: "対象「予約を変更・取消する」を外す" }));
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toEqual(["uc_cancel_reservation"]);
    fireEvent.change(screen.getByLabelText("対象を追加"), { target: { value: "biz_checkin" } });
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toEqual(["uc_cancel_reservation", "biz_checkin"]);
  });

  it("関係一覧: 相手クリックで選択、× で関係を消す", () => {
    onFixedBoard();
    selectEl("act_verify_identity");
    render(<PropertyPanel />);
    const before = st().model.relations.length;
    const rels = within(screen.getByText("関係", { selector: "h3" }).parentElement!);
    fireEvent.click(rels.getByRole("button", { name: "フロント担当" }));
    expect(st().ui.selection).toEqual({ type: "element", id: "actor_front" });
    selectEl("act_verify_identity");
    const del = within(screen.getByText("関係", { selector: "h3" }).parentElement!).getAllByRole("button", { name: /を削除$/ })[0]!;
    fireEvent.click(del);
    expect(st().model.relations.length).toBe(before - 1);
  });

  it("この要素を対象にする課題の一覧と「課題を追加」", () => {
    onFixedBoard();
    selectEl("biz_reservation");
    render(<PropertyPanel />);
    expect(screen.getByRole("button", { name: "予約サイトからの予約を手で転記している" })).toBeDefined();
    const count = st().model.elements.length;
    fireEvent.click(screen.getByRole("button", { name: "課題を追加" }));
    expect(st().model.elements.length).toBe(count + 1);
    const sel = st().ui.selection!;
    const issue = el(sel.id) as { kind: string; targetIds: string[] };
    expect(issue.kind).toBe("issue");
    expect(issue.targetIds).toEqual(["biz_reservation"]);
  });

  it("登場人物にも「課題を追加」があり、全体的な課題として作る。課題・情報などにはない", () => {
    onFixedBoard();
    selectEl("actor_front");
    const { unmount } = render(<PropertyPanel />);
    expect(screen.getByRole("heading", { name: "課題 (全体的な課題)" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "課題を追加" }));
    const issue = el(st().ui.selection!.id) as { kind: string; targetIds: string[] };
    expect(issue).toMatchObject({ kind: "issue", targetIds: ["actor_front"] });
    unmount();
    for (const id of ["issue_manual_entry", "info_reservation"]) {
      selectEl(id);
      const r = render(<PropertyPanel />);
      expect(screen.queryByRole("button", { name: "課題を追加" })).toBeNull();
      r.unmount();
    }
  });

  it("課題の区分を出し、対象の候補は同じ区分だけにする。外せば別の区分に付け替えられる", () => {
    onFixedBoard();
    selectEl("issue_cancel_explain");
    render(<PropertyPanel />);
    expect(screen.getByTestId("issue-scope").textContent).toContain("具体的な課題");
    const options = () => Array.from((screen.getByLabelText("対象を追加") as HTMLSelectElement).querySelectorAll("option")).map((o) => o.value);
    expect(options()).toContain("biz_checkin");
    expect(options()).not.toContain("actor_front");
    // 対象をすべて外すと未整理になり、登場人物も選べる
    fireEvent.click(screen.getByRole("button", { name: "対象「予約を変更・取消する」を外す" }));
    fireEvent.click(screen.getByRole("button", { name: /^対象「.*」を外す$/ }));
    expect(screen.getByTestId("issue-scope").textContent).toContain("未整理の課題");
    expect(options()).toContain("actor_front");
    expect(options()).toContain("biz_checkin");
    // 登場人物に付けると全体的な課題になり、業務・作業・操作は候補から消える
    fireEvent.change(screen.getByLabelText("対象を追加"), { target: { value: "actor_front" } });
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toEqual(["actor_front"]);
    expect(screen.getByTestId("issue-scope").textContent).toContain("全体的な課題");
    expect(options()).toContain("sys_pms");
    expect(options()).not.toContain("biz_checkin");
  });

  it("課題は自由ボードからでも重要度・対象を編集でき、削除できる", () => {
    selectEl("issue_cancel_explain");
    render(<PropertyPanel />);
    fireEvent.change(screen.getByLabelText("重要度"), { target: { value: "4" } });
    expect(el("issue_cancel_explain")).toMatchObject({ severity: 4 });
    fireEvent.change(screen.getByLabelText("対象を追加"), { target: { value: "biz_checkin" } });
    expect((el("issue_cancel_explain") as { targetIds: string[] }).targetIds).toContain("biz_checkin");
    expect(screen.getByRole("button", { name: "削除" })).toBeDefined();
  });

  it("課題の編集フォーム: 左端に「削除」、右端に「課題一覧に戻る」。削除すると課題一覧へ戻る", () => {
    selectEl("issue_cancel_explain");
    act(() => st().setRightPanel("properties"));
    render(<PropertyPanel />);
    const buttons = Array.from(screen.getByRole("button", { name: "削除" }).parentElement!.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["削除", "課題一覧に戻る"]);
    expect(screen.queryByRole("button", { name: "次の課題を登録する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "課題一覧に戻る" }));
    expect(st().ui.rightPanel).toBe("issues");
    act(() => st().setRightPanel("properties"));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(st().model.elements.some((e) => e.id === "issue_cancel_explain")).toBe(false);
    expect(st().ui.rightPanel).toBe("issues");
  });

  it("課題の追加フォーム: 右端は「次の課題を登録する」で、同じ対象の課題を続けて作る。別の要素を選ぶと編集フォームになる", () => {
    onFixedBoard();
    selectEl("actor_front");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "課題を追加" }));
    const first = st().ui.selection!.id;
    expect(screen.queryByRole("button", { name: "課題一覧に戻る" })).toBeNull();
    const buttons = Array.from(screen.getByRole("button", { name: "削除" }).parentElement!.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["削除", "次の課題を登録する"]);
    fireEvent.click(screen.getByRole("button", { name: "次の課題を登録する" }));
    const second = st().ui.selection!.id;
    expect(second).not.toBe(first);
    expect(el(second)).toMatchObject({ kind: "issue", targetIds: ["actor_front"] });
    // 作った課題を選び直すと、もう追加フォームではない
    selectEl("actor_front");
    selectEl(second);
    expect(screen.getByRole("button", { name: "課題一覧に戻る" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "次の課題を登録する" })).toBeNull();
  });

  it("課題以外には「課題一覧に戻る」は出ず、削除しても課題一覧へは移らない", () => {
    onFixedBoard();
    selectEl("act_change_cancel");
    act(() => st().setRightPanel("properties"));
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "課題一覧に戻る" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(st().ui.rightPanel).toBe("properties");
  });

  it("課題の対象から、そのレイヤーの固定ボードへ移れる", () => {
    onFixedBoard();
    selectEl("issue_cancel_explain");
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "「予約を変更・取消する」の固定ボードへ移る" }));
    expect(st().ui.currentBoardId).toBe("fixed:activity");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_change_cancel" });
    selectEl("issue_cancel_explain");
    fireEvent.click(screen.getByRole("button", { name: "「予約を取り消す」の固定ボードへ移る" }));
    expect(st().ui.currentBoardId).toBe("fixed:usecase");
  });

  it("自由ボードでは「ボードから外す」だけ。要素は残る", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ボードから外す" }));
    expect(el("actor_front")).toBeDefined();
    expect(st().model.boards[0]!.nodes.some((n) => n.elementId === "actor_front")).toBe(false);
    expect(screen.queryByRole("button", { name: "ボードから外す" })).toBeNull();
  });

  it("固定ボードでは「削除」で要素ごと消せる。「ボードから外す」は無い", () => {
    onFixedBoard();
    selectEl("actor_front");
    render(<PropertyPanel />);
    expect(screen.queryByRole("button", { name: "ボードから外す" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(false);
    expect(st().ui.selection).toBeNull();
  });

  it("自由ボードでは所属・関係・課題の追加を変えられない", () => {
    selectEl("act_verify_identity");
    render(<PropertyPanel />);
    // fieldset の disabled で無効になる (要素自身の disabled 属性ではない)
    expect(screen.getByLabelText("業務").matches(":disabled")).toBe(true);
    expect(screen.queryByLabelText("関係を追加")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /を削除$/ })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "課題を追加" })).toBeNull();
    // 名前と説明は変えられる
    expect(screen.getByLabelText("名前").matches(":disabled")).toBe(false);
  });

  it("線を選ぶと関係名と両端を出す。削除はできない", () => {
    const rel = st().model.relations.find((r) => r.kind === "actorActivity")!;
    act(() => st().select({ type: "relation", id: rel.id }));
    render(<PropertyPanel />);
    const editor = within(screen.getByTestId("relation-editor"));
    expect(editor.getByText("担当")).toBeDefined();
    expect(editor.queryByRole("button", { name: "削除" })).toBeNull();
    const src = st().model.elements.find((e) => e.id === rel.sourceId)!;
    fireEvent.click(editor.getByRole("button", { name: src.name }));
    expect(st().ui.selection).toEqual({ type: "element", id: src.id });
  });

  it("自由ボードで両端がある線は、付け根の辺をそのボードだけで変えられる", () => {
    act(() => st().setCurrentBoard("board_flow"));
    const board = st().model.boards.find((b) => b.id === "board_flow")!;
    const onBoard = new Set(board.nodes.map((n) => n.elementId));
    const rel = st().model.relations.find((r) => onBoard.has(r.sourceId) && onBoard.has(r.targetId))!;
    act(() => st().select({ type: "relation", id: rel.id }));
    render(<PropertyPanel />);
    const editor = within(screen.getByTestId("relation-editor"));
    const source = editor.getByLabelText("始点の辺") as HTMLSelectElement;
    const target = editor.getByLabelText("終点の辺") as HTMLSelectElement;
    expect([source.value, target.value]).toEqual(["right", "left"]);
    fireEvent.change(source, { target: { value: "left" } });
    expect(st().model.boards.find((b) => b.id === "board_flow")!.edges).toEqual([{ relationId: rel.id, sourceSide: "left" }]);
    expect(st().model.boards.find((b) => b.id === "board_overview")!.edges).toBeUndefined();
    // 両端が同じ辺なら入れ替えは無効
    expect((editor.getByRole("button", { name: "入れ替え" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(target, { target: { value: "top" } });
    fireEvent.click(editor.getByRole("button", { name: "入れ替え" }));
    expect(st().model.boards.find((b) => b.id === "board_flow")!.edges).toEqual([{ relationId: rel.id, sourceSide: "top" }]);
    expect([source.value, target.value]).toEqual(["top", "left"]);
  });

  it("固定ボードでは線の付け根の欄を出さない", () => {
    onFixedBoard();
    const rel = st().model.relations.find((r) => r.kind === "actorActivity")!;
    act(() => st().select({ type: "relation", id: rel.id }));
    render(<PropertyPanel />);
    expect(screen.queryByLabelText("始点の辺")).toBeNull();
  });

  it("「追加」直後は名前欄にフォーカスする", () => {
    selectEl("actor_front");
    render(<PropertyPanel />);
    act(() => {
      st().select({ type: "element", id: "actor_manager" });
      st().requestNameFocus();
    });
    expect(document.activeElement).toBe(screen.getByLabelText("名前"));
  });

  it("固定ボードでは、結べる要素を選んで関係を足せる (既にある関係と結べない種類は出さない)", () => {
    onFixedBoard();
    selectEl("biz_checkin");
    render(<PropertyPanel />);
    const select = screen.getByLabelText("関係を追加") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    // フロント担当は既に主担当。外部アクターは業務の主担当になれない
    expect(values).toContain("actor_manager>biz_checkin");
    expect(values).not.toContain("actor_front>biz_checkin");
    expect(values).not.toContain("ext_guest>biz_checkin");
    fireEvent.change(select, { target: { value: "actor_manager>biz_checkin" } });
    expect(
      st().model.relations.some((r) => r.kind === "actorBusiness" && r.sourceId === "actor_manager" && r.targetId === "biz_checkin"),
    ).toBe(true);
  });
});

describe("PropertyPanel のコンテキスト", () => {
  it("条件・状態でもコンテキストを選べ、つながりから見た候補へ 1 クリックで移せる", () => {
    resetStore();
    act(() => st().setCurrentBoard("fixed:condition"));
    act(() => st().select({ type: "element", id: "cond_full" }));
    act(() => {
      st().dispatch((m) => moveToContext(m, { elementId: "cond_full", contextId: null }));
    });
    render(<PropertyPanel />);
    expect((screen.getByLabelText("コンテキスト") as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "「客室」にする" }));
    expect(st().model.elements.find((e) => e.id === "cond_full")).toMatchObject({ contextId: "ctx_room" });
  });
});

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../../io/file", async (orig) => ({
  ...(await orig<typeof import("../../io/file")>()),
  openExternalUrl: async (url: string) => {
    opened.push(url);
  },
}));

describe("PropertyPanel のリンク", () => {
  it("作業にリンクを足し、並べ替え・削除でき、クリックで開く。自由ボードでも編集できる", () => {
    resetStore();
    act(() => st().select({ type: "element", id: "act_clean" }));
    render(<PropertyPanel />);
    const add = (title: string, url: string) => {
      fireEvent.change(screen.getByLabelText("リンクの表示名"), { target: { value: title } });
      fireEvent.change(screen.getByLabelText("リンクの URL"), { target: { value: url } });
      fireEvent.click(screen.getByRole("button", { name: "追加" }));
    };
    add("清掃手順", "https://example.com/clean");
    add("", "https://example.com/check");
    expect(el("act_clean")).toMatchObject({ links: [{ title: "清掃手順" }, { title: "https://example.com/check" }] });
    fireEvent.click(screen.getByRole("button", { name: "リンク「清掃手順」を下へ" }));
    expect((el("act_clean") as { links: { title: string }[] }).links.map((l) => l.title)).toEqual(["https://example.com/check", "清掃手順"]);
    fireEvent.click(screen.getByRole("button", { name: "清掃手順" }));
    expect(opened).toContain("https://example.com/clean");
    fireEvent.click(screen.getByRole("button", { name: "リンク「清掃手順」を削除" }));
    expect((el("act_clean") as { links: unknown[] }).links).toHaveLength(1);
    // http(s) 以外は足さない
    add("x", "file:///etc/passwd");
    expect((el("act_clean") as { links: unknown[] }).links).toHaveLength(1);
  });
});

describe("PropertyPanel の時間", () => {
  it("作業に時間を入れられ、操作の合計は分けて出す。小数点第二位はエラーで元に戻す", () => {
    resetStore();
    act(() => st().select({ type: "element", id: "act_verify_identity" }));
    render(<PropertyPanel />);
    const input = screen.getByLabelText("時間") as HTMLInputElement;
    expect(input.value).toBe("0.1");
    expect(screen.getByText(/操作の合計: 0.2 時間 \(チェックインを記録する 0.2 時間\)/)).toBeDefined();
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.blur(input);
    expect(el("act_verify_identity")).toMatchObject({ hours: 0.5 });
    fireEvent.change(input, { target: { value: "0.55" } });
    fireEvent.blur(input);
    expect(el("act_verify_identity")).toMatchObject({ hours: 0.5 });
    expect((screen.getByLabelText("時間") as HTMLInputElement).value).toBe("0.5");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(el("act_verify_identity")).not.toHaveProperty("hours");
  });
});

describe("PropertyPanel の関係一覧", () => {
  it("関係名と向きに加えて、相手の種類 (レイヤー名) を出す", () => {
    resetStore();
    act(() => st().select({ type: "element", id: "act_verify_identity" }));
    render(<PropertyPanel />);
    const items = screen.getAllByRole("listitem").filter((li) => li.closest(".relation-list"));
    const texts = items.map((li) => li.textContent?.replace("×", ""));
    expect(texts).toContain("担当←アクターフロント担当");
    expect(texts).toContain("使う→操作チェックインを記録する");
  });
});

describe("PropertyPanel のトレース", () => {
  it("関係と課題の間に、上下のレイヤーと要素を表で出し、行ごとにそのレイヤーへ移れる", () => {
    resetStore();
    act(() => st().setCurrentBoard("fixed:activity"));
    act(() => st().select({ type: "element", id: "act_verify_identity" }));
    render(<PropertyPanel />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf("トレース")).toBe(headings.indexOf("関係") + 1);
    expect(headings.findIndex((h) => h.startsWith("課題"))).toBe(headings.indexOf("トレース") + 1);
    const rows = screen.getAllByRole("row").filter((r) => r.closest(".trace-table") && r.querySelector("th[scope=row]"));
    const layers = rows.map((r) => r.querySelector("th")!.textContent);
    // 業務に直接属する作業なので、活動は (未設定) の行として出る
    expect(layers.slice(0, 4)).toEqual(["↑登場人物", "↑業務", "↑活動", "●作業"]);
    const bucRow = rows.find((r) => r.querySelector("th")!.textContent === "↑活動")!;
    expect(within(bucRow).getByText("(未設定)")).toBeDefined();
    expect(layers).toContain("↓操作");
    // 今のボード (作業) の行は移れない
    const ownRow = rows.find((r) => r.querySelector("th")!.textContent === "●作業")!;
    expect((within(ownRow).getByRole("button", { name: /固定ボード「作業」へ移る/ }) as HTMLButtonElement).disabled).toBe(true);
    // 操作の行から移ると、要素を選んだまま操作のボードへ
    const ucRow = rows.find((r) => r.querySelector("th")!.textContent === "↓操作")!;
    fireEvent.click(within(ucRow).getByRole("button", { name: /固定ボード「操作」へ移る/ }));
    expect(st().ui.currentBoardId).toBe("fixed:usecase");
    expect(st().ui.selection).toEqual({ type: "element", id: "act_verify_identity" });
  });

  it("つながる要素の無いレイヤーも (未設定) の行で出し、そのレイヤーへ移れる", () => {
    resetStore();
    act(() => st().setCurrentBoard("fixed:usecase"));
    act(() => {
      const r = st().dispatch((m) => addElement(m, { kind: "usecase", name: "宙に浮いた操作" }));
      if (r.ok) st().select({ type: "element", id: r.id });
    });
    render(<PropertyPanel />);
    const rows = screen.getAllByRole("row").filter((r) => r.closest(".trace-table") && r.querySelector("th[scope=row]"));
    const layers = rows.map((r) => r.querySelector("th")!.textContent);
    expect(layers).toEqual(["↑登場人物", "↑業務", "↑活動", "↑作業", "●操作", "↓情報", "↓条件", "↓状態", "↓バリエーション"]);
    expect(screen.getByText(/上下のレイヤーにつながる要素はありません/)).toBeDefined();
    const actRow = rows.find((r) => r.querySelector("th")!.textContent === "↑作業")!;
    expect(within(actRow).getByText("(未設定)")).toBeDefined();
    fireEvent.click(within(actRow).getByRole("button", { name: /固定ボード「作業」へ移る/ }));
    expect(st().ui.currentBoardId).toBe("fixed:activity");
  });
});
