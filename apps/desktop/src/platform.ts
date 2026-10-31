// Platform の Tauri (デスクトップ) 実装。
// ファイルはダイアログとネイティブのファイル操作 (Rust のコマンド)、API キーは OS のキーチェーン、
// 最近開いたファイルはパスを localStorage に置く。
import { invoke } from "@tauri-apps/api/core";
import {
  FILE_EXTENSION,
  RECENT_LIMIT,
  baseName,
  type OpenedFile,
  type Platform,
  type RecentFile,
  type RecentFileStore,
  type SavedFile,
  type SecretStore,
} from "@untie/ui/platform";

const FILE_FILTERS = [{ name: "Untie モデル", extensions: [FILE_EXTENSION] }];

// ---- 最近開いたファイル (localStorage) ----

const STORAGE_KEY = "untie.recentFiles";

// 読めないときは「一覧が空」とみなす
function readList(): RecentFile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is RecentFile => typeof e?.path === "string" && typeof e?.name === "string") : [];
  } catch {
    return [];
  }
}

// 書けないときは覚えないだけにする (ファイルを開く・保存すること自体は止めない)
function writeList(list: RecentFile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(({ name, path }) => ({ name, path }))));
  } catch {
    // 覚えられなくても困らない
  }
}

const recentFiles: RecentFileStore = {
  async load() {
    return readList();
  },
  async add(file) {
    if (!file.path) return;
    const rest = readList().filter((e) => e.path !== file.path);
    writeList([{ name: file.name, path: file.path }, ...rest].slice(0, RECENT_LIMIT));
  },
  async remove(file) {
    writeList(readList().filter((e) => e.path !== file.path));
  },
  async clear() {
    writeList([]);
  },
  async read(file): Promise<OpenedFile> {
    const text = await invoke<string>("read_model_file", { path: file.path });
    return { path: file.path!, name: baseName(file.path!), text };
  },
};

// ---- API キー (OS のキーチェーン。Rust 側の get_api_key / set_api_key / delete_api_key) ----

// key は AI のプロバイダー ID (claude / codex / gemini)。Rust 側が知っているものだけ受け付ける
const secrets: SecretStore = {
  async get(key) {
    return (await invoke<string | null>("get_api_key", { provider: key })) ?? null;
  },
  async set(key, value) {
    await invoke("set_api_key", { provider: key, key: value });
  },
  async delete(key) {
    await invoke("delete_api_key", { provider: key });
  },
  // ブラウザに保存する、という選択肢はデスクトップには無い
  isRemembered: () => false,
};

// ---- Platform ----

/** サーバーの URL を置く localStorage のキー */
const SERVER_ORIGIN_KEY = "untie.serverOrigin";

async function confirmDiscard(message: string, okLabel = "破棄して続ける"): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "Untie", kind: "warning", okLabel, cancelLabel: "キャンセル" });
}

export function desktopPlatform(): Platform {
  return {
    kind: "desktop",

    async openTextFile(): Promise<OpenedFile | null> {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, directory: false, filters: FILE_FILTERS });
      if (typeof path !== "string") return null;
      const text = await invoke<string>("read_model_file", { path });
      return { path, name: baseName(path), text };
    },

    async saveTextFile(text, path, suggestedName): Promise<SavedFile | null> {
      let target = path;
      if (!target) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        target = await save({ defaultPath: suggestedName, filters: FILE_FILTERS });
        if (!target) return null;
      }
      await invoke("write_model_file", { path: target, contents: text });
      return { path: target, name: baseName(target) };
    },

    canReopenFiles: () => true,

    confirmDiscard,

    async openExternalUrl(url) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },

    // 止めなかったときは onCloseRequested がウィンドウを destroy するので、capability に core:window:allow-destroy が要る
    onCloseRequested(hasUnsavedChanges) {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const off = await getCurrentWindow().onCloseRequested(async (event) => {
          if (!hasUnsavedChanges()) return;
          if (!(await confirmDiscard("保存していない変更があります。破棄して閉じますか？", "破棄して閉じる"))) event.preventDefault();
        });
        if (disposed) off();
        else unlisten = off;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },

    secrets,
    recentFiles,

    // 設定したサーバーの URL。http(s) の URL として読めるものだけ、オリジン (末尾のパスなどを除いたもの) にして返す。
    // 無い・読めない・http(s) でないときは空 (サーバー未設定)
    serverOrigin: () => {
      try {
        const url = new URL(localStorage.getItem(SERVER_ORIGIN_KEY) ?? "");
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
      } catch {
        return "";
      }
    },
    async login() {
      throw new Error("デスクトップ版のログインは次の段階で対応します");
    },
    // 6 段階目 (デスクトップのログイン) まではそのまま返す。Rust の get_api_key の許可リストに "session" がまだ無く、
    // キーチェーンを読むと実機では必ず失敗してしまうため。6 段階目で、トークンがあれば Authorization: Bearer を付ける
    async authorize(init) {
      return init;
    },
  };
}
