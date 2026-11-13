// Platform の Tauri (デスクトップ) 実装。
// ファイルはダイアログとネイティブのファイル操作 (Rust のコマンド)、API キーとログインのトークンは OS のキーチェーン、
// 最近開いたファイルはパスを localStorage に置く。ログインは既定のブラウザ + deep link (設計書 7.3・8.4)。
import { invoke } from "@tauri-apps/api/core";
import { DesktopExchangeResponseSchema, ErrorBodySchema, type ProviderId } from "@untie/api";
import {
  FILE_EXTENSION,
  RECENT_LIMIT,
  baseName,
  type OpenedFile,
  type LoginResult,
  type Platform,
  type RecentFile,
  type RecentFileStore,
  type SavedFile,
  type SecretStore,
  parseServerOrigin,
} from "@untie/ui/platform";
import { pickSourceFolderInBrowser } from "@untie/ui/io/sourceFolder";

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

// ---- 秘密 (OS のキーチェーン。Rust 側の get_secret / set_secret / delete_secret) ----

// key は AI のプロバイダー ID (claude / codex / gemini) と、ログインのトークンの "session"。Rust 側が知っているものだけ受け付ける
const secrets: SecretStore = {
  async get(key) {
    return (await invoke<string | null>("get_secret", { name: key })) ?? null;
  },
  async set(key, value) {
    await invoke("set_secret", { name: key, value });
  },
  async delete(key) {
    await invoke("delete_secret", { name: key });
  },
  // ブラウザに保存する、という選択肢はデスクトップには無い
  isRemembered: () => false,
};

// ---- Platform ----

/** サーバーの URL を置く localStorage のキー */
const SERVER_ORIGIN_KEY = "untie.serverOrigin";
/** ログインのトークンをしまうキーチェーンの名前 (Rust 側の許可リストにある) */
const SESSION_KEY = "session";
/** ログインを始めたときの記録 (state・戻り先・サーバー) を置く sessionStorage のキー */
const LOGIN_KEY = "untie.desktopLogin";
/** ログインを始めてから、戻りを受け付ける時間。ブラウザでの Google のログイン (アカウントの選択・2 段階認証) に余裕を持たせる */
const LOGIN_TTL_MS = 15 * 60 * 1000;

/** deep link の URL の頭: untie://auth/callback (hostname などの解釈は OS の URL の扱いに依るので、文字列で比べる) */
const CALLBACK_PREFIX = "untie://auth/callback";

const NO_RECORD_MESSAGE = "ログインの記録がありません。もう一度ログインしてください";
const EXPIRED_MESSAGE = "時間切れです。もう一度ログインしてください";

/**
 * 保存しているサーバーの URL。無い・読めない・http(s) でないときは空 (サーバー未設定)。
 * 読むときは、設定で検めたものに限らず (手で書き換えた localStorage でも) パスなどを落として http(s) のオリジンにする
 */
function storedServerOrigin(): string {
  try {
    const url = new URL(localStorage.getItem(SERVER_ORIGIN_KEY) ?? "");
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.origin : "";
  } catch {
    return "";
  }
}

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** state に使う乱数 (base64url の 32 文字。サーバーは 16〜128 文字の英数字と `-` `_` を受ける) */
function randomState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** PKCE (RFC 7636 / RFC 8252): verifier は 32 バイトの乱数 (43 文字)、challenge = base64url(sha256(verifier)) */
async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
}

/** ログインを始めたときの記録。deep link で戻ってきたとき、state の照合と、交換先のサーバー・戻り先・PKCE の verifier に使う */
interface PendingLogin {
  state: string;
  /** PKCE の code_verifier。サーバーには challenge だけを渡し、交換のときに verifier を送る */
  verifier: string;
  returnTo: string;
  /** ログインを始めたサーバー。交換はここに送る */
  origin: string;
  at: number;
}

/** 記録の読み出し結果: あった / 無い (または壊れている) / 期限切れ */
type PendingRead = { kind: "ok"; pending: PendingLogin } | { kind: "none" } | { kind: "expired" };

function readPending(): PendingRead {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LOGIN_KEY) ?? "null") as Partial<PendingLogin> | null;
    if (!raw || typeof raw.state !== "string" || typeof raw.verifier !== "string" || typeof raw.origin !== "string" || typeof raw.at !== "number") {
      return { kind: "none" };
    }
    if (Date.now() - raw.at > LOGIN_TTL_MS) return { kind: "expired" };
    return { kind: "ok", pending: { state: raw.state, verifier: raw.verifier, origin: raw.origin, at: raw.at, returnTo: typeof raw.returnTo === "string" ? raw.returnTo : "#/" } };
  } catch {
    return { kind: "none" };
  }
}

function writePending(pending: PendingLogin | null): void {
  try {
    if (pending) sessionStorage.setItem(LOGIN_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(LOGIN_KEY);
  } catch {
    // 記録できないと戻りを受けられないが、ログインの開始そのものは止めない(引換コードの入力も記録が要るので、その旨は交換のときに伝える)
  }
}

/**
 * deep link の URL から code と state を取り出す。untie://auth/callback 以外は null。
 * OS によって URL の hostname / pathname の解釈が違うので (非標準のスキーム)、頭は文字列で比べ、クエリだけ URL で読む
 */
function parseCallback(raw: string): { code: string; state: string } | null {
  if (raw.slice(0, CALLBACK_PREFIX.length).toLowerCase() !== CALLBACK_PREFIX) return null;
  const rest = raw.slice(CALLBACK_PREFIX.length);
  if (rest !== "" && !/^[/?#]/.test(rest)) return null;
  try {
    const { searchParams } = new URL(raw);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    return code && state ? { code, state } : null;
  } catch {
    return null;
  }
}

/** サーバーの応答からエラーの文言を取る (`{ error: { message } }`) */
async function errorMessageOf(response: Response): Promise<string> {
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // 本文が JSON でなければ状態だけ伝える
  }
  return `ログインを完了できませんでした (${response.status})`;
}

async function confirmDiscard(message: string, okLabel = "破棄して続ける"): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "Untie", kind: "warning", okLabel, cancelLabel: "キャンセル" });
}

export function desktopPlatform(): Platform {
  // キーチェーンのトークンの写し (undefined はまだ読んでいない)。API を呼ぶたびにキーチェーンを読まないため
  let sessionToken: string | null | undefined;
  const loginListeners = new Set<(result: LoginResult) => void>();
  // 交換に使った (使っている) 引換コード。同じ deep link が重ねて届いても 1 度しか交換しない
  const handledCodes = new Set<string>();
  let listening: Promise<void> | null = null;
  // 「ログインの記録がありません」を知らせたか (deep link が何度届いても 1 度だけ。ログインを始めたら戻す)
  let noRecordNotified = false;

  const notify = (result: LoginResult) => loginListeners.forEach((l) => l(result));

  async function clearSession(): Promise<void> {
    await secrets.delete(SESSION_KEY);
    sessionToken = null;
  }

  /** 引換コードをトークンに交換してキーチェーンに置き、戻り先の画面へ移る。失敗したら Error */
  async function exchangeAndStore(pending: PendingLogin, code: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${pending.origin}/auth/desktop/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state: pending.state, code_verifier: pending.verifier }),
        // デスクトップは Cookie を使わない
        credentials: "omit",
      });
    } catch (e) {
      throw new Error(`サーバーにつながりません: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok) throw new Error(await errorMessageOf(response));
    const { token } = DesktopExchangeResponseSchema.parse(await response.json());
    // 交換している間にサーバーの URL が変わった (setServerOrigin は記録を消す) ら、このトークンは古いサーバーのもの。
    // 新しいサーバーに送ってしまわないよう、保存しない
    const current = readPending();
    if (storedServerOrigin() !== pending.origin || current.kind !== "ok" || current.pending.state !== pending.state) {
      throw new Error("ログインの手続きが取り消されたか、サーバーの設定が変わりました。もう一度ログインしてください");
    }
    await secrets.set(SESSION_KEY, token);
    sessionToken = token;
    writePending(null);
    // 戻り先 (ハッシュ)。ホーム (#/) のままなら動かさない
    if (pending.returnTo.startsWith("#") && pending.returnTo !== window.location.hash) window.location.hash = pending.returnTo;
  }

  /** deep link で受けた code と state を照合して交換する。結果は onLoggedIn の購読者へ知らせる */
  async function finishFromDeepLink(urls: string[]): Promise<void> {
    for (const raw of urls) {
      const callback = parseCallback(raw);
      if (!callback) continue;
      // 交換した (している) コードがもう一度届いても何もしない。記録は交換で消えているので、先に見る
      if (handledCodes.has(callback.code)) continue;
      const read = readPending();
      if (read.kind === "none") {
        // 新しく起動されたなどで、始めたログインの記録が無い。黙って捨てず、1 度だけ知らせる
        if (!noRecordNotified) {
          noRecordNotified = true;
          notify({ ok: false, message: NO_RECORD_MESSAGE });
        }
        continue;
      }
      if (read.kind === "expired") {
        notify({ ok: false, message: EXPIRED_MESSAGE });
        continue;
      }
      // state が違う戻りは受けない (他のアプリや悪意のある deep link を拒む)
      if (read.pending.state !== callback.state) {
        notify({ ok: false, message: "このアプリが始めたログインではありません。もう一度ログインしてください" });
        continue;
      }
      handledCodes.add(callback.code);
      try {
        await exchangeAndStore(read.pending, callback.code);
        notify({ ok: true });
      } catch (e) {
        // つながらなかっただけなら、同じ deep link をもう一度開けるように
        handledCodes.delete(callback.code);
        notify({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** deep link の受け取りを始める (1 度だけ)。アプリが deep link で起動された場合 (getCurrent) も扱う。失敗しても引換コードの経路は残る */
  function ensureListening(): Promise<void> {
    listening ??= (async () => {
      try {
        const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
        await onOpenUrl((urls) => void finishFromDeepLink(urls));
        const current = await getCurrent();
        if (current && current.length > 0) await finishFromDeepLink(current);
      } catch (e) {
        console.warn("deep link を受け取れません。ログインは引換コードを貼って終えてください", e);
      }
    })();
    return listening;
  }

  return {
    kind: "desktop",
    // サーバーの URL を設定すれば、クラウド版のサーバーにつないでクラウドファイルを使える
    cloud: true,

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

    async saveTextFiles(files, { keep = [] }) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ multiple: false, directory: true, title: "書き出すフォルダを選ぶ" });
      if (typeof dir !== "string") return null;
      // 選ばれたフォルダの区切りに合わせる (Windows は \)
      const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
      const base = dir.endsWith(sep) ? dir : dir + sep;
      const kept: string[] = [];
      for (const f of files) {
        // ファイル名だけを受ける (フォルダの外へ書かない)
        if (/[\\/]/.test(f.name) || f.name === ".." || f.name === ".") throw new Error(`書き出せない名前です: ${f.name}`);
        if (keep.includes(f.name)) {
          // 既にあれば残す (読めれば、ある)
          const exists = await invoke<string>("read_model_file", { path: base + f.name }).then(
            () => true,
            () => false,
          );
          if (exists) {
            kept.push(f.name);
            continue;
          }
        }
        await invoke("write_model_file", { path: base + f.name, contents: f.text });
      }
      return { where: dir, count: files.length - kept.length, kept };
    },

    pickSourceFolder: pickSourceFolderInBrowser,

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

    // 設定したサーバーの URL (オリジン)。無い・読めない・http(s) でないときは空 (サーバー未設定)
    serverOrigin: storedServerOrigin,

    // 検めて保存し、キーチェーンのトークンを消す(別のサーバーにトークンを送らない)。消せなければ URL も変えない
    async setServerOrigin(url) {
      const origin = parseServerOrigin(url);
      await clearSession();
      writePending(null);
      localStorage.setItem(SERVER_ORIGIN_KEY, origin);
    },

    // 既定のブラウザで /auth/login を開く。戻りは deep link (untie://auth/callback) か、貼られた引換コード
    async login(provider: ProviderId, returnTo: string) {
      const origin = storedServerOrigin();
      if (!origin) throw new Error("サーバーが設定されていません。先にサーバーの URL を設定してください");
      await ensureListening();
      const state = randomState();
      const { verifier, challenge } = await newPkce();
      writePending({ state, verifier, returnTo, origin, at: Date.now() });
      noRecordNotified = false;
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      // PKCE: サーバーには challenge だけを渡す。verifier は記録に置いて、交換のときに送る
      await openUrl(`${origin}/auth/login?provider=${provider}&client=desktop&state=${state}&code_challenge=${challenge}`);
    },

    onLoggedIn(listener) {
      loginListeners.add(listener);
      void ensureListening();
      return () => loginListeners.delete(listener);
    },

    // deep link が開けない環境向け: ブラウザの画面に出た引換コード (deep link の URL ごとでもよい) を貼って終える
    async completeLoginWithCode(code) {
      const read = readPending();
      if (read.kind === "expired") throw new Error(EXPIRED_MESSAGE);
      if (read.kind === "none") throw new Error("先に「ログイン」を押してください。ブラウザでログインしたあとに出る引換コードを貼ります");
      const pasted = code.trim();
      const fromUrl = parseCallback(pasted);
      const value = fromUrl ? fromUrl.code : pasted;
      if (!value) throw new Error("引換コードを貼ってください");
      handledCodes.add(value);
      try {
        await exchangeAndStore(read.pending, value);
      } catch (e) {
        // 失敗したコードは、直して(つながるようになって)もう一度試せるように
        handledCodes.delete(value);
        throw e;
      }
      notify({ ok: true });
    },

    // トークンがあれば Authorization: Bearer を足す(元のヘッダーはそのまま残す)。デスクトップは Cookie を使わない
    async authorize(init) {
      if (sessionToken === undefined) sessionToken = await secrets.get(SESSION_KEY);
      const next: RequestInit = { ...init, credentials: "omit" };
      if (sessionToken) {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${sessionToken}`);
        next.headers = headers;
      }
      return next;
    },

    clearSession,
  };
}
