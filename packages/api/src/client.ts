// サーバーの API を型付きで呼ぶクライアント (設計書 2 章・7.4)。fetch だけに依存し、DOM にも Worker にも依存しない。
import {
  AcceptInvitationResponseSchema,
  CreateInvitationResponseSchema,
  FileDetailSchema,
  FileSummarySchema,
  FilesResponseSchema,
  ErrorBodySchema,
  InvitationInfoSchema,
  LinkInfoSchema,
  LinkResponseSchema,
  MemberSchema,
  ProvidersResponseSchema,
  TicketResponseSchema,
  TrashResponseSchema,
  UserSchema,
} from "./schemas";
import type {
  AcceptInvitationResponse,
  CreateFileRequest,
  CreateInvitationResponse,
  FileDetail,
  FileSummary,
  FilesResponse,
  InvitationInfo,
  InviteRole,
  LinkInfo,
  LinkResponse,
  Member,
  ProvidersResponse,
  TicketResponse,
  User,
} from "./schemas";

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

/**
 * リンク・招待のトークンを運ぶヘッダー。トークンを URL のパスに置くと Workers のログに残るため、ヘッダーで送る。
 * (画面の `/#/link/<token>`・`/#/invite/<token>` はハッシュなのでサーバーには届かない)
 */
export const TOKEN_HEADER = "X-Untie-Token";

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
    /** メンバーの管理 (owner)。外すのは自分なら editor / viewer もできる */
    members: {
      /** 役割を足す・変える。相手がユーザーでなければ 404 (`user_not_found`)。役割が変わるとその人の接続は切れる */
      put(id: string, userId: string, role: InviteRole): Promise<Member>;
      remove(id: string, userId: string): Promise<void>;
    };
    /** 所有者を譲る (元の所有者は editor になる)。返すのは譲った人から見たファイル */
    transfer(id: string, userId: string): Promise<FileSummary>;
    /** メールでの招待 (owner) */
    invitations: {
      create(id: string, email: string, role: InviteRole): Promise<CreateInvitationResponse>;
      remove(id: string, invitationId: string): Promise<void>;
    };
    /** リンク閲覧の管理 (owner)。URL は作成・作り直しの応答でだけ返る */
    link: {
      enable(id: string, options?: { regenerate?: boolean }): Promise<LinkResponse>;
      disable(id: string): Promise<void>;
    };
  };
  /** 招待を受ける側 (ログイン必須)。token は招待 URL (`/#/invite/<token>`) のトークンで、`X-Untie-Token` ヘッダーで送る */
  invitations: {
    get(token: string): Promise<InvitationInfo>;
    accept(token: string): Promise<AcceptInvitationResponse>;
  };
  /**
   * リンクを知っている人の閲覧 (3.6)。セッションが無くても通る。
   * 認証ヘッダーがあればメンバーとして扱われ、無い (または付けられない) ときはゲストになる。トークンは `X-Untie-Token` ヘッダーで送る
   */
  links: {
    get(token: string): Promise<LinkInfo>;
    ticket(token: string): Promise<TicketResponse>;
    export(token: string): Promise<ExportedFile>;
    /** 複製して自分の owner のファイルにする。ログインが要る (ゲストのままなら 401) */
    duplicate(token: string): Promise<FileSummary>;
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

  async function send(method: string, path: string, body?: unknown, extra: { optionalAuth?: boolean; token?: string } = {}): Promise<Response> {
    const optionalAuth = extra.optionalAuth ?? false;
    const headers: Record<string, string> = { Accept: "application/json" };
    // リンク・招待のトークンはパスではなくヘッダーで送る (パスは Workers のログに残る)
    if (extra.token !== undefined) headers[TOKEN_HEADER] = extra.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // GET / HEAD 以外は CSRF 対策のヘッダーを付ける
    if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = CSRF_VALUE;
    // Cookie を送る設定。変数を挟むのは、credentials を持たない型 (Worker) から取り込まれても型検査を通すため
    const initial = { method, headers, credentials: "include" as const };
    let init: RequestInit = initial;
    if (body !== undefined) init.body = JSON.stringify(body);
    if (options.authorize) {
      try {
        init = await options.authorize(init);
      } catch (e) {
        // リンク閲覧は認証が無くても通る。ヘッダーを付けられない (ログインしていない) ときはゲストとして送る
        if (!optionalAuth) throw e;
      }
    }
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, init);
    } catch (e) {
      throw new ApiError(0, e instanceof Error ? `サーバーにつながりません: ${e.message}` : "サーバーにつながりません", "network");
    }
    if (!response.ok) throw await toApiError(response);
    return response;
  }

  async function json<T>(schema: { parse(v: unknown): T }, method: string, path: string, body?: unknown, extra?: { optionalAuth?: boolean; token?: string }): Promise<T> {
    const response = await send(method, path, body, extra);
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
      members: {
        put: (id, userId, role) => json(MemberSchema, "PUT", `${file(id)}/members/${encodeURIComponent(userId)}`, { role }),
        remove: (id, userId) => empty("DELETE", `${file(id)}/members/${encodeURIComponent(userId)}`),
      },
      transfer: (id, userId) => json(FileSummarySchema, "POST", `${file(id)}/transfer`, { userId }),
      invitations: {
        create: (id, email, role) => json(CreateInvitationResponseSchema, "POST", `${file(id)}/invitations`, { email, role }),
        remove: (id, invitationId) => empty("DELETE", `${file(id)}/invitations/${encodeURIComponent(invitationId)}`),
      },
      link: {
        enable: (id, options = {}) => json(LinkResponseSchema, "PUT", `${file(id)}/link`, options.regenerate ? { regenerate: true } : {}),
        disable: (id) => empty("DELETE", `${file(id)}/link`),
      },
    },
    invitations: {
      get: (token) => json(InvitationInfoSchema, "GET", "/api/invitations/info", undefined, { token }),
      accept: (token) => json(AcceptInvitationResponseSchema, "POST", "/api/invitations/accept", undefined, { token }),
    },
    links: {
      get: (token) => json(LinkInfoSchema, "GET", "/api/links/info", undefined, { token, optionalAuth: true }),
      ticket: (token) => json(TicketResponseSchema, "POST", "/api/links/ticket", undefined, { token, optionalAuth: true }),
      export: async (token) => {
        const response = await send("GET", "/api/links/export", undefined, { token, optionalAuth: true });
        return { filename: parseFilename(response.headers.get("Content-Disposition")) ?? "untie.json", text: await response.text() };
      },
      duplicate: (token) => json(FileSummarySchema, "POST", "/api/links/duplicate", undefined, { token }),
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
