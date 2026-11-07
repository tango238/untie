import { useEffect, useId, useMemo, useRef } from "react";
import {
  BUILTIN_SCREEN_LABELS,
  SITEMAP_BUILTINS,
  builtinDesignScreen,
  checkStateOf,
  designScreensOf,
  presentScreenIds,
  sitemapTree,
  type CheckState,
  type SitemapTreeNode,
} from "@untie/core/model/sitemap";
import { selectReadOnly, useUntieStore } from "../../store";
import { useSitemapEdit } from "./useSitemapEdit";

/** indeterminate は属性ではなくプロパティなので、描画のたびに合わせる */
function TreeCheck({ label, state, disabled, describedBy, onToggle }: { label: string; state: CheckState; disabled: boolean; describedBy?: string; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  // 再描画のたびに合わせる (React が checked を直したあとにも indeterminate を保つため)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  });
  return <input ref={ref} type="checkbox" aria-label={label} aria-describedby={describedBy} checked={state === "checked"} disabled={disabled} onChange={onToggle} />;
}

/**
 * 設計モードのサイトマップの左ペイン: 画面の追加・削除の木。
 * 上に組み込みの画面 (サインイン・トップページ)、下に分析の業務 → 活動 → 作業 → 操作。
 * チェックの状態は保存せず、設計の画面から導く (届く画面がすべてあれば checked、一部なら indeterminate)。
 * 対象のシステムの画面に届かない節は薄く表示し、チェックできない
 */
export function SitemapTree() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const readOnly = useUntieStore(selectReadOnly);
  const { add, remove, dialog } = useSitemapEdit();
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const uid = useId();
  const design = model.designs.find((d) => d.systemId === systemId);
  const tree = useMemo(() => (systemId ? sitemapTree(model, systemId) : []), [model, systemId]);
  const present = presentScreenIds(design);

  const toggleNode = (node: SitemapTreeNode, state: CheckState) => {
    if (state === "checked") remove(designScreensOf(design, node.screenIds).map((s) => s.id));
    else add(node.screenIds.filter((id) => !present.has(id)).map((screenId) => ({ kind: "screen" as const, screenId })));
  };

  const renderNode = (node: SitemapTreeNode, parent: SitemapTreeNode | undefined, path: string) => {
    const state = checkStateOf(node.screenIds, present);
    const dim = node.screenIds.length === 0;
    const key = `${path}/${node.id}`;
    const descId = `${uid}-${key}`;
    // 画面名と親の作業を、チェックボックスの説明として添える
    const description = [node.screenNames.length > 0 ? `画面: ${node.screenNames.join("、")}` : "", parent ? `${parent.kind === "activity" ? "作業" : "親"}: ${parent.name}` : ""].filter(Boolean).join("。");
    const placed = node.kind === "usecase" ? designScreensOf(design, node.screenIds)[0] : undefined;
    return (
      <li key={key} className={`tree-node kind-${node.kind}${dim ? " is-dim" : ""}`} data-tree-node={node.id}>
        <div className="tree-row">
          <label className="tree-label">
            <TreeCheck label={node.name} state={state} disabled={readOnly || dim} describedBy={description ? descId : undefined} onToggle={() => toggleNode(node, state)} />
            <span className="tree-name">{node.name}</span>
          </label>
          {node.screenNames.length > 0 &&
            (placed ? (
              <button type="button" className="link tree-screen" onClick={() => selectDesignScreen(placed.id)}>
                {node.screenNames.join("、")}
              </button>
            ) : (
              <small className="tree-screen">{node.screenNames.join("、")}</small>
            ))}
          {description && (
            <span id={descId} className="visually-hidden">
              {description}
            </span>
          )}
        </div>
        {node.children.length > 0 && <ul>{node.children.map((c) => renderNode(c, node, key))}</ul>}
      </li>
    );
  };

  return (
    <aside className="sitemap-tree" aria-label="サイトマップの画面の一覧">
      <h2 className="panel-title">画面の追加</h2>
      <section aria-label="組み込みの画面">
        <h3 className="tree-heading">組み込みの画面</h3>
        <ul>
          {SITEMAP_BUILTINS.map((b) => {
            const ds = builtinDesignScreen(design, b);
            return (
              <li key={b} className="tree-node">
                <label className="tree-row tree-label">
                  <TreeCheck
                    label={BUILTIN_SCREEN_LABELS[b]}
                    state={ds ? "checked" : "unchecked"}
                    disabled={readOnly}
                    onToggle={() => (ds ? remove([ds.id]) : add([{ kind: "builtin", builtin: b }]))}
                  />
                  <span className="tree-name">{BUILTIN_SCREEN_LABELS[b]}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="分析の業務">
        <h3 className="tree-heading">業務・作業・操作</h3>
        {tree.length === 0 ? <p className="hint">業務がまだありません。</p> : <ul>{tree.map((n) => renderNode(n, undefined, ""))}</ul>}
      </section>
      {dialog}
    </aside>
  );
}
