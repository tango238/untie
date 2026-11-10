// Web・デスクトップ (Tauri) で実装が変わる処理の受け口。
// 画面とストアは、ここに書いた Platform だけを通してファイル・ダイアログ・キー置き場に触れる。
// 実装は apps/web (Web 版とクラウド版で共用) と apps/desktop にあり、起動時に createApp(platform) が setPlatform で差し込む。
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

/** ブラウザでのログインが deep link か引換コードで終わった知らせ (デスクトップ)。失敗は state の不一致・コードの期限切れなど */
export type LoginResult = { ok: true } | { ok: false; message: string };

/** まとめて書き出すファイル (name はフォルダの中のファイル名) */
export interface TextFile {
  name: string;
  text: string;
}

export interface Platform {
  kind: "web" | "desktop";
  /**
   * クラウドの機能 (ログイン・クラウドファイル・共有・同時編集) を画面に出すか。
   * Web 版 (apps/web。ローカル専用) は false、クラウド版 (apps/cloud) とデスクトップは true。
   * false なら、ホームにクラウドの欄を出さず、#/f・#/invite・#/link はホームに戻す
   */
  cloud: boolean;
  /** ファイルを選んで中身を読む。取り消したら null */
  openTextFile(): Promise<OpenedFile | null>;
  /**
   * 中身を書き出す。path があればそこへ上書きし、無ければ保存先を選ぶ。
   * 保存先を選ぶのを取り消したら null
   */
  saveTextFile(text: string, path: string | null, suggestedName: string): Promise<SavedFile | null>;
  /**
   * 複数のテキストファイルを、選んだフォルダへ書き出す (ドメインモデルの書き出し。同じ名前のファイルは上書きする)。
   * フォルダを選べない環境 (File System Access API の無いブラウザ) では、zipName の zip にまとめてダウンロードする (中のフォルダは zipFolder)。
   * where は書き出した先の名前 (フォルダか zip)。取り消したら null
   */
  saveTextFiles(files: readonly TextFile[], options: { zipName: string; zipFolder: string }): Promise<{ where: string; count: number } | null>;
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
  /** サーバーの URL (クラウド版は自分のオリジン、デスクトップは設定したもの、Web 版は空文字)。空文字ならサーバー未設定で、クラウドの機能は使えない */
  serverOrigin(): string;
  /**
   * ログインを始める。Web は同じタブで /auth/login へ移る (戻ってくるときは returnTo の画面)。
   * デスクトップは既定のブラウザを開いて deep link で戻る (設計書 7.3)。ブラウザを開けたところで解決し、終わったことは onLoggedIn で知らせる
   */
  login(provider: ProviderId, returnTo: string): Promise<void>;
  /** セッションの送り方。Web は Cookie なのでそのまま返す。デスクトップはキーチェーンのトークンを Authorization に付ける */
  authorize(init: RequestInit): Promise<RequestInit>;
  /**
   * 手元に持っているセッションを消す。ログアウトのあとに呼ぶ (サーバーの行を消すのは API の logout)。
   * Web の Cookie はサーバーが消すので何もしない。デスクトップはキーチェーンのトークンを消す
   */
  clearSession(): Promise<void>;
  /**
   * サーバーの URL を変える (デスクトップだけ)。http(s) の URL でなければ Error を投げる。
   * 変えるとセッションは消える (別のサーバーにトークンを送らないため)。Web は自分のオリジンなので無い
   */
  setServerOrigin?(url: string): Promise<void>;
  /**
   * ブラウザのログインが終わったときの知らせを受ける (デスクトップ。deep link か、completeLoginWithCode で終わったとき)。
   * 受けたら画面は `session.load()` する。戻り値で購読を外す。Web は同じタブで戻ってくるので無い
   */
  onLoggedIn?(listener: (result: LoginResult) => void): () => void;
  /**
   * 引換コードを貼ってログインを終える (デスクトップ)。deep link が開けない環境で、ブラウザの画面に出たコードを使う。
   * 失敗したら理由を Error で投げる (画面に出す)
   */
  completeLoginWithCode?(code: string): Promise<void>;
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

/** http で使ってよいホスト (開発用のサーバー)。それ以外は https だけ */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * サーバーの URL を検めてオリジンにする (デスクトップの設定。設計書 8.4)。
 * https の URL か、開発用の http://localhost・http://127.0.0.1 だけ。ユーザー名・パスワード・パス・クエリ・ハッシュ付きは拒む。
 * 末尾のスラッシュだけは許す。通らなければ画面に出せる文言の Error
 */
export function parseServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("サーバーの URL が正しくありません。http:// か https:// で始まる URL (例: https://untie.example.com) を入れてください");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("サーバーの URL は http:// か https:// で始まる URL を入れてください");
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("サーバーの URL に http:// を使えるのは localhost と 127.0.0.1 だけです。https:// の URL を入れてください");
  }
  if (url.username || url.password) throw new Error("サーバーの URL にユーザー名やパスワードは入れられません");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("サーバーの URL にパスやクエリは付けられません。https://untie.example.com のように、サーバーのアドレスだけを入れてください");
  }
  return url.origin;
}

/** パスの末尾のファイル名 */
export const baseName = (path: string) => path.split(/[\\\\/]/).pop() ?? path;
