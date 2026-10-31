// ハッシュで画面を分けるルーター (設計書 8.1)。サーバーには `#` の後ろが届かないので、どの経路でも同じ index.html を返せばよい。
//   #/                … ホーム (空や不明なハッシュもここ)
//   #/local           … ローカル編集 (いまのエディタ)
//   #/f/<fileId>      … クラウドファイル
//   #/invite/<token>  … 招待を受ける (次の段階)
//   #/link/<token>    … リンクで開く (次の段階)
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "local" }
  | { name: "file"; fileId: string }
  | { name: "invite"; token: string }
  | { name: "link"; token: string };

/** ファイル id・トークンとして受ける形 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const HOME_ROUTE: Route = { name: "home" };

/** ハッシュ文字列 (`#/f/abc` など) を画面に直す。読めないものはホーム */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter((p) => p !== "");
  const [head, arg] = parts;
  // ファイル id・トークンは nanoid などの英数字と _ - だけ。合わないものは(壊れたリンクとして)ホームにする
  const decode = (s: string | undefined): string | null => {
    if (!s) return null;
    try {
      const value = decodeURIComponent(s);
      return ID_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  if (parts.length === 1 && head === "local") return { name: "local" };
  if (parts.length === 2) {
    const value = decode(arg);
    if (value) {
      if (head === "f") return { name: "file", fileId: value };
      if (head === "invite") return { name: "invite", token: value };
      if (head === "link") return { name: "link", token: value };
    }
  }
  return HOME_ROUTE;
}

/** 画面をハッシュ文字列に直す */
export function formatRoute(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "local":
      return "#/local";
    case "file":
      return `#/f/${encodeURIComponent(route.fileId)}`;
    case "invite":
      return `#/invite/${encodeURIComponent(route.token)}`;
    case "link":
      return `#/link/${encodeURIComponent(route.token)}`;
  }
}

// hashchange は非同期に届くので、navigate では自分でも購読者に知らせる (画面の切り替えをその場で確定させる)
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}

const currentHash = () => window.location.hash;

/** いまの画面 */
export function currentRoute(): Route {
  return parseRoute(currentHash());
}

/** 画面を移る。履歴に積む (ブラウザの戻るで戻れる) */
export function navigate(route: Route): void {
  const hash = formatRoute(route);
  if (window.location.hash !== hash) window.location.hash = hash;
  notify();
}

/** いまの画面を購読する。ハッシュが変わるたびに描き直す */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, () => "");
  // ハッシュ文字列を安定した値にしてから解釈する (参照が毎回変わると無限に描き直すため)
  return parseRouteCached(hash);
}

let cache: { hash: string; route: Route } | null = null;
function parseRouteCached(hash: string): Route {
  if (!cache || cache.hash !== hash) cache = { hash, route: parseRoute(hash) };
  return cache.route;
}
