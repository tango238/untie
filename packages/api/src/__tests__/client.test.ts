import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, parseFilename } from "../client";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    const headers = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  });
  return { fn, calls };
}

const summary = { id: "f1", name: "x", ownerId: "u", ownerName: "U", role: "owner", memberCount: 1, updatedAt: 1, createdAt: 1 };

describe("createApi", () => {
  it("GET には CSRF ヘッダーを付けず、Cookie を送る設定にする", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { id: "u", email: "a@b.c", name: "A" } }));
    const api = createApi({ baseUrl: "https://example.com/", fetch: fn });
    expect((await api.me()).email).toBe("a@b.c");
    expect(calls[0].url).toBe("https://example.com/api/me");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.headers?.["X-Requested-With"]).toBeUndefined();
  });

  it("状態を変える呼び出しに X-Requested-With: untie を付ける", async () => {
    const { fn, calls } = mockFetch(({ init }) => (init.method === "DELETE" ? { status: 204 } : { body: summary }));
    const api = createApi({ baseUrl: "", fetch: fn });
    await api.files.create({ name: "新規" });
    await api.files.rename("f1", "改名");
    await api.files.duplicate("f1");
    await api.files.restore("f1");
    await api.files.trash("f1");
    await api.files.purge("f1");
    await api.logout();
    await api.logoutAll();
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "/api/files"],
      ["PATCH", "/api/files/f1"],
      ["POST", "/api/files/f1/duplicate"],
      ["POST", "/api/files/f1/restore"],
      ["DELETE", "/api/files/f1"],
      ["DELETE", "/api/files/f1/purge"],
      ["POST", "/auth/logout"],
      ["POST", "/auth/logout-all"],
    ]);
    for (const c of calls) expect(c.init.headers?.["X-Requested-With"]).toBe("untie");
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "新規" }));
    expect(calls[0].init.headers?.["Content-Type"]).toBe("application/json");
  });

  it("authorize で Authorization を付けられる", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { providers: ["dev"] } }));
    const api = createApi({
      baseUrl: "",
      fetch: fn,
      authorize: async (init) => ({ ...init, headers: { ...init.headers, Authorization: "Bearer t" } }),
    });
    expect((await api.providers()).providers).toEqual(["dev"]);
    expect(calls[0].init.headers?.Authorization).toBe("Bearer t");
  });

  it("失敗は ApiError で投げる (本文の code と message を持つ)", async () => {
    const { fn } = mockFetch(() => ({ status: 404, body: { error: { code: "not_found", message: "ファイルが見つかりません" } } }));
    const api = createApi({ baseUrl: "", fetch: fn });
    const error = await api.files.get("zzz").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "ファイルが見つかりません" });
  });

  it("本文が JSON でない失敗でも ApiError になる", async () => {
    const { fn } = mockFetch(() => ({ status: 502, text: "bad gateway" }));
    const error = await createApi({ baseUrl: "", fetch: fn }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as ApiError).code).toBeUndefined();
  });

  it("通信できないときは status 0 の ApiError", async () => {
    const fn = vi.fn(async () => {
      throw new Error("offline");
    });
    const error = await createApi({ baseUrl: "", fetch: fn }).me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: "network" });
  });

  it("レスポンスの形が違えば検証で落とす", async () => {
    const { fn } = mockFetch(() => ({ body: { mine: [] } }));
    await expect(createApi({ baseUrl: "", fetch: fn }).files.list()).rejects.toThrow();
  });

  it("書き出しはファイル名を Content-Disposition から取る", async () => {
    const { fn } = mockFetch(() => ({
      text: "{}\n",
      headers: { "Content-Disposition": "attachment; filename=\"export.json\"; filename*=UTF-8''%E5%AE%BF%E6%B3%8A.json" },
    }));
    const api = createApi({ baseUrl: "https://e.com", fetch: fn });
    expect(await api.files.export("f1")).toEqual({ filename: "宿泊.json", text: "{}\n" });
    expect(api.files.exportUrl("f 1")).toBe("https://e.com/api/files/f%201/export");
  });

  it("ゴミ箱の一覧は配列で返す", async () => {
    const { fn } = mockFetch(() => ({ body: { files: [{ ...summary, deletedAt: 5 }] } }));
    const files = await createApi({ baseUrl: "", fetch: fn }).files.trashList();
    expect(files[0].deletedAt).toBe(5);
  });
});

describe("files.ticket", () => {
  it("POST /api/files/:id/ticket を呼び、ticket・role・expiresAt を返す", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { ticket: "a.b.c", role: "editor", expiresAt: 123 } }));
    const result = await createApi({ baseUrl: "https://e.com", fetch: fn }).files.ticket("f 1");
    expect(result).toEqual({ ticket: "a.b.c", role: "editor", expiresAt: 123 });
    expect(calls[0].url).toBe("https://e.com/api/files/f%201/ticket");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-Requested-With"]).toBe("untie");
  });

  it("形の違う返事は拒む", async () => {
    const { fn } = mockFetch(() => ({ body: { ticket: "a.b.c", role: "admin", expiresAt: 1 } }));
    await expect(createApi({ baseUrl: "", fetch: fn }).files.ticket("f1")).rejects.toThrow();
  });
});

describe("共有 (メンバー・譲渡・招待・リンク)", () => {
  const headersOf = (call: Call) => call.init.headers as Record<string, string>;
  const member = { userId: "usr 2", email: "h@e.com", name: "花子", role: "viewer", addedAt: 1 };

  it("メンバーと譲渡: パスと本文と CSRF ヘッダー", async () => {
    const { fn, calls } = mockFetch(({ init }) => {
      if (init.method === "DELETE") return { status: 204 };
      if (init.method === "PUT") return { body: member };
      return { body: summary };
    });
    const api = createApi({ baseUrl: "https://e.com", fetch: fn });
    expect(await api.files.members.put("f 1", "usr 2", "viewer")).toEqual(member);
    await api.files.members.remove("f 1", "usr 2");
    await api.files.transfer("f 1", "usr 2");
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ["PUT", "https://e.com/api/files/f%201/members/usr%202", JSON.stringify({ role: "viewer" })],
      ["DELETE", "https://e.com/api/files/f%201/members/usr%202", undefined],
      ["POST", "https://e.com/api/files/f%201/transfer", JSON.stringify({ userId: "usr 2" })],
    ]);
    for (const c of calls) expect(headersOf(c)["X-Requested-With"]).toBe("untie");
  });

  it("招待: 作る (member / invitation の両方)・取り消す・受ける側", async () => {
    const responses = [
      { body: { kind: "member", userId: "u2" } },
      { body: { kind: "invitation", invitationId: "h", url: "https://e.com/#/invite/tok" } },
      { status: 204 },
      { body: { fileName: "宿泊", role: "editor", email: "h@e.com", inviterName: "太郎", expired: false } },
      { body: { fileId: "f1" } },
    ];
    const { fn, calls } = mockFetch(() => responses.shift()!);
    const api = createApi({ baseUrl: "", fetch: fn });
    expect(await api.files.invitations.create("f1", "h@e.com", "editor")).toEqual({ kind: "member", userId: "u2" });
    expect(await api.files.invitations.create("f1", "n@e.com", "viewer")).toMatchObject({ kind: "invitation", invitationId: "h" });
    await api.files.invitations.remove("f1", "h/1");
    expect((await api.invitations.get("tok/1")).inviterName).toBe("太郎");
    expect(await api.invitations.accept("tok/1")).toEqual({ fileId: "f1" });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "/api/files/f1/invitations"],
      ["POST", "/api/files/f1/invitations"],
      ["DELETE", "/api/files/f1/invitations/h%2F1"],
      ["GET", "/api/invitations/info"],
      ["POST", "/api/invitations/accept"],
    ]);
    // トークンはパスではなく X-Untie-Token ヘッダーで送る (パスは Workers のログに残るため)
    expect(headersOf(calls[3])["X-Untie-Token"]).toBe("tok/1");
    expect(headersOf(calls[4])["X-Untie-Token"]).toBe("tok/1");
    expect(calls[0].init.body).toBe(JSON.stringify({ email: "h@e.com", role: "editor" }));
    expect(headersOf(calls[3])["X-Requested-With"]).toBeUndefined();
    expect(headersOf(calls[4])["X-Requested-With"]).toBe("untie");
  });

  it("リンクの管理: 有効にする (作り直しは regenerate)・無効にする", async () => {
    const { fn, calls } = mockFetch(({ init }) => (init.method === "DELETE" ? { status: 204 } : { body: { enabled: true, url: "https://e.com/#/link/tok" } }));
    const api = createApi({ baseUrl: "", fetch: fn });
    expect((await api.files.link.enable("f1")).url).toBe("https://e.com/#/link/tok");
    await api.files.link.enable("f1", { regenerate: true });
    await api.files.link.disable("f1");
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ["PUT", "/api/files/f1/link", JSON.stringify({})],
      ["PUT", "/api/files/f1/link", JSON.stringify({ regenerate: true })],
      ["DELETE", "/api/files/f1/link", undefined],
    ]);
  });

  it("links.*: 認証ヘッダーがあっても無くても、authorize が失敗しても動く", async () => {
    const { fn, calls } = mockFetch(({ url }) => {
      if (url.endsWith("/ticket")) return { body: { ticket: "a.b.c", role: "guest", expiresAt: 9 } };
      if (url.endsWith("/export")) return { text: "{}\n", headers: { "Content-Disposition": "attachment; filename=\"untie.json\"; filename*=UTF-8''%E5%AE%BF%E6%B3%8A.json" } };
      return { body: { fileId: "f1", name: "宿泊", role: "guest" } };
    });
    // ログインしていないデスクトップ: authorize が投げても、links はゲストとして送る
    const loggedOut = createApi({
      baseUrl: "",
      fetch: fn,
      authorize: async () => {
        throw new Error("ログインしていません");
      },
    });
    expect(await loggedOut.links.get("tok")).toEqual({ fileId: "f1", name: "宿泊", role: "guest" });
    expect((await loggedOut.links.ticket("tok")).role).toBe("guest");
    expect(await loggedOut.links.export("tok")).toEqual({ filename: "宿泊.json", text: "{}\n" });
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
    // ログイン済み: Bearer が付く (メンバーとして扱われる)
    const loggedIn = createApi({ baseUrl: "", fetch: fn, authorize: async (init) => ({ ...init, headers: { ...init.headers, Authorization: "Bearer t" } }) });
    await loggedIn.links.get("tok");
    expect(headersOf(calls[3]).Authorization).toBe("Bearer t");
    expect(calls.map((c) => [c.init.method, c.url]).slice(0, 3)).toEqual([
      ["GET", "/api/links/info"],
      ["POST", "/api/links/ticket"],
      ["GET", "/api/links/export"],
    ]);
    for (const c of calls) expect(headersOf(c)["X-Untie-Token"]).toBe("tok");
    // 複製はログインが要るので、authorize が失敗したらそのまま投げる
    await expect(loggedOut.links.duplicate("tok")).rejects.toThrow("ログインしていません");
    // links 以外は authorize が失敗したらそのまま投げる
    await expect(loggedOut.me()).rejects.toThrow("ログインしていません");
  });
});

describe("links.duplicate", () => {
  it("POST /api/links/duplicate をトークンのヘッダー付きで呼び、FileSummary を返す", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 201, body: summary }));
    const api = createApi({ baseUrl: "", fetch: fn, authorize: async (init) => ({ ...init, headers: { ...init.headers, Authorization: "Bearer t" } }) });
    expect((await api.links.duplicate("tok")).id).toBe("f1");
    expect([calls[0].init.method, calls[0].url]).toEqual(["POST", "/api/links/duplicate"]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Untie-Token"]).toBe("tok");
    expect(headers.Authorization).toBe("Bearer t");
    expect(headers["X-Requested-With"]).toBe("untie");
  });
});

describe("parseFilename", () => {
  it("ヘッダーが無ければ null", () => {
    expect(parseFilename(null)).toBeNull();
    expect(parseFilename("attachment")).toBeNull();
  });
});
