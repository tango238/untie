import { Canvas } from "./components/canvas/Canvas";
import { ElementList } from "./components/ElementList";
import { FixedBoard } from "./components/FixedBoard";
import { IssuePanel } from "./components/IssuePanel";
import { TracePanel } from "./components/TracePanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { parseAnalysisBoardId } from "./model/analysis";
import { parseFixedBoardId } from "./model/fixedBoards";
import { AnalysisBoard } from "./components/analysis/AnalysisBoard";
import { useCloseGuard } from "./io/useCloseGuard";
import { useUntieStore } from "./store";

export default function App() {
  useKeyboard();
  useCloseGuard();
  const rightPanel = useUntieStore((s) => s.ui.rightPanel);
  const fixedLayer = useUntieStore((s) => parseFixedBoardId(s.ui.currentBoardId));
  const analysis = useUntieStore((s) => parseAnalysisBoardId(s.ui.currentBoardId));
  const builtin = fixedLayer !== null || analysis !== null;
  return (
    <div className="app">
      <Toolbar />
      {/* 固定ボード・分析ボードは上位の要素から順に辿るので、要素一覧は自由ボードのときだけ出す */}
      <div className={`main${builtin ? " no-list" : ""}`}>
        {!builtin && <ElementList />}
        <main className="canvas-area">
          {fixedLayer ? (
            <FixedBoard key={fixedLayer} layer={fixedLayer} />
          ) : analysis ? (
            <AnalysisBoard key={analysis} kind={analysis} />
          ) : (
            <Canvas />
          )}
        </main>
        <div className="right-panel">{rightPanel === "issues" ? <IssuePanel /> : rightPanel === "trace" ? <TracePanel /> : <PropertyPanel />}</div>
      </div>
      <ToastHost />
    </div>
  );
}
