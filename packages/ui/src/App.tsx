import { lazy, Suspense } from "react";
import { Canvas } from "./components/canvas/Canvas";
import { FixedBoard } from "./components/FixedBoard";
import { LeftPane } from "./components/LeftPane";
import { IssuePanel } from "./components/IssuePanel";
import { TracePanel } from "./components/TracePanel";
import { DesignCheckPanel } from "./components/design/DesignCheckPanel";
import { DataLeftPane } from "./components/design/DataLeftPane";
import { DataProperties } from "./components/design/DataProperties";
import { NavigationLayoutPane } from "./components/design/NavigationLayoutPane";
import { RelationLeftPane } from "./components/design/RelationLeftPane";
import { RelationProperties } from "./components/design/RelationProperties";
import { NavigationMenuPane } from "./components/design/NavigationMenuPane";
import { ScreenListPane } from "./components/design/ScreenListPane";
import { PropertyPanel } from "./components/PropertyPanel";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { useKeyboard } from "./components/useKeyboard";
import { parseAnalysisBoardId } from "@untie/core/model/analysis";
import { parseDesignBoardId } from "@untie/core/model/design";
import { parseFixedBoardId } from "@untie/core/model/fixedBoards";
import { DesignBoard } from "./components/design/DesignBoard";
import { SitemapProperties } from "./components/design/SitemapProperties";
import { SitemapTree } from "./components/design/SitemapTree";
import { AnalysisBoard } from "./components/analysis/AnalysisBoard";
import { selectReadOnly, useUntieStore } from "./store";
import { ROLE_LABELS } from "@untie/api";
import { useAgentStore } from "./ai/agentStore";
import { AgentPane } from "./components/ai/AgentPane";
import { LinkGuestNotice } from "./components/share/LinkGuestNotice";

// 画面の組み立ては mokkun (約 750KB) の検証を使うので、画面ボードを開くまで読み込まない
const ScreenBuilder = lazy(() => import("./components/design/ScreenBuilder").then((m) => ({ default: m.ScreenBuilder })));

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
  const link = useUntieStore((s) => s.cloud?.link);
  const saveFailed = useUntieStore((s) => s.cloud?.saveFailed ?? false);
  const fixedLayer = useUntieStore((s) => parseFixedBoardId(s.ui.currentBoardId));
  const analysis = useUntieStore((s) => parseAnalysisBoardId(s.ui.currentBoardId));
  const design = useUntieStore((s) => parseDesignBoardId(s.ui.currentBoardId));
  const builtin = fixedLayer !== null || analysis !== null || design !== null;
  // 設計モードのサイトマップは、左に画面の追加の木、右にその画面のプロパティを出す
  const sitemap = design === "sitemap";
  // データボードは、左にデータベースとテーブルの一覧、右に選んだテーブルのプロパティを出す
  const data = design === "data";
  // ナビゲーションボードは、左に枠とヘッダーの設定、右にナビゲーションメニューを出す
  const navigation = design === "navigation";
  // 画面ボードは、左に画面の一覧、右に画面の組み立てを出す
  const screenBoard = design === "screen";
  // 関連ボードは、左に情報・テーブル・画面の一覧、右に選んだものの詳細を出す
  const relation = design === "relation";
  const mode = useUntieStore((s) => s.ui.mode ?? "analysis");
  const setElementListOpen = useUntieStore((s) => s.setElementListOpen);
  // 狭い画面ではペインがドロワーとして画面の上に重なる。開いているあいだは、外側を押すと閉じる幕を出す
  // (広い画面では CSS で隠れる)
  const listDrawerOpen = !builtin && elementListOpen;
  const closeDrawers = () => {
    setRightPanelOpen(false);
    setElementListOpen(false);
  };
  return (
    <div className="app">
      {readOnly && role && (
        <div className="readonly-banner">
          <span role="status">閲覧専用です (役割: {ROLE_LABELS[role]})</span>
          {/* リンクで閲覧しているゲストには、ログイン (または複製) の導線を添える */}
          {link !== undefined && role === "guest" && <LinkGuestNotice token={link} />}
        </div>
      )}
      {/* サーバーが保存できていない (検証に通らない・書き込みの失敗)。いまの画面の内容を JSON に書き出して残すよう促す */}
      {saveFailed && (
        <div className="save-failed-banner" role="alert">
          サーバーに保存できていません。JSON に書き出して保存してください
        </div>
      )}
      <Toolbar />
      {/* 固定ボード・分析ボード・設計ボードは上位の要素から順に辿るので、要素一覧は自由ボードのときだけ出す */}
      <div
        className={`main${sitemap || data || navigation || screenBoard || relation ? " with-tree" : builtin ? " no-list" : elementListOpen ? "" : " list-closed"}${screenBoard ? " with-screen" : ""}${rightPanelOpen ? "" : " panel-closed"}`}
      >
        {(listDrawerOpen || rightPanelOpen) && (
          <div className="pane-backdrop" data-testid="pane-backdrop" onClick={closeDrawers} />
        )}
        {!builtin && <LeftPane />}
        {sitemap && <SitemapTree />}
        {data && <DataLeftPane />}
        {navigation && <NavigationMenuPane />}
        {screenBoard && <ScreenListPane />}
        {relation && <RelationLeftPane />}
        <main className="canvas-area">
          {fixedLayer ? (
            <FixedBoard key={fixedLayer} layer={fixedLayer} />
          ) : analysis ? (
            <AnalysisBoard key={analysis} kind={analysis} />
          ) : design ? (
            <DesignBoard key={design} kind={design} />
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
            <div className="right-panel">{rightPanel === "issues" ? (
                <IssuePanel />
              ) : rightPanel === "trace" ? (
                mode === "design" ? (
                  <DesignCheckPanel />
                ) : (
                  <TracePanel />
                )
              ) : sitemap ? (
                <SitemapProperties />
              ) : data ? (
                <DataProperties />
              ) : relation ? (
                <RelationProperties />
              ) : navigation ? (
                <NavigationLayoutPane />
              ) : screenBoard ? (
                <Suspense fallback={<p className="hint">読み込んでいます…</p>}>
                  <ScreenBuilder />
                </Suspense>
              ) : (
                <PropertyPanel />
              )}</div>
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
