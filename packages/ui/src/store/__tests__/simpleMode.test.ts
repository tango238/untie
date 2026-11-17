import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, removeElement } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { createUntieStore, DEFAULT_MODE, isBuiltinBoard, modeOf, SIMPLE_START_BOARD_ID, START_BOARD_ID } from "..";

beforeEach(() => localStorage.clear());

// 詳細調整で始めたストア。既定が情報整理であることは「既定のモード」のテストで確かめる
const make = () => createUntieStore(createHotelSample(), START_BOARD_ID, "properties", "analysis");
const WORKFLOW = "simple:workflow";
// 情報整理モードの最初のボード (固定ボードの「登場人物」)
const ACTOR = "fixed:actor";

describe("情報整理モード", () => {
  it("詳細調整から情報整理へ移ると、登場人物 (固定ボード) が開く。モードは情報整理のまま", () => {
    const s = make();
    expect(s.getState().ui.mode).toBe("analysis");
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    expect(SIMPLE_START_BOARD_ID).toBe(ACTOR);
    expect(isBuiltinBoard(WORKFLOW)).toBe(true);
  });

  it("情報整理モードで登場人物の固定ボードを開いても、詳細調整へ移らない。ほかの固定ボードは今までどおり詳細調整へ移る", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().setCurrentBoard(WORKFLOW);
    s.getState().setCurrentBoard(ACTOR);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    s.getState().setCurrentBoard("fixed:business");
    expect(s.getState().ui.mode).toBe("analysis");
    // 詳細調整で登場人物を開いても、詳細調整のまま
    s.getState().setCurrentBoard(ACTOR);
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    // 詳細調整で登場人物を開いたまま情報整理へ切り替えると、登場人物のまま
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    // 設計から (登場人物の固定ボードへ) 飛んだときは、これまでどおり詳細調整へ移る
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard(ACTOR);
    expect(s.getState().ui.mode).toBe("analysis");
  });

  it("モードを省いたストアが、登場人物の固定ボードで始まると詳細調整 (ボードからモードを導く規則は変えない)", () => {
    expect(createUntieStore(createHotelSample(), ACTOR).getState().ui.mode).toBe("analysis");
    expect(createUntieStore(createHotelSample(), ACTOR, "properties", "analysisSimple").getState().ui).toMatchObject({ mode: "analysisSimple", currentBoardId: ACTOR });
  });

  it("情報整理モードでも分析ボードを開けて、モードは情報整理のまま", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().setCurrentBoard("analysis:people");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe("analysis:people");
  });

  it("情報整理モードで業務一覧以外のボードが渡されたら、設計ボードは (対象が未定なら) 断り、自由ボード・固定ボードは詳細調整へ移って開く", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    // 自由ボードは詳細調整へ移って開く (ショートカット一覧から自由ボードを押したとき)
    s.getState().setCurrentBoard("board_flow");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("board_flow");
    s.getState().setMode("analysisSimple");
    // 設計ボードは (対象のシステムが未定なので) 開けない
    s.getState().setCurrentBoard("design:data");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    // 固定ボードへ飛ぶ (プロパティのトレースのリンクなど) と、詳細調整へ移る
    s.getState().setCurrentBoard("fixed:activity");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("fixed:activity");
  });

  it("詳細調整・設計モードでは業務一覧は開けない。業務一覧の id を開くと情報整理モードへ移る", () => {
    const s = make();
    s.getState().setCurrentBoard(WORKFLOW);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    s.getState().setMode("analysis");
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    s.getState().enterDesign("sys_pms");
    expect(s.getState().ui.mode).toBe("design");
    expect(s.getState().ui.currentBoardId).toBe("design:sitemap");
    // 設計から情報整理へも移れる
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    expect(s.getState().ui.designSystemId).toBe("sys_pms");
  });

  it("情報整理と詳細調整を行き来しても、選んでいる要素とモデルはそのまま (undo の履歴も増えない)", () => {
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

  it("情報整理で足したものが詳細でそのまま見え、詳細調整で足したものも情報整理で見える (同じモデル)", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().dispatch((m) => addElement(m, { kind: "actor", name: "情報整理で足した人", id: "actor_s" }));
    s.getState().setMode("analysis");
    expect(s.getState().model.elements.some((e) => e.id === "actor_s")).toBe(true);
    s.getState().dispatch((m) => addElement(m, { kind: "actor", name: "詳細調整で足した人", id: "actor_d" }));
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
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
  });

  it("情報整理・詳細調整のどちらも、ファイルを開く・新規作成・クラウドを開いて閉じるを通しても保つ。設計モードは既定の情報整理へ戻る", () => {
    const cloud = { fileId: "f1", role: "owner" as const, doc: new Y.Doc() };
    const s = make();
    s.getState().setMode("analysisSimple");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    s.getState().newDocument(createHotelSample());
    expect(s.getState().ui.mode).toBe("analysisSimple");
    s.getState().loadCloudDocument(createHotelSample(), cloud);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    s.getState().closeCloud();
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    // 詳細調整は今までどおり最初のボード
    s.getState().setMode("analysis");
    s.getState().setCurrentBoard("fixed:activity");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "b.json" });
    expect(s.getState().ui.mode).toBe("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    // 設計にいたときは、既定の情報整理へ
    s.getState().enterDesign("sys_pms");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "c.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
  });

  it("情報整理モードの途中で対象のシステムが消えても、情報整理モードのまま", () => {
    const s = make();
    s.getState().enterDesign("sys_pms");
    s.getState().setMode("analysisSimple");
    s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
  });
});

describe("情報整理モードの業務一覧とシステム操作の 2 枚", () => {
  const OPERATION = "simple:operation";

  it("情報整理モードの最初は登場人物。業務一覧・システムへ移って、業務一覧へ戻れる。どちらも情報整理モードのまま", () => {
    const s = make();
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    s.getState().setCurrentBoard(WORKFLOW);
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(OPERATION);
    s.getState().setCurrentBoard(WORKFLOW);
    expect(s.getState().ui.currentBoardId).toBe(WORKFLOW);
    expect(isBuiltinBoard(OPERATION)).toBe(true);
  });

  it("詳細調整・設計モードからシステムの id を開くと情報整理モードへ移る。情報整理以外のモードでは、reconcileUi がそのモードの最初のボードへ戻す", () => {
    const s = make();
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
    // 情報整理 → 詳細調整: 最初のボード。選択は残す
    s.getState().select({ type: "element", id: "uc_register_reservation" });
    s.getState().setMode("analysis");
    expect(s.getState().ui.currentBoardId).toBe("analysis:issues");
    expect(s.getState().ui.selection).toEqual({ type: "element", id: "uc_register_reservation" });
    // 情報整理へ戻ると、登場人物から (開いていたのはシステムでも、最初のボード)
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
    // 設計 → 情報整理
    s.getState().enterDesign("sys_pms");
    s.getState().setCurrentBoard(OPERATION);
    expect(s.getState().ui.mode).toBe("analysisSimple");
  });

  it("情報整理モードでシステム操作のボードを開いたまま、ファイルを開き直す・選択した要素が消えても、システムのボードは保たれる (ファイルを開き直すと登場人物から)", () => {
    const s = make();
    s.getState().setCurrentBoard(OPERATION);
    s.getState().select({ type: "element", id: "scr_checkin" });
    s.getState().dispatch((m) => removeElement(m, { id: "scr_checkin" }));
    expect(s.getState().ui.selection).toBeNull();
    expect(s.getState().ui.currentBoardId).toBe(OPERATION);
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
  });
});

describe("情報整理モードの 3 枚のボード", () => {
  it("業務一覧・システム操作・情報と状態を行き来できる。どれも情報整理モードのまま。モードを離れると最初のボードに直る", () => {
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
    // 詳細調整から情報と状態の id を開くと情報整理モードへ移る
    s.getState().setCurrentBoard("simple:information");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    // 情報整理モードに入り直すと、最初は登場人物
    s.getState().setMode("analysis");
    s.getState().setMode("analysisSimple");
    expect(s.getState().ui.currentBoardId).toBe(ACTOR);
  });
});

describe("既定のモードは情報整理", () => {
  it("モードを省いて情報整理のボードで始めると情報整理モード。ui.mode が未設定でも情報整理と読む", () => {
    expect(DEFAULT_MODE).toBe("analysisSimple");
    const s = createUntieStore(createHotelSample(), "simple:workflow");
    expect(s.getState().ui.mode).toBe("analysisSimple");
    expect(modeOf({})).toBe("analysisSimple");
    expect(modeOf({ mode: "analysis" })).toBe("analysis");
  });

  it("新規作成・ファイルを開く・サンプルを開くと、既定のモード (情報整理) の登場人物と、プロパティの右ペインで始まる", () => {
    const s = createUntieStore(createHotelSample(), "simple:workflow");
    s.getState().setRightPanel("trace");
    s.getState().newDocument(createHotelSample(), { pristine: true });
    expect(s.getState().ui).toMatchObject({ mode: "analysisSimple", currentBoardId: ACTOR, rightPanel: "properties", selection: null });
    s.getState().loadDocument(createHotelSample(), { path: null, name: "a.json" });
    expect(s.getState().ui).toMatchObject({ mode: "analysisSimple", currentBoardId: ACTOR, rightPanel: "properties" });
  });

  it("設計の対象のシステムが消えたら、設計に入る前にいた分析のモード (情報整理・詳細調整) に戻る", () => {
    for (const before of ["analysisSimple", "analysis"] as const) {
      const s = createUntieStore(createHotelSample(), before === "analysis" ? START_BOARD_ID : "simple:workflow", "properties", before);
      s.getState().enterDesign("sys_pms");
      expect(s.getState().ui.mode).toBe("design");
      s.getState().dispatch((m) => removeElement(m, { id: "sys_pms" }));
      expect(s.getState().ui.mode).toBe(before);
      expect(s.getState().ui.currentBoardId).toBe(before === "analysis" ? "analysis:issues" : ACTOR);
    }
  });

  it("設計ボードへ飛んでもモードを覚える (ショートカットなど)。設計に入る前の情報整理・詳細調整を行き来して覚え直す", () => {
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
  it("情報整理のボードなら情報整理、自由ボード・固定ボード・分析ボードなら詳細調整。ボードとモードが合わない状態は作らない", () => {
    expect(createUntieStore(createHotelSample(), "simple:workflow").getState().ui.mode).toBe("analysisSimple");
    expect(createUntieStore(createHotelSample(), "board_overview").getState().ui.mode).toBe("analysis");
    expect(createUntieStore(createHotelSample()).getState().ui.mode).toBe("analysis");
    expect(createUntieStore(createHotelSample(), "analysis:issues").getState().ui.mode).toBe("analysis");
    // 明示すれば、そのとおり
    expect(createUntieStore(createHotelSample(), "simple:workflow", "properties", "analysisSimple").getState().ui.mode).toBe("analysisSimple");
  });
});
