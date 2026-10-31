import { Canvas } from "./components/canvas/Canvas";
import { FixedBoard } from "./components/FixedBoard";
import { LeftPane } from "./components/LeftPane";
import { IssuePanel } from "./components/IssuePanel";
import { TracePanel } from "./components/TracePanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { parseAnalysisBoardId } from "@untie/core/model/analysis";
import { parseFixedBoardId } from "@untie/core/model/fixedBoards";
import { AnalysisBoard } from "./components/analysis/AnalysisBoard";
import { selectReadOnly, useUntieStore } from "./store";
import { ROLE_LABELS } from "@untie/api";
import { useAgentStore } from "./ai/agentStore";
import { AgentPane } from "./components/ai/AgentPane";

const RIGHT_PANEL_LABELS = { properties: "プロパティ", issues: "課題一覧", trace: "検証" } as const;

export default function App() {
  useKeyboard();
  const rightPanel = useUntieStore((s) => s.ui.rightPanel);
  const rightPanelOpen = useUntieStore((s) => s.ui.rightPanelOpen ?? true);
  const setRightPanelOpen = useUntieStore((s) => s.setRightPanelOpen);
  const elementListOpen = useUntieStore((s) => s.ui.elementListOpen ?? true);
  const agentOpen = useAgentStore((s) => s.open);
  const readOnly = useUntieStore(selectReadOnly);
  const role = useUntieStore((s) => s.cloud?.role);
  const fixedLayer = useUntieStore((s) => parseFixedBoardId(s.ui.currentBoardId));
  const analysis = useUntieStore((s) => parseAnalysisBoardId(s.ui.currentBoardId));
  const builtin = fixedLayer !== null || analysis !== null;
  return (
    <div className="app">
      {readOnly && role && (
        <div className="readonly-banner" role="status">
          閲覧専用です (役割: {ROLE_LABELS[role]})
        </div>
      )}
      <Toolbar />
      {/* 固定ボード・分析ボードは上位の要素から順に辿るので、要素一覧は自由ボードのときだけ出す */}
      <div
        className={`main${builtin ? " no-list" : elementListOpen ? "" : " list-closed"}${rightPanelOpen ? "" : " panel-closed"}`}
      >
        {!builtin && <LeftPane />}
        <main className="canvas-area">
          {fixedLayer ? (
            <FixedBoard key={fixedLayer} layer={fixedLayer} />
          ) : analysis ? (
            <AnalysisBoard key={analysis} kind={analysis} />
          ) : (
            <Canvas />
          )}
        </main>
        <div className="right-pane">
          <button
            type="button"
            className="pane-toggle"
            aria-expanded={rightPanelOpen}
            aria-label={rightPanelOpen ? "右のペインを閉じる" : "右のペインを開く"}
            title={rightPanelOpen ? "右のペインを閉じる" : "右のペインを開く"}
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
          >
            {rightPanelOpen ? "›" : "‹"}
          </button>
          {rightPanelOpen ? (
            <div className="right-panel">{rightPanel === "issues" ? <IssuePanel /> : rightPanel === "trace" ? <TracePanel /> : <PropertyPanel />}</div>
          ) : (
            // 閉じているときは細い帯だけ残し、いま何のペインかを縦書きで出す
            <button type="button" className="pane-strip" onClick={() => setRightPanelOpen(true)}>
              {RIGHT_PANEL_LABELS[rightPanel]}
            </button>
          )}
        </div>
      </div>
      {agentOpen && !readOnly && <AgentPane />}
      <ToastHost />
    </div>
  );
}
