// サーバーの API を型付きで呼ぶクライアント (設計書 2 章・7.4)。fetch だけに依存し、DOM にも Worker にも依存しない。
import {
  FileDetailSchema,
  FileSummarySchema,
  FilesResponseSchema,
  ErrorBodySchema,
  ProvidersResponseSchema,
  TicketResponseSchema,
  TrashResponseSchema,
  UserSchema,
} from "./schemas";
import type { CreateFileRequest, FileDetail, FileSummary, FilesResponse, ProvidersResponse, TicketResponse, User } from "./schemas";

/** サーバーが返したエラー。本文は `{ error: { code, message } }` */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiOptions {
  /** サーバーの URL (例: https://untie.example.com)。空なら同じオリジン */
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * リクエストを出す直前に呼ぶ。デスクトップはここで `Authorization: Bearer` を付ける。
   * Web は Cookie を使うので何もしなくてよい
   */
  authorize?: (init: RequestInit) => Promise<RequestInit>;
}

/** 書き出した JSON */
export interface ExportedFile {
  /** Content-Disposition のファイル名 (なければ id から作る) */
  filename: string;
  text: string;
}

/** 状態を変えるリクエストに付けるヘッダー (CSRF 対策。フォームからは付けられない) */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "untie";

export interface UntieApi {
  me(): Promise<User>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  providers(): Promise<ProvidersResponse>;
  files: {
    list(): Promise<FilesResponse>;
    create(request: CreateFileRequest): Promise<FileSummary>;
    get(id: string): Promise<FileDetail>;
    rename(id: string, name: string): Promise<FileSummary>;
    duplicate(id: string): Promise<FileSummary>;
    /** ブラウザで直接開く書き出しの URL (Cookie 認証のとき、リンクとして使える) */
    exportUrl(id: string): string;
    export(id: string): Promise<ExportedFile>;
    /** ゴミ箱に入れる */
    trash(id: string): Promise<void>;
    restore(id: string): Promise<FileSummary>;
    /** 完全に消す */
    purge(id: string): Promise<void>;
    trashList(): Promise<FileSummary[]>;
    /** ルームに接続するチケット (60 秒だけ有効)。`wss://<host>/parties/untie-room/<id>?ticket=...` でつなぐ */
    ticket(id: string): Promise<TicketResponse>;
  };
}

/** `filename*=UTF-8''...` か `filename="..."` からファイル名を取り出す */
export function parseFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 壊れていれば次の形を試す */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

export function createApi(options: ApiOptions): UntieApi {
  const base = options.baseUrl.replace(/\/+$/, "");
  // 呼び出しのたびに globalThis.fetch を引く (テストでの差し替えと、this の取り違えを避けるため)
  const doFetch = (url: string, init: RequestInit) => (options.fetch ?? fetch)(url, init);

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // GET / HEAD 以外は CSRF 対策のヘッダーを付ける
    if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = CSRF_VALUE;
    // Cookie を送る設定。変数を挟むのは、credentials を持たない型 (Worker) から取り込まれても型検査を通すため
    const initial = { method, headers, credentials: "include" as const };
    let init: RequestInit = initial;
    if (body !== undefined) init.body = JSON.stringify(body);
    if (options.authorize) init = await options.authorize(init);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, init);
    } catch (e) {
      throw new ApiError(0, e instanceof Error ? `サーバーにつながりません: ${e.message}` : "サーバーにつながりません", "network");
    }
    if (!response.ok) throw await toApiError(response);
    return response;
  }

  async function json<T>(schema: { parse(v: unknown): T }, method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
    return schema.parse(await response.json());
  }

  async function empty(method: string, path: string): Promise<void> {
    await send(method, path);
  }

  const file = (id: string) => `/api/files/${encodeURIComponent(id)}`;

  return {
    me: () => json(UserSchema, "GET", "/api/me"),
    logout: () => empty("POST", "/auth/logout"),
    logoutAll: () => empty("POST", "/auth/logout-all"),
    providers: () => json(ProvidersResponseSchema, "GET", "/auth/providers"),
    files: {
      list: () => json(FilesResponseSchema, "GET", "/api/files"),
      create: (request) => json(FileSummarySchema, "POST", "/api/files", request),
      get: (id) => json(FileDetailSchema, "GET", file(id)),
      rename: (id, name) => json(FileSummarySchema, "PATCH", file(id), { name }),
      duplicate: (id) => json(FileSummarySchema, "POST", `${file(id)}/duplicate`),
      exportUrl: (id) => `${base}${file(id)}/export`,
      export: async (id) => {
        const response = await send("GET", `${file(id)}/export`);
        return { filename: parseFilename(response.headers.get("Content-Disposition")) ?? `${id}.json`, text: await response.text() };
      },
      trash: (id) => empty("DELETE", file(id)),
      restore: (id) => json(FileSummarySchema, "POST", `${file(id)}/restore`),
      purge: (id) => empty("DELETE", `${file(id)}/purge`),
      trashList: async () => (await json(TrashResponseSchema, "GET", "/api/files/trash")).files,
      ticket: (id) => json(TicketResponseSchema, "POST", `${file(id)}/ticket`),
    },
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    /* 本文が読めなくても状態だけは伝える */
  }
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) return new ApiError(response.status, parsed.data.error.message, parsed.data.error.code);
  } catch {
    /* JSON でなければ下へ */
  }
  return new ApiError(response.status, `サーバーがエラーを返しました (${response.status})`);
}
