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

describe("parseFilename", () => {
  it("ヘッダーが無ければ null", () => {
    expect(parseFilename(null)).toBeNull();
    expect(parseFilename("attachment")).toBeNull();
  });
});
