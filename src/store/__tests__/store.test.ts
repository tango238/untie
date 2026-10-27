import { describe, expect, it } from "vitest";
import { addElement, clearAll, moveActivity, moveNode, removeBoard, removeElement, updateElement, validateModel } from "../../model";
import { HISTORY_LIMIT, createUntieStore } from "..";
import { emptyModel } from "../../model/types";
import { sampleWithActorCards } from "../../test/utils";

const rename = (id: string, name: string) => (m: Parameters<typeof updateElement>[0]) => updateElement(m, { id, patch: { name } });

describe("ストア", () => {
  it("起動時にサンプルを読み込み、最初のボードを開く", () => {
    const s = createUntieStore(sampleWithActorCards());
    expect(s.getState().model.elements.length).toBeGreaterThan(50);
    expect(s.getState().ui.currentBoardId).toBe("board_overview");
    expect(s.getState().history).toEqual({ past: [], future: [] });
  });

  it("dispatch で履歴に積まれ、undo / redo で行き来できる", () => {
    const s = createUntieStore(sampleWithActorCards());
    const original = s.getState().model;
    s.getState().dispatch(rename("actor_front", "A"));
    s.getState().dispatch(rename("actor_front", "B"));
    const name = () => s.getState().model.elements.find((e) => e.id === "actor_front")!.name;
    expect(name()).toBe("B");
    s.getState().undo();
    expect(name()).toBe("A");
    s.getState().undo();
    expect(s.getState().model).toBe(original);
    s.getState().undo(); // 履歴が尽きても何も起きない
    expect(s.getState().model).toBe(original);
    s.getState().redo();
    s.getState().redo();
    expect(name()).toBe("B");
    s.getState().redo();
    expect(name()).toBe("B");
  });

  it("新しい操作で redo 履歴は消える", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().dispatch(rename("actor_front", "A"));
    s.getState().undo();
    expect(s.getState().history.future).toHaveLength(1);
    s.getState().dispatch(rename("actor_front", "C"));
    expect(s.getState().history.future).toHaveLength(0);
  });

  it("失敗したコマンドは履歴にもモデルにも影響しない", () => {
    const s = createUntieStore(sampleWithActorCards());
    const before = s.getState().model;
    const r = s.getState().dispatch((m) => removeElement(m, { id: "nope" }));
    expect(r.ok).toBe(false);
    expect(s.getState().model).toBe(before);
    expect(s.getState().history.past).toHaveLength(0);
  });

  it("変化のないコマンドは履歴に積まない", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().dispatch((m) => ({ ok: true, model: m }));
    expect(s.getState().history.past).toHaveLength(0);
  });

  it("履歴は最大 100 件", () => {
    const s = createUntieStore(emptyModel());
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s.getState().dispatch((m) => addElement(m, { kind: "actor", name: `a${i}` }));
    }
    expect(s.getState().history.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s.getState().undo();
    // 古い 20 件分は戻れない
    expect(s.getState().model.elements).toHaveLength(20);
    expect(s.getState().history.future).toHaveLength(HISTORY_LIMIT);
  });

  it("ドラッグ中の previewNode は履歴に積まず、commitDrag で 1 件になる", () => {
    const s = createUntieStore(sampleWithActorCards());
    const before = s.getState().model;
    const node = () => s.getState().model.boards[0].nodes.find((n) => n.elementId === "actor_front")!;
    for (let i = 1; i <= 10; i++) s.getState().previewNode("board_overview", "actor_front", { x: i * 10, y: i * 10 });
    expect(node()).toMatchObject({ x: 100, y: 100 });
    expect(s.getState().history.past).toHaveLength(0);
    s.getState().commitDrag();
    expect(s.getState().history.past).toEqual([before]);
    expect(s.getState().dragBase).toBeNull();
    s.getState().undo();
    expect(s.getState().model).toBe(before);
    s.getState().redo();
    expect(node()).toMatchObject({ x: 100, y: 100 });
  });

  it("動かさずに commitDrag しても履歴は増えない。cancelDrag は元に戻す", () => {
    const s = createUntieStore(sampleWithActorCards());
    const before = s.getState().model;
    s.getState().commitDrag();
    expect(s.getState().history.past).toHaveLength(0);
    s.getState().previewNode("board_overview", "actor_front", { x: 1, y: 1 });
    s.getState().cancelDrag();
    expect(s.getState().model).toBe(before);
    expect(s.getState().history.past).toHaveLength(0);
  });

  it("ドラッグ途中の dispatch はドラッグを先に確定する", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().previewNode("board_overview", "actor_front", { x: 1, y: 1 });
    s.getState().dispatch(rename("actor_manager", "X"));
    expect(s.getState().history.past).toHaveLength(2);
    s.getState().undo();
    expect(s.getState().model.boards[0].nodes.find((n) => n.elementId === "actor_front")).toMatchObject({ x: 1, y: 1 });
  });

  it("要素を消すと選択が外れ、Undo で戻せる", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().select({ type: "element", id: "act_clean" });
    s.getState().dispatch((m) => removeElement(m, { id: "act_clean" }));
    expect(s.getState().ui.selection).toBeNull();
    s.getState().undo();
    expect(s.getState().model.elements.some((e) => e.id === "act_clean")).toBe(true);
  });

  it("「空にする」は 1 件の履歴で、現在のボードが残るボードに切り替わり、Undo で戻る", () => {
    const s = createUntieStore(sampleWithActorCards());
    const before = s.getState().model;
    s.getState().setCurrentBoard("board_flow");
    s.getState().dispatch((m) => clearAll(m, { boardId: "b" }));
    expect(s.getState().ui.currentBoardId).toBe("b");
    s.getState().undo();
    expect(s.getState().model).toBe(before);
    expect(s.getState().ui.currentBoardId).toBe("board_overview");
  });

  it("UI の状態変更は履歴に入らない", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().setCurrentBoard("board_flow");
    s.getState().select({ type: "element", id: "act_clean" });
    s.getState().setRightPanel("issues");
    expect(s.getState().history.past).toHaveLength(0);
    s.getState().setCurrentBoard("nope");
    expect(s.getState().ui.currentBoardId).toBe("board_flow");
  });

  it("commitDrag にコマンドを渡すと、ドラッグと所属変更が 1 件の履歴になる", () => {
    const s = createUntieStore(sampleWithActorCards());
    const before = s.getState().model;
    s.getState().previewNode("board_overview", "act_verify_identity", { x: 5, y: 5 });
    s.getState().commitDrag((m) => moveActivity(m, { activityId: "act_verify_identity", bucId: null }));
    expect(s.getState().history.past).toEqual([before]);
    const act = s.getState().model.elements.find((e) => e.id === "act_verify_identity");
    expect(act).toMatchObject({ bucId: null });
    s.getState().undo();
    expect(s.getState().model).toBe(before);
  });

  it("previewCommand は履歴に積まず、commitDrag で確定する", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().previewCommand((m) => moveNode(m, { boardId: "board_overview", elementId: "actor_front", position: { x: 9, y: 9 } }));
    expect(s.getState().history.past).toHaveLength(0);
    s.getState().commitDrag();
    expect(s.getState().history.past).toHaveLength(1);
  });

  it("トーストは積まれ、dismissToast で消える。名前フォーカス要求の番号が増える", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().pushToast("a");
    s.getState().pushToast("b", "error");
    expect(s.getState().toasts.map((t) => [t.message, t.tone])).toEqual([["a", "info"], ["b", "error"]]);
    s.getState().dismissToast(s.getState().toasts[0]!.id);
    expect(s.getState().toasts).toHaveLength(1);
    s.getState().requestNameFocus();
    expect(s.getState().ui.nameFocusNonce).toBe(1);
  });

  it("ボードを消すと、開いていたボードは先頭へ移る", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().setCurrentBoard("board_flow");
    s.getState().dispatch((m) => removeBoard(m, { id: "board_flow" }));
    expect(s.getState().ui.currentBoardId).toBe("board_overview");
  });

  it("ドラッグ中の undo / redo は無視され、ドラッグはそのまま続けられる", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().dispatch(rename("actor_front", "A"));
    s.getState().undo();
    s.getState().previewNode("board_overview", "actor_manager", { x: 7, y: 7 });
    const during = s.getState().model;
    s.getState().undo();
    s.getState().redo();
    expect(s.getState().model).toBe(during);
    expect(s.getState().dragBase).not.toBeNull();
    expect(s.getState().history.future).toHaveLength(1);
    s.getState().commitDrag();
    expect(s.getState().history.past).toHaveLength(1);
  });

  it("業務名を変えたあとも整合性検査を通る", () => {
    const s = createUntieStore(sampleWithActorCards());
    s.getState().dispatch(rename("biz_checkin", "到着手続き"));
    const r = validateModel(JSON.parse(JSON.stringify(s.getState().model)));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});

describe("最初に出す画面", () => {
  it("起動時・新規作成では分析ボード「課題の分布」と、右ペインの課題一覧を開く", async () => {
    const { useUntieStore, START_BOARD_ID } = await import("..");
    expect(START_BOARD_ID).toBe("analysis:issues");
    expect(useUntieStore.getState().ui).toMatchObject({ currentBoardId: "analysis:issues", rightPanel: "issues" });
    const s = createUntieStore(sampleWithActorCards());
    s.getState().setCurrentBoard("fixed:activity");
    s.getState().setRightPanel("trace");
    s.getState().setRightPanelOpen(false);
    s.getState().newDocument(emptyModel(), { pristine: true });
    expect(s.getState().ui).toMatchObject({ currentBoardId: "analysis:issues", rightPanel: "issues", rightPanelOpen: true, selection: null });
  });
});
