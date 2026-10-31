import { beforeEach, describe, expect, it } from "vitest";
import { getRoots } from "@untie/collab";
import { getRoom } from "../rooms";
import { validateModel } from "@untie/core";
import { hotelSample } from "@untie/core/sample";
import { createApi } from "@untie/api";
import { callWorker, env, inRoom, loginAs, resetDb, userIdOf } from "./helpers";
import type { Client, Json } from "./helpers";

beforeEach(resetDb);

async function create(client: Client, json: unknown) {
  return client.json("/api/files", { method: "POST", json });
}

/** メンバー行を D1 に直接足す (共有の API は次の段階) */
async function addMember(fileId: string, userId: string, role: "editor" | "viewer") {
  await env.DB.prepare("insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)")
    .bind(fileId, userId, role, null, Date.now())
    .run();
}

describe("作成", () => {
  it("{ name } で空のモデルのファイルを作る。作った人が owner", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const { status, body } = await create(taro, { name: "宿泊の業務" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "宿泊の業務", ownerName: "太郎", role: "owner", memberCount: 1 });
    expect(body.id).toMatch(/^[\w-]{21}$/);
    expect(body.updatedAt).toBeGreaterThan(0);
    const member = await env.DB.prepare("select role from file_members where file_id = ?").bind(body.id).first();
    expect(member).toEqual({ role: "owner" });

    // 書き出すと、名前とボード 1 枚だけの空のモデル
    const exported = await taro.json(`/api/files/${body.id}/export`);
    expect(exported.body).toMatchObject({ version: 1, meta: { name: "宿泊の業務" }, elements: [], relations: [] });
    expect(exported.body.boards).toHaveLength(1);
  });

  it("{ model } で JSON を取り込む", async () => {
    const taro = await loginAs("taro@example.com");
    const { status, body } = await create(taro, { model: hotelSample });
    expect(status).toBe(201);
    expect(body.name).toBe(hotelSample.meta.name);
    const exported = (await taro.json(`/api/files/${body.id}/export`)).body;
    expect(exported.elements).toHaveLength(hotelSample.elements.length);
    expect(exported.relations).toHaveLength(hotelSample.relations.length);
    expect(exported.boards.map((b: Json) => b.id)).toEqual(hotelSample.boards.map((b) => b.id));
  });

  it("不正な model・形の違うリクエスト・JSON でない本文は 400", async () => {
    const taro = await loginAs("taro@example.com");
    const bad = await create(taro, { model: { version: 1, meta: { name: "x" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_model");
    expect(bad.body.error.message).toContain("モデルの形が正しくありません");

    // 参照整合性に反するモデル (存在しない要素を指す関係)
    const dangling = {
      ...hotelSample,
      relations: [...hotelSample.relations, { id: "rel_zzzzzz", kind: "performs", sourceId: "act_missing", targetId: "act_none" }],
    };
    expect((await create(taro, { model: dangling })).status).toBe(400);

    expect((await create(taro, {})).status).toBe(400);
    expect((await create(taro, { name: "" })).status).toBe(400);
    expect((await create(taro, { name: "x", model: {} })).status).toBe(400);
    const notJson = await taro.json("/api/files", { method: "POST", body: "not json", headers: { "Content-Type": "application/json" } });
    expect(notJson.status).toBe(400);
    expect(notJson.body.error.code).toBe("invalid_request");
    // 失敗したものは一覧に残らない
    expect((await taro.json("/api/files")).body.mine).toHaveLength(0);
  });
});

describe("入力の上限と失敗時の後始末", () => {
  it("2 MB を超える本文は POST /files も PATCH も 413", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { name: "A" })).body;
    const huge = JSON.stringify({ name: "x".repeat(3 * 1024 * 1024) });
    const headers = { "Content-Type": "application/json", "Content-Length": String(huge.length) };
    const post = await taro.json("/api/files", { method: "POST", body: huge, headers });
    expect(post.status).toBe(413);
    expect(post.body.error.code).toBe("too_large");
    expect((await taro.json(`/api/files/${file.id}`, { method: "PATCH", body: huge, headers })).status).toBe(413);
    expect((await taro.json("/api/files")).body.mine).toHaveLength(1);
  });

  it("ルームへの取り込みに失敗したら、destroy してから D1 の行を消し、500 を返す", async () => {
    const calls: string[] = [];
    const fakeNamespace = {
      idFromName: (name: string) => name,
      get: () => ({
        setName: async () => {},
        importModel: async () => {
          calls.push("import");
          throw new Error("取り込みに失敗");
        },
        destroy: async () => {
          calls.push("destroy");
        },
      }),
    };
    const taro = await loginAs("taro@example.com", "", { UntieRoom: fakeNamespace as never });
    const response = await taro.json("/api/files", { method: "POST", json: { name: "失敗する" } });
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("internal");
    expect(calls).toEqual(["import", "destroy"]);
    expect((await env.DB.prepare("select count(*) as n from files").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("select count(*) as n from file_members").first<{ n: number }>())!.n).toBe(0);
  });

  it("複製: ルームの中身が検証に通らなければ 500 ではなく 409 broken_model", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { model: hotelSample })).body;
    // 他の端末が、スキーマの上限を超える名前を入れた状態 (repair では直らない)
    await inRoom(await getRoom(env, file.id), (room) => {
      getRoots(room.document).meta.set("name", "x".repeat(5000));
    });
    const { status, body } = await taro.json(`/api/files/${file.id}/duplicate`, { method: "POST" });
    expect(status).toBe(409);
    expect(body.error.code).toBe("broken_model");
    expect((await taro.json("/api/files")).body.mine).toHaveLength(1);
  });
});

describe("一覧・詳細", () => {
  it("mine は自分のファイル、shared は共有されたファイル。ゴミ箱の中は含めない", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const a = (await create(taro, { name: "A" })).body;
    const b = (await create(taro, { name: "B" })).body;
    const c = (await create(hanako, { name: "C" })).body;
    await addMember(a.id, await userIdOf(hanako), "editor");
    await taro.fetch(`/api/files/${b.id}`, { method: "DELETE" });

    const taroList = (await taro.json("/api/files")).body;
    expect(taroList.mine.map((f: Json) => f.name)).toEqual(["A"]);
    expect(taroList.mine[0]).toMatchObject({ role: "owner", memberCount: 2 });
    expect(taroList.shared).toEqual([]);

    const hanakoList = (await hanako.json("/api/files")).body;
    expect(hanakoList.mine.map((f: Json) => f.id)).toEqual([c.id]);
    expect(hanakoList.shared).toHaveLength(1);
    expect(hanakoList.shared[0]).toMatchObject({ id: a.id, name: "A", role: "editor", ownerName: "太郎", memberCount: 2 });
  });

  it("詳細: メンバー一覧は owner だけが受け取る", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const hanako = await loginAs("hanako@example.com", "花子");
    const file = (await create(taro, { name: "A" })).body;
    await addMember(file.id, await userIdOf(hanako), "viewer");

    const owner = (await taro.json(`/api/files/${file.id}`)).body;
    expect(owner.members).toEqual([expect.objectContaining({ email: "taro@example.com", name: "太郎", role: "owner" }), expect.objectContaining({ email: "hanako@example.com", role: "viewer" })]);
    const viewer = (await hanako.json(`/api/files/${file.id}`)).body;
    expect(viewer).toMatchObject({ id: file.id, role: "viewer" });
    expect(viewer.members).toBeUndefined();
  });

  it("他人のファイル・存在しない id は 404", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const file = (await create(taro, { name: "A" })).body;
    for (const [method, path] of [
      ["GET", ""],
      ["PATCH", ""],
      ["POST", "/duplicate"],
      ["GET", "/export"],
      ["DELETE", ""],
      ["POST", "/restore"],
      ["DELETE", "/purge"],
    ]) {
      const response = await hanako.json(`/api/files/${file.id}${path}`, { method, json: method === "PATCH" ? { name: "x" } : undefined });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect(response.body.error.code).toBe("file_not_found");
    }
    expect((await taro.json("/api/files/nonexistent")).status).toBe(404);
  });
});

describe("名前の変更", () => {
  it("PATCH でルームの meta.name と D1 の両方が変わる", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { name: "旧名" })).body;
    const { status, body } = await taro.json(`/api/files/${file.id}`, { method: "PATCH", json: { name: "新名" } });
    expect(status).toBe(200);
    expect(body.name).toBe("新名");
    expect((await taro.json(`/api/files/${file.id}`)).body.name).toBe("新名");
    expect((await taro.json(`/api/files/${file.id}/export`)).body.meta.name).toBe("新名");
    expect((await taro.json(`/api/files/${file.id}`, { method: "PATCH", json: { name: " " } })).status).toBe(400);
  });
});

describe("書き出し", () => {
  it("JSON を 2 スペース整形で返し、Content-Disposition に UTF-8 のファイル名が付く。validateModel を通る", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { model: hotelSample })).body;
    const response = await taro.fetch(`/api/files/${file.id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toMatch(/^attachment; filename="untie.json"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(`${hotelSample.meta.name}.json`);

    const text = await response.text();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    const result = validateModel(JSON.parse(text));
    expect(result.ok).toBe(true);
    // $schema・order など Y.Doc の内部の項目が漏れない
    expect(text).not.toContain('"order"');
  });

  it("ファイル名に使えない文字は置き換える", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { name: 'a/b:c*"d' })).body;
    const disposition = (await taro.fetch(`/api/files/${file.id}/export`)).headers.get("Content-Disposition")!;
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe("a_b_c__d.json");
  });
});

describe("複製", () => {
  it("中身を写して自分の owner のファイルを作る (元は変わらない)", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com", "花子");
    const file = (await create(taro, { model: hotelSample })).body;
    await addMember(file.id, await userIdOf(hanako), "viewer");

    // viewer でも複製できる
    const { status, body } = await hanako.json(`/api/files/${file.id}/duplicate`, { method: "POST" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: `${hotelSample.meta.name} のコピー`, role: "owner", ownerName: "花子", memberCount: 1 });
    expect(body.id).not.toBe(file.id);

    const copy = (await hanako.json(`/api/files/${body.id}/export`)).body;
    expect(copy.elements).toHaveLength(hotelSample.elements.length);
    expect(validateModel(copy).ok).toBe(true);
    expect((await taro.json(`/api/files/${file.id}`)).body.name).toBe(hotelSample.meta.name);
    // 取り込んだ人以外には見えない
    expect((await taro.json(`/api/files/${body.id}`)).status).toBe(404);
  });
});

describe("役割ごとの権限", () => {
  it("editor は名前を変えられるが、ゴミ箱・復元・完全削除はできない (403)。viewer は名前も変えられない", async () => {
    const taro = await loginAs("taro@example.com");
    const editor = await loginAs("editor@example.com");
    const viewer = await loginAs("viewer@example.com");
    const file = (await create(taro, { name: "A" })).body;
    await addMember(file.id, await userIdOf(editor), "editor");
    await addMember(file.id, await userIdOf(viewer), "viewer");

    expect((await editor.json(`/api/files/${file.id}`, { method: "PATCH", json: { name: "編集者が変更" } })).status).toBe(200);
    expect((await viewer.json(`/api/files/${file.id}`, { method: "PATCH", json: { name: "x" } })).status).toBe(403);

    for (const client of [editor, viewer]) {
      for (const [method, path] of [
        ["DELETE", ""],
        ["POST", "/restore"],
        ["DELETE", "/purge"],
      ]) {
        const response = await client.json(`/api/files/${file.id}${path}`, { method });
        expect([client.email, method, path, response.status]).toEqual([client.email, method, path, 403]);
        expect(response.body.error.code).toBe("forbidden");
      }
      expect((await client.fetch(`/api/files/${file.id}/export`)).status).toBe(200);
    }
    expect((await taro.json(`/api/files/${file.id}`)).body.name).toBe("編集者が変更");
    expect((await taro.json("/api/files/trash")).body.files).toEqual([]);
  });
});

describe("ゴミ箱", () => {
  it("ゴミ箱に入れる → 一覧から消えて trash に出る → 戻す → 完全に消す", async () => {
    const taro = await loginAs("taro@example.com");
    const file = (await create(taro, { model: hotelSample })).body;

    expect((await taro.fetch(`/api/files/${file.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await taro.json("/api/files")).body.mine).toEqual([]);
    const trash = (await taro.json("/api/files/trash")).body.files;
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: file.id, role: "owner" });
    expect(trash[0].deletedAt).toBeGreaterThan(0);

    const restored = await taro.json(`/api/files/${file.id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(restored.body.deletedAt).toBeUndefined();
    expect((await taro.json("/api/files")).body.mine.map((f: Json) => f.id)).toEqual([file.id]);
    expect((await taro.json("/api/files/trash")).body.files).toEqual([]);
    // 戻した中身はそのまま
    expect((await taro.json(`/api/files/${file.id}/export`)).body.elements).toHaveLength(hotelSample.elements.length);

    // ゴミ箱に入れずに完全削除はできない
    const early = await taro.json(`/api/files/${file.id}/purge`, { method: "DELETE" });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_in_trash");

    await taro.fetch(`/api/files/${file.id}`, { method: "DELETE" });
    expect((await taro.fetch(`/api/files/${file.id}/purge`, { method: "DELETE" })).status).toBe(204);
    expect((await taro.json(`/api/files/${file.id}`)).status).toBe(404);
    expect((await taro.json("/api/files/trash")).body.files).toEqual([]);
    for (const table of ["files", "file_members"]) {
      expect((await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())!.n).toBe(0);
    }
  });

  it("ゴミ箱の中のファイルは owner 以外には 404", async () => {
    const taro = await loginAs("taro@example.com");
    const editor = await loginAs("editor@example.com");
    const file = (await create(taro, { name: "A" })).body;
    await addMember(file.id, await userIdOf(editor), "editor");
    await taro.fetch(`/api/files/${file.id}`, { method: "DELETE" });

    expect((await editor.json(`/api/files/${file.id}`)).status).toBe(404);
    expect((await editor.json(`/api/files/${file.id}/export`)).status).toBe(404);
    expect((await editor.json("/api/files")).body.shared).toEqual([]);
    // owner からは見える
    expect((await taro.json(`/api/files/${file.id}`)).status).toBe(200);
  });
});

describe("@untie/api のクライアントから", () => {
  it("createApi が実際の Worker と話せる", async () => {
    const taro = await loginAs("taro@example.com", "太郎");
    const api = createApi({
      baseUrl: "http://localhost",
      fetch: ((url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Cookie", taro.cookie);
        return callWorker(new URL(url).pathname, { ...init, headers });
      }) as typeof fetch,
    });
    expect((await api.me()).name).toBe("太郎");
    const created = await api.files.create({ name: "API から" });
    expect((await api.files.list()).mine.map((f) => f.id)).toEqual([created.id]);
    expect((await api.files.rename(created.id, "改名")).name).toBe("改名");
    const copy = await api.files.duplicate(created.id);
    expect(copy.name).toBe("改名 のコピー");
    const exported = await api.files.export(created.id);
    expect(exported.filename).toBe("改名.json");
    expect(JSON.parse(exported.text).meta.name).toBe("改名");
    await api.files.trash(created.id);
    expect((await api.files.trashList()).map((f) => f.id)).toEqual([created.id]);
    expect((await api.files.restore(created.id)).deletedAt).toBeUndefined();
    await api.files.trash(created.id);
    await api.files.purge(created.id);
    const error = await api.files.get(created.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ApiError", status: 404, code: "file_not_found" });
    await api.logout();
    expect((await api.me().catch((e: unknown) => e)) instanceof Error).toBe(true);
  });
});
