import { beforeEach, describe, expect, it } from "vitest";
import { addElement, ensureDesign, removeDesignScreensById, removeElement } from "@untie/core/model/commands";
import { addSitemapScreens } from "@untie/core/model/sitemap";
import { createHotelSample } from "@untie/core/sample";
import { createUntieStore, START_BOARD_ID } from "..";
import { loadLastDesignSystemId } from "../designPrefs";

beforeEach(() => localStorage.clear());

// 分析（詳細）で始めたストア (既定は分析（簡易）。詳細の振る舞いはここで確かめる)
const make = () => createUntieStore(createHotelSample(), START_BOARD_ID, "properties", "analysis");

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
    s.getState().setCurrentBoard("design:navigation");
    s.getState().enterDesign("sys_accounting");
    expect(s.getState().ui.designSystemId).toBe("sys_accounting");
    expect(s.getState().ui.currentBoardId).toBe("design:navigation");
  });
});

describe("ボードの切り替えとモード", () => {
  it("設計モードでは設計ボードと自由ボードを開ける", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    for (const id of ["design:navigation", "design:screen", "design:data", "board_flow"]) {
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
  it("設計モードに入るとプロパティに替えて右のペインを開く。分析に戻してもそのまま", () => {
    const s = createUntieStore(createHotelSample(), START_BOARD_ID, "issues", "analysis");
    s.getState().setRightPanelOpen(false);
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.rightPanel).toBe("properties");
    expect(s.getState().ui.rightPanelOpen).toBe(true);
    s.getState().setMode("analysis");
    expect(s.getState().ui.rightPanelOpen).toBe(true);
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

describe("ファイルを開く・閉じると、設計から既定 (分析（簡易）) に戻る", () => {
  it("新規作成・開く", () => {
    for (const reset of ["newDocument", "loadDocument"] as const) {
      const s = make();
      s.getState().enterDesign("sys_pms");
      s.getState().setCurrentBoard("design:navigation");
      if (reset === "newDocument") s.getState().newDocument(createHotelSample());
      else s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
      // 設計にいたときは、既定の分析（簡易）のワークフローに戻る
      expect(s.getState().ui.mode).toBe("analysisSimple");
      expect(s.getState().ui.designSystemId).toBeUndefined();
      expect(s.getState().ui.currentBoardId).toBe("simple:workflow");
    }
  });

  it("分析（詳細）にいるときにファイルを開く・新規作成しても、詳細のまま (最初のボードと課題一覧から)", () => {
    for (const reset of ["newDocument", "loadDocument"] as const) {
      const s = make();
      s.getState().setCurrentBoard("fixed:activity");
      s.getState().setRightPanel("trace");
      if (reset === "newDocument") s.getState().newDocument(createHotelSample());
      else s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
      expect(s.getState().ui.mode).toBe("analysis");
      expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
      expect(s.getState().ui.rightPanel).toBe("issues");
    }
  });
});

describe("サイトマップで選んだ画面 (ui.designScreenId)", () => {
  const withScreens = () => {
    const s = make();
    s.getState().dispatch((m) => addElement(m, { kind: "screen", name: "一覧", init: { systemId: "sys_pms" } }));
    const screenId = s.getState().model.elements.find((e) => e.kind === "screen" && e.name === "一覧")!.id;
    s.getState().enterDesign("sys_pms");
    const r = s.getState().dispatch((m) => addSitemapScreens(m, "sys_pms", [{ kind: "screen", screenId }, { kind: "builtin", builtin: "top" }]));
    expect(r.ok).toBe(true);
    const ids = s.getState().model.designs[0]!.screens.map((x) => x.id);
    return { s, screenId, ids };
  };

  it("既定は未選択。選ぶと覚え、課題一覧のペインを出していてもプロパティに切り替える", () => {
    const { s, ids } = withScreens();
    expect(s.getState().ui.designScreenId).toBeUndefined();
    s.getState().selectDesignScreen(ids[0], "tr_x");
    expect(s.getState().ui.designScreenId).toBe(ids[0]);
    expect(s.getState().ui.designTransitionId).toBe("tr_x");
    expect(s.getState().ui.rightPanel).toBe("properties");
    s.getState().selectDesignScreen(ids[1]);
    expect(s.getState().ui.designTransitionId).toBeUndefined();
    s.getState().selectDesignScreen(undefined);
    expect(s.getState().ui.designScreenId).toBeUndefined();
  });

  it("reconcileUi: 選んだ画面が設計から無くなったら消える (画面の削除・サイトマップから外す・undo)", () => {
    const { s, screenId, ids } = withScreens();
    s.getState().selectDesignScreen(ids[0]);
    s.getState().dispatch((m) => removeDesignScreensById(m, { systemId: "sys_pms", ids: [ids[1]!] }));
    expect(s.getState().ui.designScreenId).toBe(ids[0]);
    s.getState().dispatch((m) => removeElement(m, { id: screenId }));
    expect(s.getState().ui.designScreenId).toBeUndefined();
    s.getState().undo();
    expect(s.getState().ui.designScreenId).toBeUndefined();
  });

  it("存在しない id を選んでも、次のモデルの変更で消える", () => {
    const { s } = withScreens();
    s.getState().selectDesignScreen("ds_nothing");
    s.getState().dispatch((m) => addElement(m, { kind: "screen", name: "別の画面", init: { systemId: "sys_pms" } }));
    expect(s.getState().ui.designScreenId).toBeUndefined();
  });

  it("ボードの切り替えでは残り (画面ボードへ開く)、分析へ戻る・対象のシステムが変わると消える", () => {
    const { s, ids } = withScreens();
    s.getState().selectDesignScreen(ids[0]);
    s.getState().setCurrentBoard("design:screen");
    expect(s.getState().ui.designScreenId).toBe(ids[0]);
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.designScreenId).toBe(ids[0]);
    s.getState().enterDesign("sys_payment");
    expect(s.getState().ui.designScreenId).toBeUndefined();

    s.getState().enterDesign("sys_pms");
    s.getState().selectDesignScreen(ids[0]);
    s.getState().setMode("analysis");
    expect(s.getState().ui.designScreenId).toBeUndefined();
  });

  it("対象のシステムが消えると分析に戻り、選択も消える", () => {
    const { s, ids } = withScreens();
    s.getState().selectDesignScreen(ids[0]);
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    expect(s.getState().ui.designScreenId).toBeUndefined();
  });
});
