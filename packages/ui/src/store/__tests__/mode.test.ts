import { beforeEach, describe, expect, it } from "vitest";
import { addElement, ensureDesign, removeElement } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { createUntieStore, START_BOARD_ID } from "..";
import { loadLastDesignSystemId } from "../designPrefs";

beforeEach(() => localStorage.clear());

const make = () => createUntieStore(createHotelSample(), START_BOARD_ID);

describe("モード", () => {
  it("既定は分析で、設計の対象は未定", () => {
    const s = make();
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.designSystemId).toBeUndefined();
  });

  it("対象のシステムが未定なら設計モードには移れない。enterDesign で選ぶと設計モードのサイトマップに移り、id を覚える", () => {
    const s = make();
    s.getState().setMode("design");
    expect(s.getState().ui.mode).toBe("analysis");
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.designSystemId).toBe("sys_pms");
    expect(s.getState().ui.currentBoardId).toBe("design:sitemap");
    expect(loadLastDesignSystemId()).toBe("sys_pms");
  });

  it("システムでない id・無い id は選べない", () => {
    const s = make();
    s.getState().enterDesign("actor_front");
    s.getState().enterDesign("nothing");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.designSystemId).toBeUndefined();
  });

  it("分析に戻すと analysis:issues。対象のシステムは覚えていて、設計に戻るとサイトマップから", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("design:data");
    s.getState().setMode("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    expect(s.getState().ui.designSystemId).toBe("sys_pms");
    s.getState().setMode("design");
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.currentBoardId).toBe("design:sitemap");
  });

  it("設計の対象を切り替えても、開いている設計ボードはそのまま", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("design:layout");
    s.getState().enterDesign("sys_accounting");
    expect(s.getState().ui.designSystemId).toBe("sys_accounting");
    expect(s.getState().ui.currentBoardId).toBe("design:layout");
  });
});

describe("ボードの切り替えとモード", () => {
  it("設計モードでは設計ボードと自由ボードを開ける", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    for (const id of ["design:layout", "design:screen", "design:data", "board_flow"]) {
      s.getState().setCurrentBoard(id);
      expect(s.getState().ui.currentBoardId).toBe(id);
      expect(s.getState().ui.mode).toBe("design");
    }
  });

  it("設計モードで固定ボード・分析ボードへ飛ぶと分析モードへ移る (要素の場所へ飛べる)", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("fixed:activity");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("fixed:activity");
    s.getState().setMode("design");
    s.getState().setCurrentBoard("analysis:people");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:people");
  });

  it("revealOnFixedBoard / goToLayer も、設計モードから分析モードの固定ボードへ移る", async () => {
    const { revealOnFixedBoard } = await import("../../components/actions");
    const { useUntieStore } = await import("..");
    useUntieStore.setState({ model: createHotelSample() });
    useUntieStore.getState().enterDesign("sys_pms");
    revealOnFixedBoard("act_hand_key");
    expect(useUntieStore.getState().ui.mode).toBe("analysis");
    expect(useUntieStore.getState().ui.currentBoardId).toBe("fixed:activity");
  });

  it("分析モードで設計ボードへ飛ぶと、対象が決まっていれば設計モードへ移り、未定なら何もしない", () => {
    const s = make();
    s.getState().setCurrentBoard("design:data");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    s.getState().enterDesign("sys_pms");
    s.getState().setMode("analysis");
    s.getState().setCurrentBoard("design:data");
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.currentBoardId).toBe("design:data");
  });

  it("存在しない設計ボードの id は無視する", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("design:nothing");
    expect(s.getState().ui.currentBoardId).toBe("design:sitemap");
  });

  it("設計モードでも、モデルに無い自由ボードの id は無視する", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("design:data");
    s.getState().setCurrentBoard("board_gone");
    expect(s.getState().ui.currentBoardId).toBe("design:data");
  });

  it("モデルの変更で合わなくなったボードは reconcileUi がモードの最初のボードに直す (設計モードで開いていた自由ボードが消えたら自由ボードの先頭)", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("board_flow");
    s.getState().dispatch((m) => ({ ok: true, model: { ...m, boards: m.boards.filter((b) => b.id !== "board_flow") as typeof m.boards } }));
    expect(s.getState().ui.currentBoardId).toBe(s.getState().model.boards[0]!.id);
    expect(s.getState().ui.mode).toBe("design");
  });
});

describe("課題一覧のペイン", () => {
  it("設計モードに入ると閉じ、分析に戻しても自動では開き直さない", () => {
    const s = createUntieStore(createHotelSample(), START_BOARD_ID, "issues");
    s.getState().setRightPanelOpen(true);
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.rightPanel).not.toBe("issues");
    expect(s.getState().ui.rightPanelOpen).toBe(false);
    s.getState().setMode("analysis");
    expect(s.getState().ui.rightPanelOpen).toBe(false);
  });

  it("課題一覧を開いていなければ、ペインの開閉は変えない", () => {
    const s = make();
    s.getState().setRightPanel("trace");
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.rightPanel).toBe("trace");
    expect(s.getState().ui.rightPanelOpen).toBe(true);
  });
});

describe("対象のシステムが消えたとき", () => {
  it("分析に戻り、対象は未定になる", () => {
    const s = make();
    s.getState().dispatch((m) => ensureDesign(m, { systemId: "sys_pms" }));
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard("design:data");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.designSystemId).toBeUndefined();
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    expect(s.getState().model.designs).toEqual([]);
  });

  it("別のシステムが消えても設計モードのまま", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_payment" }));
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.designSystemId).toBe("sys_pms");
  });

  it("undo で戻しても、分析のまま (勝手に設計へ戻らない)", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    s.getState().undo();
    expect(s.getState().ui.mode).toBe("analysis");
  });

  it("画面を足してもモードは変わらない", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().dispatch((m) => addElement(m, { kind: "screen", name: "一覧", init: { systemId: "sys_pms" } }));
    expect(s.getState().ui.mode).toBe("design");
  });
});

describe("ファイルを開く・閉じると分析に戻る", () => {
  it("新規作成・開く", () => {
    for (const reset of ["newDocument", "loadDocument"] as const) {
      const s = make();
      s.getState().enterDesign("sys_pms");
      s.getState().setCurrentBoard("design:layout");
      if (reset === "newDocument") s.getState().newDocument(createHotelSample());
      else s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
      expect(s.getState().ui.mode).toBe("analysis");
      expect(s.getState().ui.designSystemId).toBeUndefined();
      expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    }
  });
});
