// Web・デスクトップ (Tauri) で実装が変わる処理の受け口。
// 画面とストアは、ここに書いた Platform だけを通してファイル・ダイアログ・キー置き場に触れる。
// 実装は apps/web と apps/desktop にあり、起動時に createApp(platform) が setPlatform で差し込む。
// packages/ui からは @tauri-apps/* を import しない。
import type { ProviderId } from "@untie/api";

/** Untie のモデルファイルの拡張子 */
export const FILE_EXTENSION = "json";

/** 最近開いたファイルに残す件数 */
export const RECENT_LIMIT = 5;

export interface OpenedFile {
  path: string | null;
  name: string;
  text: string;
}

export interface SavedFile {
  path: string | null;
  name: string;
}

export interface RecentFile {
  name: string;
  /** デスクトップ: ファイルのパス */
  path?: string;
  /** Web: File System Access API のハンドル */
  handle?: FileSystemFileHandle;
}

export interface RecentFileStore {
  /** 最近開いたファイル (新しい順に最大 RECENT_LIMIT 件)。読めないときは空 */
  load(): Promise<RecentFile[]>;
  /** 開いた・保存したファイルを先頭に足す。path が無いファイル (まだ保存していない) は足さない */
  add(file: SavedFile): Promise<void>;
  /** 一覧から外す (消えたファイルなど) */
  remove(file: RecentFile): Promise<void>;
  clear(): Promise<void>;
  /** 一覧のファイルを読み直す。Web では、上書き保存できるよう読み書きの許可を求める (メニューのクリックの中で呼ぶ) */
  read(file: RecentFile): Promise<OpenedFile>;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  /** remember は Web だけで使う: true ならこのブラウザに保存し、false ならこのタブの間だけ覚える */
  set(key: string, value: string, options?: { remember?: boolean }): Promise<void>;
  delete(key: string): Promise<void>;
  /** この秘密をブラウザに保存しているか (Web だけ。デスクトップは常に false) */
  isRemembered(key: string): boolean;
}

export interface Platform {
  kind: "web" | "desktop";
  /** ファイルを選んで中身を読む。取り消したら null */
  openTextFile(): Promise<OpenedFile | null>;
  /**
   * 中身を書き出す。path があればそこへ上書きし、無ければ保存先を選ぶ。
   * 保存先を選ぶのを取り消したら null
   */
  saveTextFile(text: string, path: string | null, suggestedName: string): Promise<SavedFile | null>;
  /** 開く・保存する場所をあとから指し直せるか (最近開いたファイルを持てるか) */
  canReopenFiles(): boolean;
  /** 未保存の変更を捨ててよいかを聞く */
  confirmDiscard(message: string, okLabel?: string): Promise<boolean>;
  /** 外部リンクを既定のブラウザで開く */
  openExternalUrl(url: string): Promise<void>;
  /**
   * ウィンドウ (タブ) を閉じる前に、保存していない変更があれば確かめる。戻り値で登録を外す。
   * Web の beforeunload は同期でしか止められないので、確認ではなく「変更があるか」を受け取る
   */
  onCloseRequested(hasUnsavedChanges: () => boolean): () => void;
  /** API キーなどの秘密の置き場 (デスクトップは OS のキーチェーン) */
  secrets: SecretStore;
  recentFiles: RecentFileStore;
  /** サーバーの URL (Web は自分のオリジン、デスクトップは設定したもの)。空文字ならサーバー未設定で、クラウドの機能は使えない */
  serverOrigin(): string;
  /**
   * ログインを始める。Web は同じタブで /auth/login へ移る (戻ってくるときは returnTo の画面)。
   * デスクトップは既定のブラウザを開いて deep link で戻る (別の段階で対応)
   */
  login(provider: ProviderId, returnTo: string): Promise<void>;
  /** セッションの送り方。Web は Cookie なのでそのまま返す。デスクトップはキーチェーンのトークンを Authorization に付ける */
  authorize(init: RequestInit): Promise<RequestInit>;
}

let current: Platform | null = null;

/** 実装を差し込む。createApp(platform) と、テストの setup が呼ぶ */
export function setPlatform(platform: Platform): void {
  current = platform;
}

export function getPlatform(): Platform {
  if (!current) throw new Error("Platform が設定されていません。createApp(platform) から起動してください");
  return current;
}

/** パスの末尾のファイル名 */
export const baseName = (path: string) => path.split(/[\\\\/]/).pop() ?? path;
