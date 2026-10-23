import { Canvas } from "./components/canvas/Canvas";
import { ElementList } from "./components/ElementList";
import { IssuePanel } from "./components/IssuePanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { useUntieStore } from "./store";

export default function App() {
  useKeyboard();
  const rightPanel = useUntieStore((s) => s.ui.rightPanel);
  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <ElementList />
        <main className="canvas-area">
          <Canvas />
        </main>
        <div className="right-panel">{rightPanel === "issues" ? <IssuePanel /> : <PropertyPanel />}</div>
      </div>
      <ToastHost />
    </div>
  );
}
