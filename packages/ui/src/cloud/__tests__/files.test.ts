import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHotelSample } from "@untie/core/sample";
import { memory } from "../../test/platform";
import { apiError, fakeServer, summary, type FakeServer } from "../../test/server";
import { safeFileName, serializeModel } from "../../io/document";
import { emptyModel } from "@untie/core/model/types";
import { notifyUnauthorized } from "../api";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { saveLocalToCloud, useFilesStore } from "../files";

let server: FakeServer;
const files = () => useFilesStore.getState();
const toasts = () => useUntieStore.getState().toasts.map((t) => `${t.tone}:${t.message}`);
const callsOf = () => server.calls.map((c) => `${c.method} ${c.path}`);

beforeEach(() => {
  resetStore();
  useFilesStore.getState().reset();
  server = fakeServer({
    mine: [summary({ id: "a", name: "A" }), summary({ id: "b", name: "B" })],
    shared: [summary({ id: "s", name: "S", role: "viewer", ownerId: "u2", ownerName: "他の人" })],
    trash: [summary({ id: "t", name: "T", deletedAt: Date.now() })],
  });
});
afterEach(() => server.restore());

describe("files.refresh", () => {
  it("一覧とゴミ箱を読む", async () => {
    await files().refresh();
    expect(files().mine.map((f) => f.id)).toEqual(["a", "b"]);
    expect(files().shared.map((f) => f.id)).toEqual(["s"]);
    expect(files().trash.map((f) => f.id)).toEqual(["t"]);
    expect(files().loading).toBe(false);
    expect(files().error).toBeNull();
    expect(callsOf().sort()).toEqual(["GET /api/files", "GET /api/files/trash"]);
  });

  it("失敗したら error に入れ、トーストを出す", async () => {
    server.overrides["GET /api/files"] = () => apiError(500, "internal", "サーバーでエラーが起きました");
    await files().refresh();
    expect(files().error).toBe("サーバーでエラーが起きました");
    expect(files().loading).toBe(false);
    expect(toasts()).toEqual(["error:サーバーでエラーが起きました"]);
  });
});

describe("files の操作", () => {
  it("create({ name }) は POST /api/files に name を送り、一覧を読み直す", async () => {
    const created = await files().create({ name: "新しい" });
    expect(created?.name).toBe("新しい");
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!;
    expect(post.body).toEqual({ name: "新しい" });
    expect(post.headers["X-Requested-With"]).toBe("untie");
    expect(files().mine[0]!.name).toBe("新しい");
    expect(toasts()).toEqual(["info:クラウドに「新しい」を作りました"]);
  });

  it("create({ model }) は model を送る", async () => {
    const model = createHotelSample();
    await files().create({ model });
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!;
    expect((post.body as { model: { meta: { name: string } } }).model.meta.name).toBe(model.meta.name);
  });

  it("create の失敗は ApiError の message をそのままトーストに出し、null を返す", async () => {
    server.overrides["POST /api/files"] = () => apiError(400, "invalid_model", "モデルの検証に失敗しました");
    expect(await files().create({ name: "x" })).toBeNull();
    expect(toasts()).toEqual(["error:モデルの検証に失敗しました"]);
    // 失敗したときは一覧を読み直さない
    expect(callsOf()).not.toContain("GET /api/files");
  });

  it("rename は PATCH /api/files/:id に name を送る", async () => {
    expect(await files().rename("a", "改名")).toBe(true);
    const patch = server.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/api/files/a");
    expect(patch.body).toEqual({ name: "改名" });
    expect(files().mine.find((f) => f.id === "a")!.name).toBe("改名");
  });

  it("rename の失敗 (権限なし) はトーストに出して false", async () => {
    server.overrides["PATCH /api/files/s"] = () => apiError(403, "forbidden", "この操作をする権限がありません");
    expect(await files().rename("s", "x")).toBe(false);
    expect(toasts()).toEqual(["error:この操作をする権限がありません"]);
  });

  it("trashFile は DELETE /api/files/:id。ゴミ箱の一覧に移る", async () => {
    expect(await files().trashFile("a")).toBe(true);
    expect(callsOf()).toContain("DELETE /api/files/a");
    expect(files().mine.map((f) => f.id)).toEqual(["b"]);
    expect(files().trash.map((f) => f.id)).toEqual(["a", "t"]);
  });

  it("trashFile の失敗はトーストに出し、一覧は変えない", async () => {
    await files().refresh();
    server.overrides["DELETE /api/files/a"] = () => apiError(404, "file_not_found", "ファイルが見つかりません");
    expect(await files().trashFile("a")).toBe(false);
    expect(toasts()).toEqual(["error:ファイルが見つかりません"]);
    expect(files().mine.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("restore は POST /restore、purge は DELETE /purge", async () => {
    await files().restore("t");
    expect(callsOf()).toContain("POST /api/files/t/restore");
    expect(files().mine.map((f) => f.id)).toContain("t");
    await files().purge("a");
    expect(callsOf()).toContain("DELETE /api/files/a/purge");
  });

  it("duplicate は POST /duplicate して一覧に増える", async () => {
    const copy = await files().duplicate("a");
    expect(callsOf()).toContain("POST /api/files/a/duplicate");
    expect(copy?.name).toBe("A のコピー");
    expect(files().mine.map((f) => f.name)).toContain("A のコピー");
  });

  it("exportToFile は JSON を取って saveTextFile (保存先は選ばせる) に渡す", async () => {
    expect(await files().exportToFile("a")).toBe(true);
    expect(callsOf()).toContain("GET /api/files/a/export");
    const expected = { ...emptyModel(), meta: { ...emptyModel().meta, name: "A" } };
    expect(memory().saved).toEqual([{ text: serializeModel(expected), path: null, name: "A.json" }]);
    expect(toasts()).toEqual(["info:「A.json」に書き出しました"]);
  });

  it("exportToFile は中身を検証し、壊れていたら日本語のトーストを出して書き出さない", async () => {
    await files().refresh();
    server.overrides["GET /api/files/a/export"] = () => new Response("{\"meta\": 1}");
    expect(await files().exportToFile("a")).toBe(false);
    expect(memory().saved).toEqual([]);
    expect(toasts()[0]).toMatch(/^error:「A」を書き出せません: /);
  });

  it("exportToFile のファイル名から、使えない文字と改行などの制御文字を取り除く", async () => {
    server.mine = [summary({ id: "a", name: "a/b:c\n\"d\"\u0007.txt" })];
    await files().refresh();
    await files().exportToFile("a");
    expect(memory().saved[0]!.name).toBe("a_b_c_d_.txt.json");
  });

  it("exportToFile の保存先選びを取り消したら false (トーストなし)", async () => {
    memory().saveTextFile = async () => null;
    expect(await files().exportToFile("a")).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("exportToFile の失敗はトーストに出す", async () => {
    server.overrides["GET /api/files/a/export"] = () => apiError(404, "file_not_found", "ファイルが見つかりません");
    expect(await files().exportToFile("a")).toBe(false);
    expect(toasts()).toEqual(["error:ファイルが見つかりません"]);
  });

  it("モデルの名前が空なら「名前なし」にして送る", async () => {
    const model = createHotelSample();
    await files().create({ model: { ...model, meta: { ...model.meta, name: "  " } } });
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!;
    expect((post.body as { model: { meta: { name: string } } }).model.meta.name).toBe("名前なし");
    expect(toasts()).toEqual(["info:クラウドに「名前なし」を作りました"]);
  });

  it("401 を受けると (セッション切れ) 一覧を空にする", async () => {
    await files().refresh();
    expect(files().mine).toHaveLength(2);
    server.signedIn = false;
    await files().rename("a", "x");
    expect(files().mine).toEqual([]);
    expect(files().loaded).toBe(false);
    // ログアウトの通知でも空になる
    server.signedIn = true;
    await files().refresh();
    notifyUnauthorized();
    expect(files().mine).toEqual([]);
  });

  it("editor は名前を変えられるがゴミ箱へは入れられない (403 の文言をそのまま出す)", async () => {
    server.shared = [summary({ id: "e", name: "E", role: "editor", ownerId: "u2" })];
    expect(await files().rename("e", "E2")).toBe(true);
    expect(await files().trashFile("e")).toBe(false);
    expect(toasts()).toEqual(["error:この操作をする権限がありません"]);
  });

  it("reset で一覧が空に戻る", async () => {
    await files().refresh();
    files().reset();
    expect(files().mine).toEqual([]);
    expect(files().trash).toEqual([]);
  });
});

describe("safeFileName", () => {
  it("使えない文字は _ に、制御文字は取り除く。空なら untie", () => {
    expect(safeFileName("a\\b/c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeFileName("a\nb\r\tc\u0000d\u007f")).toBe("abcd");
    expect(safeFileName(" \n ")).toBe("untie");
    expect(safeFileName("あ".repeat(150))).toHaveLength(100);
  });
});

describe("saveLocalToCloud", () => {
  it("編集中のモデルを POST /api/files に model として送る", async () => {
    const model = useUntieStore.getState().model;
    const created = await saveLocalToCloud();
    expect(created).not.toBeNull();
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/api/files")!;
    expect((post.body as { model: { meta: { name: string } } }).model.meta.name).toBe(model.meta.name);
    // ローカルの編集はそのまま
    expect(useUntieStore.getState().model).toBe(model);
    expect(toasts()).toEqual([`info:クラウドに「${model.meta.name}」を作りました`]);
  });
});
