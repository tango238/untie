// テスト用の Platform: ファイルもキーも最近開いたファイルもメモリの上で動く。
// setup.ts が各テストの前に新しいものを setPlatform する。テストは memory() で取り出して、状態を仕込む・確かめる。
import {
  RECENT_LIMIT,
  baseName,
  getPlatform,
  type OpenedFile,
  type LoginResult,
  type Platform,
  type RecentFile,
  type SavedFile,
} from "../platform";

export interface MemoryPlatform extends Platform {
  /** openTextFile が返す内容 (null なら取り消し) */
  opened: OpenedFile | null;
  /** saveTextFile で書いた内容 (新しい順ではなく書いた順) */
  saved: { text: string; path: string | null; name: string }[];
  /** saveTextFiles で選ぶフォルダ (null なら取り消し) */
  folder: string | null;
  /** saveTextFiles で書いた内容 */
  savedFolders: { folder: string; files: { name: string; text: string }[]; options: { zipName: string; zipFolder: string } }[];
  /** confirmDiscard の答え */
  discard: boolean;
  /** openExternalUrl で開いた URL */
  openedUrls: string[];
  /** path ごとのファイルの中身。saveTextFile が書き、recentFiles.read が読む */
  contents: Map<string, string>;
  /** 閉じる前の確認として登録されているもの */
  closeGuards: Set<() => boolean>;
  /** serverOrigin が返すサーバーの URL (空にすると「サーバー未設定」) */
  origin: string;
  /** login で呼ばれたログイン (provider と戻り先) */
  logins: { provider: string; returnTo: string }[];
  /** clearSession が呼ばれた回数 */
  clearedSessions: number;
  /** completeLoginWithCode に渡された引換コード。completeError があれば失敗にする */
  codes: string[];
  completeError: string | null;
  /** setServerOrigin に渡された URL */
  serverSets: string[];
  /** onLoggedIn の購読者。テストは emitLoggedIn で終わりを知らせる */
  loginListeners: Set<(result: LoginResult) => void>;
  emitLoggedIn(result?: LoginResult): void;
}

export function memoryPlatform(): MemoryPlatform {
  const recent: RecentFile[] = [];
  const stored = new Map<string, string>();
  const remembered = new Set<string>();
  const p: MemoryPlatform = {
    kind: "web",
    cloud: true,
    opened: null,
    saved: [],
    folder: "/repo/docs/domain",
    savedFolders: [],
    discard: true,
    openedUrls: [],
    contents: new Map(),
    closeGuards: new Set(),
    origin: "http://test",
    logins: [],
    clearedSessions: 0,
    codes: [],
    completeError: null,
    serverSets: [],
    loginListeners: new Set(),
    emitLoggedIn(result = { ok: true }) {
      p.loginListeners.forEach((l) => l(result));
    },

    async openTextFile() {
      return p.opened;
    },
    async saveTextFile(text, path, suggestedName): Promise<SavedFile | null> {
      p.saved.push({ text, path, name: suggestedName });
      const target = path ?? `/docs/${suggestedName}`;
      p.contents.set(target, text);
      return { path: target, name: baseName(target) };
    },
    async saveTextFiles(files, options) {
      if (p.folder === null) return null;
      p.savedFolders.push({ folder: p.folder, files: files.map((f) => ({ ...f })), options });
      return { where: p.folder, count: files.length };
    },
    canReopenFiles: () => true,
    async confirmDiscard() {
      return p.discard;
    },
    async openExternalUrl(url) {
      p.openedUrls.push(url);
    },
    onCloseRequested(hasUnsavedChanges) {
      p.closeGuards.add(hasUnsavedChanges);
      return () => p.closeGuards.delete(hasUnsavedChanges);
    },

    serverOrigin: () => p.origin,
    async login(provider, returnTo) {
      p.logins.push({ provider, returnTo });
    },
    authorize: async (init) => init,
    async clearSession() {
      p.clearedSessions++;
    },
    async setServerOrigin(url) {
      if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error("http:// か https:// で始まる URL を入れてください");
      p.serverSets.push(url);
      p.origin = new URL(url).origin;
    },
    onLoggedIn(listener) {
      p.loginListeners.add(listener);
      return () => p.loginListeners.delete(listener);
    },
    async completeLoginWithCode(code) {
      p.codes.push(code);
      if (p.completeError) throw new Error(p.completeError);
    },

    secrets: {
      async get(key) {
        return stored.get(key) ?? null;
      },
      async set(key, value, { remember = false } = {}) {
        stored.set(key, value.trim());
        if (remember) remembered.add(key);
        else remembered.delete(key);
      },
      async delete(key) {
        stored.delete(key);
        remembered.delete(key);
      },
      isRemembered: (key) => remembered.has(key),
    },

    recentFiles: {
      async load() {
        return [...recent];
      },
      async add(file) {
        if (!file.path) return;
        const rest = recent.filter((e) => e.path !== file.path);
        recent.splice(0, recent.length, { name: file.name, path: file.path }, ...rest.slice(0, RECENT_LIMIT - 1));
      },
      async remove(file) {
        const rest = recent.filter((e) => e.path !== file.path);
        recent.splice(0, recent.length, ...rest);
      },
      async clear() {
        recent.length = 0;
      },
      async read(file): Promise<OpenedFile> {
        const text = file.path === undefined ? undefined : p.contents.get(file.path);
        if (text === undefined) throw new Error(`${file.path} を読めませんでした`);
        return { path: file.path!, name: baseName(file.path!), text };
      },
    },
  };
  return p;
}

/** いま setPlatform されているテスト用の Platform */
export const memory = () => getPlatform() as MemoryPlatform;
