import { Canvas } from "./components/canvas/Canvas";
import { ElementList } from "./components/ElementList";
import { FixedBoard } from "./components/FixedBoard";
import { IssuePanel } from "./components/IssuePanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { parseFixedBoardId } from "./model/fixedBoards";
import { useUntieStore } from "./store";

export default function App() {
  useKeyboard();
  const rightPanel = useUntieStore((s) => s.ui.rightPanel);
  const fixedLayer = useUntieStore((s) => parseFixedBoardId(s.ui.currentBoardId));
  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <ElementList />
        <main className="canvas-area">
          {fixedLayer ? <FixedBoard key={fixedLayer} layer={fixedLayer} /> : <Canvas />}
        </main>
        <div className="right-panel">{rightPanel === "issues" ? <IssuePanel /> : <PropertyPanel />}</div>
      </div>
      <ToastHost />
    </div>
  );
}
