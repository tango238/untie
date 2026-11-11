import { lazy, Suspense } from "react";
import type { DesignBoardKind } from "@untie/core/model/design";
import { ContextMapBoard } from "./ContextMapBoard";
import { DomainBoard } from "./DomainBoard";
import { DslEditor } from "./DslEditor";
import { RelationCanvas } from "./RelationCanvas";
import { SequenceBoard } from "./SequenceBoard";
import { SitemapCanvas } from "./SitemapCanvas";
import { SoutherBoard } from "./SoutherBoard";

// ナビゲーションのプレビューは mokkun (約 750KB) を使うので、ナビゲーションを開くまで読み込まない
const NavigationBoard = lazy(() => import("./NavigationBoard").then((m) => ({ default: m.NavigationBoard })));
const ScreenBoard = lazy(() => import("./ScreenBoard").then((m) => ({ default: m.ScreenBoard })));

/**
 * 設計ボード。サイトマップは SitemapCanvas。レイアウトは NavigationBoard。画面は ScreenBoard。関連は RelationCanvas。ドメインは DomainBoard。コンテキストマップは ContextMapBoard。シーケンス図は SequenceBoard。業務ルール (Souther) は SoutherBoard。データは DslEditor
 */
export function DesignBoard({ kind }: { kind: DesignBoardKind }) {
  if (kind === "sitemap") return <SitemapCanvas />;
  if (kind === "relation") return <RelationCanvas />;
  if (kind === "sequence") return <SequenceBoard />;
  if (kind === "domain") return <DomainBoard />;
  if (kind === "contextmap") return <ContextMapBoard />;
  if (kind === "rules") return <SoutherBoard />;
  if (kind === "navigation") {
    return (
      <Suspense fallback={<p className="hint layout-loading">プレビューを読み込んでいます…</p>}>
        <NavigationBoard />
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
