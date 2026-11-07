import { useEffect, useMemo, useRef } from "react";
import { renderViewV2, type MokkunV2Schema } from "mokkun";
import { mokkunCss } from "./mokkunStyles";

/** iframe の中のメニューの開閉 (mokkun の mountViewV2 の setSubmenu と同じ: aria-expanded と、メニュー本体の hidden) */
function setSubmenu(button: Element, open: boolean): void {
  button.setAttribute("aria-expanded", String(open));
  const id = button.getAttribute("aria-controls");
  const menu = id ? Array.from(button.closest(".mk2-globalnav")?.querySelectorAll<HTMLElement>(".mk2-submenu") ?? []).find((m) => m.id === id) : undefined;
  if (menu) menu.hidden = !open;
}

function closeSubmenus(root: ParentNode): void {
  root.querySelectorAll("[data-submenu-toggle]").forEach((b) => setSubmenu(b, false));
}

/**
 * iframe の中のクリックを見て、画面の遷移を onNavigate に伝える (スクリプトは iframe に入れず、親から結ぶ)。
 * mokkun の v2 の描画が遷移先を持つ属性: グローバルナビ・パンくず・一覧のリンク・値のリンクは `data-nav-view` (href は `#<view>`)、
 * 遷移のボタンは `data-navigate-to` (navigate と、送信のあとの遷移先を持つ submit)。ナビのグループのボタンは `data-submenu-toggle` で開閉する。
 * そのほかのリンクは何もしない (既定の動作だけ止める)
 */
export function handleFrameClick(ev: Event, onNavigate: (view: string) => void): void {
  // iframe の中の要素は親とは別の window の Element なので、instanceof Element では判定できない (nodeType で見る)
  const node = ev.target as Node | null;
  const target = node && node.nodeType === 1 ? (node as Element) : null;
  if (!target) return;
  const root = target.ownerDocument;
  const navLink = target.closest<HTMLElement>("[data-nav-view]");
  if (navLink) {
    ev.preventDefault();
    closeSubmenus(root);
    const view = navLink.dataset.navView;
    if (view) onNavigate(view);
    return;
  }
  const toggle = target.closest("[data-submenu-toggle]");
  if (toggle) {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    closeSubmenus(root);
    setSubmenu(toggle, open);
    return;
  }
  if (!target.closest(".mk2-globalnav")) closeSubmenus(root);
  const button = target.closest<HTMLElement>("[data-navigate-to]");
  if (button) {
    ev.preventDefault();
    const view = button.dataset.navigateTo;
    if (view) onNavigate(view);
    return;
  }
  // ほかのリンク (href="#..." も、相対 URL も) は、iframe が親のページや別の文書へ移らないよう既定の動作を止める
  if (target.closest("a[href]")) ev.preventDefault();
}

/** 文書にクリックと送信の listener を付ける。戻り値で外す */
export function attachFrameNavigation(doc: Document, onNavigate: (view: string) => void): () => void {
  const click = (ev: Event) => handleFrameClick(ev, onNavigate);
  const submit = (ev: Event) => ev.preventDefault();
  doc.addEventListener("click", click);
  doc.addEventListener("submit", submit);
  return () => {
    doc.removeEventListener("click", click);
    doc.removeEventListener("submit", submit);
  };
}

/** iframe の srcdoc: 必要な CSS と renderViewV2 の HTML。描画に失敗したら例外を投げる */
export function previewSrcDoc(schema: MokkunV2Schema, viewName: string): string {
  const body = renderViewV2(schema, viewName);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${mokkunCss()}</style></head><body>${body}</body></html>`;
}

interface Props {
  schema: MokkunV2Schema;
  viewName: string;
  /** プレビューの中の操作で別の画面へ移るとき (view の名前) */
  onNavigate: (viewName: string) => void;
}

/**
 * mokkun v2 の画面を iframe でプレビューする。srcdoc に CSS と静的な HTML を入れ (iframe の中ではスクリプトを動かさない: sandbox は allow-same-origin だけ)、
 * 遷移は親から iframe の contentDocument に付けた listener で拾う。srcdoc は親の CSP を継承する (inline の `<style>` を許す style-src 'unsafe-inline' が要る)
 */
export function MokkunPreview({ schema, viewName, onNavigate }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const detach = useRef<(() => void) | null>(null);

  const rendered = useMemo(() => {
    try {
      return { srcDoc: previewSrcDoc(schema, viewName) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [schema, viewName]);

  const attach = () => {
    detach.current?.();
    detach.current = null;
    const doc = frame.current?.contentDocument;
    if (doc) detach.current = attachFrameNavigation(doc, (v) => navigate.current(v));
  };
  useEffect(
    () => () => {
      detach.current?.();
      detach.current = null;
    },
    [],
  );

  if (rendered.error !== undefined) {
    return (
      <p className="hint mokkun-error" role="alert">
        プレビューを描けませんでした: {rendered.error}
      </p>
    );
  }
  return <iframe ref={frame} className="mokkun-preview" title="画面のプレビュー" sandbox="allow-same-origin" srcDoc={rendered.srcDoc} onLoad={attach} />;
}
