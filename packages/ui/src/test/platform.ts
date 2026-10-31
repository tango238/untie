// テスト用の Platform: ファイルもキーも最近開いたファイルもメモリの上で動く。
// setup.ts が各テストの前に新しいものを setPlatform する。テストは memory() で取り出して、状態を仕込む・確かめる。
import {
  RECENT_LIMIT,
  baseName,
  getPlatform,
  type OpenedFile,
  type Platform,
  type RecentFile,
  type SavedFile,
} from "../platform";

export interface MemoryPlatform extends Platform {
  /** openTextFile が返す内容 (null なら取り消し) */
  opened: OpenedFile | null;
  /** saveTextFile で書いた内容 (新しい順ではなく書いた順) */
  saved: { text: string; path: string | null; name: string }[];
  /** confirmDiscard の答え */
  discard: boolean;
  /** openExternalUrl で開いた URL */
  openedUrls: string[];
  /** path ごとのファイルの中身。saveTextFile が書き、recentFiles.read が読む */
  contents: Map<string, string>;
  /** 閉じる前の確認として登録されているもの */
  closeGuards: Set<() => boolean>;
}

export function memoryPlatform(): MemoryPlatform {
  const recent: RecentFile[] = [];
  const stored = new Map<string, string>();
  const remembered = new Set<string>();
  const p: MemoryPlatform = {
    kind: "web",
    opened: null,
    saved: [],
    discard: true,
    openedUrls: [],
    contents: new Map(),
    closeGuards: new Set(),

    async openTextFile() {
      return p.opened;
    },
    async saveTextFile(text, path, suggestedName): Promise<SavedFile | null> {
      p.saved.push({ text, path, name: suggestedName });
      const target = path ?? `/docs/${suggestedName}`;
      p.contents.set(target, text);
      return { path: target, name: baseName(target) };
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
