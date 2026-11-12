import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import { addElement, removeElement } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { createUntieStore, isBuiltinBoard, START_BOARD_ID } from "..";

beforeEach(() => localStorage.clear());

const make = () => createUntieStore(createHotelSample(), START_BOARD_ID);
const WORKFLOW = "simple:workflow";

describe("分析（簡易）モード", () => {
  it("既定は分析（詳細）のまま。簡易へ移るとワークフローの 1 枚が開く", () => {
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

  it("簡易モードは、ファイルを開く・新規作成・クラウドを開いて閉じるを通しても保つ。設計モードは分析（詳細）へ戻る", () => {
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
    // 設計は分析（詳細）へ
    s.getState().enterDesign("sys_pms");
    s.getState().loadDocument(createHotelSample(), { path: null, name: "c.json" });
    expect(s.getState().ui.mode).toBe("analysis");
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
