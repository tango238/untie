import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MokkunV2Schema } from "mokkun";
import { attachFrameNavigation, handleFrameClick, MokkunPreview } from "../design/MokkunPreview";

afterEach(cleanup);

const schema: MokkunV2Schema = {
  mokkun: 2,
  app: {
    name: "予約",
    layout: "shell",
    navigation: [
      { group: "予約", items: [{ view: "a" }, { view: "b" }] },
      { group: "請求", items: [{ view: "c" }] },
    ],
  },
  views: {
    a: { title: "検索", goal: "探す", nav: "a", sections: [{ id: "s", title: "S", kind: "readonly", note: "n" }], secondaryActions: [{ id: "go_b", label: "登録へ", kind: "navigate", to: "b" }, { id: "x", label: "クリア", kind: "reset" }] },
    b: { title: "登録", goal: "登録する", sections: [{ id: "s", title: "S", kind: "readonly", note: "n" }] },
    c: { title: "請求", goal: "請求する", sections: [{ id: "s", title: "S", kind: "readonly", note: "n" }] },
  },
};

/** 描いた文書を、そのまま document の下に置く (listener の単体の確認用) */
function mountHtml(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("MokkunPreview", () => {
  it("srcdoc に CSS と描いた HTML を入れた iframe を出す。スクリプトは動かさない (sandbox は allow-same-origin だけ)", () => {
    render(<MokkunPreview schema={schema} viewName="a" onNavigate={() => {}} />);
    const frame = screen.getByTitle("画面のプレビュー") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    const src = frame.getAttribute("srcdoc")!;
    expect(src).toContain("<style>");
    expect(src).toContain("mk2-header");
    expect(src).toContain("検索");
    expect(src).not.toContain("<script");
  });

  it("描けない文書はエラーを出す", () => {
    render(<MokkunPreview schema={null as unknown as MokkunV2Schema} viewName="a" onNavigate={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("プレビューを描けませんでした");
  });

  it("iframe の読み込みで contentDocument にクリックの listener を付け、外す", () => {
    const onNavigate = vi.fn();
    render(<MokkunPreview schema={schema} viewName="a" onNavigate={onNavigate} />);
    const frame = screen.getByTitle("画面のプレビュー") as HTMLIFrameElement;
    // jsdom は srcdoc を描かない (空の文書のまま) ので、文書に直接リンクを置いて、load で付いた listener を確かめる
    const doc = frame.contentDocument!;
    expect(doc).not.toBeNull();
    doc.body.innerHTML = '<a href="#b" data-nav-view="b">登録</a>';
    fireEvent.load(frame);
    (doc.querySelector("a") as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledWith("b");
  });
});

describe("handleFrameClick / attachFrameNavigation", () => {
  const html = () => schemaHtml();

  function schemaHtml(): string {
    // renderViewV2 の出力は MokkunPreview の srcdoc と同じ
    const holder = document.createElement("div");
    render(<MokkunPreview schema={schema} viewName="a" onNavigate={() => {}} />, { container: holder });
    const src = (holder.querySelector("iframe") as HTMLIFrameElement).getAttribute("srcdoc")!;
    return src.slice(src.indexOf("<body>") + 6, src.indexOf("</body>"));
  }

  it("グローバルナビのリンク (data-nav-view) で移り、既定の動作を止める", () => {
    const root = mountHtml(html());
    const onNavigate = vi.fn();
    const detach = attachFrameNavigation(document, onNavigate);
    const link = root.querySelector('a[data-nav-view="c"]') as HTMLElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onNavigate).toHaveBeenCalledWith("c");
    expect(ev.defaultPrevented).toBe(true);
    detach();
    link.click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it("グループのボタンはサブメニューを開閉し、遷移しない。メニューの外を押すと閉じる", () => {
    const root = mountHtml(html());
    const onNavigate = vi.fn();
    const detach = attachFrameNavigation(document, onNavigate);
    const toggle = root.querySelector("[data-submenu-toggle]") as HTMLElement;
    const menu = root.querySelector(".mk2-submenu") as HTMLElement;
    expect(menu.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    // メニューの中の項目を押すと移って閉じる
    (menu.querySelector("[data-nav-view]") as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(menu.hidden).toBe(true);
    toggle.click();
    expect(menu.hidden).toBe(false);
    (root.querySelector("main") as HTMLElement).click();
    expect(menu.hidden).toBe(true);
    detach();
    root.remove();
  });

  it("遷移のボタン (data-navigate-to) で移る。navigate 以外のボタンは何もしない", () => {
    const root = mountHtml(html());
    const onNavigate = vi.fn();
    const detach = attachFrameNavigation(document, onNavigate);
    (root.querySelector('button[data-action="go_b"]') as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledWith("b");
    onNavigate.mockClear();
    (root.querySelector('button[data-action="x"]') as HTMLElement).click();
    expect(onNavigate).not.toHaveBeenCalled();
    detach();
    root.remove();
  });

  it("そのほかのリンク (href=\"#...\"・相対 URL) は移らず、既定の動作だけ止める", () => {
    const root = mountHtml('<a id="x" href="#top">ここ</a><a id="y" href="foo/bar"><span id="z">相対</span></a>');
    const onNavigate = vi.fn();
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("#x")!.addEventListener("click", (e) => handleFrameClick(e, onNavigate));
    root.querySelector("#x")!.dispatchEvent(ev);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("#y")!.addEventListener("click", (e) => handleFrameClick(e, onNavigate));
    root.querySelector("#z")!.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    root.remove();
  });
});

describe("MokkunPreview: load のたびに listener を付け直す", () => {
  it("2 回目の load で前の文書の listener を外して新しい文書に付け、アンマウントで外す", () => {
    const onNavigate = vi.fn();
    const { unmount } = render(<MokkunPreview schema={schema} viewName="a" onNavigate={onNavigate} />);
    const frame = screen.getByTitle("画面のプレビュー") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    const add = vi.spyOn(doc, "addEventListener");
    const remove = vi.spyOn(doc, "removeEventListener");
    doc.body.innerHTML = '<a href="#b" data-nav-view="b">登録</a>';
    fireEvent.load(frame);
    fireEvent.load(frame);
    // 2 回目の load で 1 回目の分 (click と submit) を外し、付け直している
    expect(add).toHaveBeenCalledTimes(4);
    expect(remove).toHaveBeenCalledTimes(2);
    (doc.querySelector("a") as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalledTimes(4);
    (doc.querySelector("a") as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
