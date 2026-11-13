import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, removeElement } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { createUntieStore, DEFAULT_MODE, isBuiltinBoard, modeOf, START_BOARD_ID } from "..";

beforeEach(() => localStorage.clear());

// 分析（詳細）で始めたストア。既定が分析（簡易）であることは「既定のモード」のテストで確かめる
const make = () => createUntieStore(createHotelSample(), START_BOARD_ID, "properties", "analysis");
const WORKFLOW = "simple:workflow";

describe("分析（簡易）モード", () => {
  it("分析（詳細）から簡易へ移ると、ワークフローが開く", () => {
    const s = make();
    expect(s.getState().ui.mode).toBe("analysis");
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    expect(isBuiltinBoard(WORKFLOW)).toBe(true);
  });

  it("簡易モードでワークフロー以外のボードが渡されたら、設計ボードは (対象が未定なら) 断り、自由ボード・固定ボードは分析（詳細）へ移って開く", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    // 自由ボードは詳細へ移って開く (ショートカット一覧から自由ボードを押したとき)
    s.getState().setCurrentBoard("board_flow");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("board_flow");
    s.getState().setMode("analysisSimple");
    // 設計ボードは (対象のシステムが未定なので) 開けない
    s.getState().setCurrentBoard("design:data");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    // 固定ボードへ飛ぶ (プロパティのトレースのリンクなど) と、分析（詳細）へ移る
    s.getState().setCurrentBoard("fixed:activity");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("fixed:activity");
  });

  it("詳細・設計モードではワークフローは開けない。ワークフローの id を開くと簡易モードへ移る", () => {
    const s = make();
    s.getState().setCurrentBoard(WORKFLOW);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    s.getState().setMode("analysis");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.currentBoardId).toBe("design:sitemap");
    // 設計から簡易へも移れる
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    expect(s.getState().ui.designSystemId).toBe("sys_pms");
  });

  it("簡易と詳細を行き来しても、選んでいる要素とモデルはそのまま (undo の履歴も増えない)", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().select({ type: "element", id: "act_hand_key" });
    const model = s.getState().model;
    s.getState().setMode("analysis");
    expect(s.getState().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.selection).toEqual({ type: "element", id: "act_hand_key" });
    expect(s.getState().model).toBe(model);
    expect(s.getState().history.past).toHaveLength(0);
  });

  it("簡易で足したものが詳細でそのまま見え、詳細で足したものも簡易で見える (同じモデル)", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().dispatch((m) => addElement(m, { kind: "actor", name: "簡易で足した人", id: "actor_s" }));
    s.getState().setMode("analysis");
    expect(s.getState().model.elements.some((e) => e.id === "actor_s")).toBe(true);
    s.getState().dispatch((m) => addElement(m, { kind: "actor", name: "詳細で足した人", id: "actor_d" }));
    s.getState().setMode("analysisSimple");
    expect(s.getState().model.elements.some((e) => e.id === "actor_d")).toBe(true);
  });

  it("選んでいた要素が消えれば、選択だけが外れる。モードとボードはそのまま", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().select({ type: "element", id: "act_hand_key" });
    s.getState().dispatch((m) => removeElement(m, { id: "act_hand_key" }));
    expect(s.getState().ui.selection).toBeNull();
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
  });

  it("簡易・詳細のどちらも、ファイルを開く・新規作成・クラウドを開いて閉じるを通しても保つ。設計モードは既定の分析（簡易）へ戻る", () => {
    const cloud = { fileId: "f1", role: "owner" as const, doc: new Y.Doc() };
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    s.getState().newDocument(createHotelSample());
    expect(s.getState().ui.mode).toBe("analysisSimple");
    s.getState().loadCloudDocument(createHotelSample(), cloud);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    s.getState().closeCloud();
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    // 詳細は今までどおり最初のボード
    s.getState().setMode("analysis");
    s.getState().setCurrentBoard("fixed:activity");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "b.json" });
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    // 設計にいたときは、既定の分析（簡易）へ
    s.getState().enterDesign("sys_pms");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "c.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
  });

  it("簡易モードの途中で対象のシステムが消えても、簡易モードのまま", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setMode("analysisSimple");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
  });
});

describe("簡易モードのワークフローとシステム操作の 2 枚", () => {
  const OPERATION = "simple:operation";

  it("簡易モードの最初はワークフロー。システムへ移って、ワークフローへ戻れる。どちらも簡易モードのまま", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(OPERATION);
    s.getState().setCurrentBoard(WORKFLOW);
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    expect(isBuiltinBoard(OPERATION)).toBe(true);
  });

  it("詳細・設計モードからシステムの id を開くと簡易モードへ移る。簡易以外のモードでは、reconcileUi がそのモードの最初のボードへ戻す", () => {
    const s = make();
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    // 簡易 → 詳細: 最初のボード。選択は残す
    s.getState().select({ type: "element", id: "uc_register_reservation" });
    s.getState().setMode("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    expect(s.getState().ui.selection).toEqual({ type: "element", id: "uc_register_reservation" });
    // 簡易へ戻ると、ワークフローから (開いていたのはシステムでも、最初のボード)
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    // 設計 → 簡易
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
  });

  it("簡易モードでシステム操作のボードを開いたまま、ファイルを開き直す・選択した要素が消えても、システムのボードは保たれる (ファイルを開き直すとワークフローから)", () => {
    const s = make();
    s.getState().setCurrentBoard(OPERATION);
    s.getState().select({ type: "element", id: "scr_checkin" });
    s.getState().dispatch((m) => removeElement(m, { id: "scr_checkin" }));
    expect(s.getState().ui.selection).toBeNull();
    expect(s.getState().ui.currentBoardId).toBe(OPERATION);
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
  });
});

describe("簡易モードの 3 枚のボード", () => {
  it("ワークフロー・システム操作・情報と状態を行き来できる。どれも簡易モードのまま。モードを離れると最初のボードに直る", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    for (const id of ["simple:operation", "simple:information", "simple:workflow", "simple:information"]) {
      s.getState().setCurrentBoard(id);
      expect(s.getState().ui.mode).toBe("analysisSimple");
      expect(s.getState().ui.currentBoardId).toBe(id);
      expect(isBuiltinBoard(id)).toBe(true);
    }
    s.getState().setMode("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    // 詳細から情報と状態の id を開くと簡易モードへ移る
    s.getState().setCurrentBoard("simple:information");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    // 簡易モードに入り直すと、最初はワークフロー
    s.getState().setMode("analysis");
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe("simple:workflow");
  });
});

describe("既定のモードは分析（簡易）", () => {
  it("何も指定しないストアは、分析（簡易）のワークフローから始まる。ui.mode が未設定でも簡易と読む", () => {
    expect(DEFAULT_MODE).toBe("analysisSimple");
    const s = createUntieStore(createHotelSample(), "simple:workflow");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(modeOf({})).toBe("analysisSimple");
    expect(modeOf({ mode: "analysis" })).toBe("analysis");
  });

  it("新規作成・ファイルを開く・サンプルを開くと、既定のモード (簡易) のワークフローと、プロパティの右ペインで始まる", () => {
    const s = createUntieStore(createHotelSample(), "simple:workflow");
    s.getState().setRightPanel("trace");
    s.getState().newDocument(createHotelSample(), { pristine: true });
    expect(s.getState().ui).toMatchObject({ mode: "analysisSimple", currentBoardId: "simple:workflow", rightPanel: "properties", selection: null });
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui).toMatchObject({ mode: "analysisSimple", currentBoardId: "simple:workflow", rightPanel: "properties" });
  });

  it("設計の対象のシステムが消えたら、設計に入る前にいた分析のモード (簡易・詳細) に戻る", () => {
    for (const before of ["analysisSimple", "analysis"] as const) {
      const s = createUntieStore(createHotelSample(), before === "analysis" ? START_BOARD_ID : "simple:workflow", "properties", before);
      s.getState().enterDesign("sys_pms");
      expect(s.getState().ui.mode).toBe("design");
      s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
      expect(s.getState().ui.mode).toBe(before);
      expect(s.getState().ui.currentBoardId).toBe(before === "analysis" ? "analysis:issues" : "simple:workflow");
    }
  });

  it("設計ボードへ飛んでもモードを覚える (ショートカットなど)。設計に入る前の簡易・詳細を行き来して覚え直す", () => {
    const s = createUntieStore(createHotelSample(), "simple:workflow");
    s.getState().enterDesign("sys_pms");
    s.getState().setMode("analysis");
    s.getState().setMode("design");
    expect(s.getState().ui.modeBeforeDesign).toBe("analysis");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    expect(s.getState().ui.mode).toBe("analysis");
  });
});

describe("createUntieStore: モードを省いたとき、開くボードに合うモードで始まる", () => {
  it("簡易ボードなら簡易、自由ボード・固定ボード・分析ボードなら詳細。ボードとモードが合わない状態は作らない", () => {
    expect(createUntieStore(createHotelSample(), "simple:workflow").getState().ui.mode).toBe("analysisSimple");
    expect(createUntieStore(createHotelSample(), "board_overview").getState().ui.mode).toBe("analysis");
    expect(createUntieStore(createHotelSample()).getState().ui.mode).toBe("analysis");
    expect(createUntieStore(createHotelSample(), "analysis:issues").getState().ui.mode).toBe("analysis");
    // 明示すれば、そのとおり
    expect(createUntieStore(createHotelSample(), "simple:workflow", "properties", "analysisSimple").getState().ui.mode).toBe("analysisSimple");
  });
});
