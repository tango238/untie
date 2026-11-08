import { lazy, Suspense } from "react";
import type { DesignBoardKind } from "@untie/core/model/design";
import { DslEditor } from "./DslEditor";
import { RelationCanvas } from "./RelationCanvas";
import { SitemapCanvas } from "./SitemapCanvas";

// レイアウトのプレビューは mokkun (約 750KB) を使うので、レイアウトを開くまで読み込まない
const LayoutBoard = lazy(() => import("./LayoutBoard").then((m) => ({ default: m.LayoutBoard })));
const ScreenBoard = lazy(() => import("./ScreenBoard").then((m) => ({ default: m.ScreenBoard })));

/**
 * 設計ボード。サイトマップは SitemapCanvas。レイアウトは LayoutBoard。画面は ScreenBoard。関連は RelationCanvas。データは DslEditor
 */
export function DesignBoard({ kind }: { kind: DesignBoardKind }) {
  if (kind === "sitemap") return <SitemapCanvas />;
  if (kind === "relation") return <RelationCanvas />;
  if (kind === "layout") {
    return (
      <Suspense fallback={<p className="hint layout-loading">プレビューを読み込んでいます…</p>}>
        <LayoutBoard />
      </Suspense>
    );
  }
  if (kind === "screen") {
    return (
      <Suspense fallback={<p className="hint layout-loading">プレビューを読み込んでいます…</p>}>
        <ScreenBoard />
      </Suspense>
    );
  }
  return <DslEditor />;
}
