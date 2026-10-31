import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { emptyModel, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { hotelSample } from "@untie/core/sample";
import { getRoots } from "@untie/collab";
import { SNAPSHOT_KEEP } from "@untie/collab/room";
import { getRoom } from "../rooms";
import { env, inRoom, resetDb } from "./helpers";
import { evictDurableObject } from "cloudflare:test";

let counter = 0;
const newId = () => `room-test-${Date.now()}-${counter++}`;

/** RPC の型変換でタプル型が崩れるので、モデルは cast して渡す・受ける */
async function openRoom(id: string) {
  const room = await getRoom(env, id);
  return {
    room,
    importModel: async (model: UntieModel) => {
      await room.importModel(model as never);
    },
    exportModel: async () => (await room.exportModel()) as unknown as UntieModel,
  };
}

async function insertFileRow(id: string, name: string, updatedAt = 1) {
  await env.DB.batch([
    env.DB.prepare("insert or ignore into users (id, email, name, created_at) values ('usr_room', 'room@example.com', 'ルーム', 1)"),
    env.DB.prepare("insert into files (id, name, owner_id, created_at, updated_at) values (?, ?, 'usr_room', 1, ?)").bind(id, name, updatedAt),
  ]);
}

describe("UntieRoom の RPC", () => {
  it("importModel → exportModel で往復する (validateModel を通る)", async () => {
    const id = newId();
    const { importModel, exportModel } = await openRoom(id);
    await importModel(hotelSample);
    const exported = await exportModel();
    expect(validateModel(exported).ok).toBe(true);
    expect(exported.meta).toEqual(hotelSample.meta);
    expect(exported.elements.map((e) => e.id)).toEqual(hotelSample.elements.map((e) => e.id));
    expect(exported.relations.map((r) => r.id)).toEqual(hotelSample.relations.map((r) => r.id));
    expect(exported.boards.map((b) => b.id)).toEqual(hotelSample.boards.map((b) => b.id));
  });

  it("2 回目の importModel は拒む (中身は変わらない)", async () => {
    const { importModel, exportModel } = await openRoom(newId());
    await importModel(emptyModel("最初"));
    await expect(importModel(emptyModel("二回目"))).rejects.toThrow("既に中身があります");
    expect((await exportModel()).meta.name).toBe("最初");
  });

  it("Doc も snapshot も無いルーム (取り込み前) の exportModel は例外", async () => {
    const { exportModel } = await openRoom(newId());
    await expect(exportModel()).rejects.toThrow("中身がありません");
  });

  it("不正なモデルの importModel は拒む", async () => {
    const { importModel, exportModel } = await openRoom(newId());
    await expect(importModel({ version: 1, meta: { name: "x" } } as never)).rejects.toThrow("モデルの形が正しくありません");
    await expect(exportModel()).rejects.toThrow();
  });

  it("別のインスタンスに落ちても ydoc から戻る (永続化)", async () => {
    const id = newId();
    const { room, importModel } = await openRoom(id);
    await importModel(hotelSample);
    // 保存されたキー
    const keys = await inRoom(room, async (_i, state) => [...(await state.storage.list()).keys()].sort());
    expect(keys.some((k) => /^snapshot:\d{4}-/.test(k))).toBe(false);
    expect(keys).toContain("ydoc");
    expect(keys).toContain("snapshot");
    // 保存した ydoc から別の Y.Doc を組み立て直せる
    const saved = await inRoom(room, (_i, state) => state.storage.get<Uint8Array>("ydoc"));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, saved!);
    expect(getRoots(doc).meta.get("name")).toBe(hotelSample.meta.name);
  });

  it("rename は meta.name を書いてすぐ保存する (インスタンスが作り直されても名前が残る)", async () => {
    const { room, importModel, exportModel } = await openRoom(newId());
    await importModel(emptyModel("旧"));
    await room.rename("新");
    expect((await exportModel()).meta.name).toBe("新");
    await evictDurableObject(room);
    // 作り直されたインスタンスは ydoc から戻る
    expect((await exportModel()).meta.name).toBe("新");
    const saved = await inRoom(room, (_i, state) => state.storage.get<UntieModel>("snapshot"));
    expect(saved!.meta.name).toBe("新");
  });

  it("destroy のあとは空 (exportModel は例外)で、ストレージも空。遅れて来る保存は何も書かない", async () => {
    const id = newId();
    const { room, importModel, exportModel } = await openRoom(id);
    await importModel(hotelSample);
    await room.destroy();
    await expect(exportModel()).rejects.toThrow("中身がありません");
    expect(await room.listSnapshots()).toEqual([]);
    await inRoom(room, async (instance, state) => {
      await instance.onSave();
      expect([...(await state.storage.list()).keys()]).toEqual([]);
    });
  });
});

describe("onSave", () => {
  it("D1 の files.name と updated_at を更新する。行が無ければ何もしない", async () => {
    await resetDb();
    const id = newId();
    await insertFileRow(id, "古い名前", 1);
    const { room, importModel } = await openRoom(id);
    const before = Date.now();
    await importModel(emptyModel("ルームでの名前"));
    const row = await env.DB.prepare("select name, updated_at from files where id = ?").bind(id).first<{ name: string; updated_at: number }>();
    expect(row!.name).toBe("ルームでの名前");
    expect(row!.updated_at).toBeGreaterThanOrEqual(before);

    // 行の無いルーム (取り込みの途中や削除後) でも落ちない
    const orphan = await openRoom(newId());
    await expect(orphan.importModel(emptyModel("孤児"))).resolves.toBeUndefined();
    expect(room).toBeDefined();
  });

  it("壊れた参照は保存の前に直す", async () => {
    const { room, importModel, exportModel } = await openRoom(newId());
    await importModel(emptyModel("壊れる"));
    await inRoom(room, async (instance, state) => {
      // 存在しない要素を指す関係を、他の端末が足したことにする
      getRoots(instance.document).relations.set("rel_broken", { kind: "performs", sourceId: "act_x", targetId: "buc_x", order: "a0" } as never);
      await instance.onSave();
      // 保存した snapshot に壊れた関係は入らない
      const snapshot = (await state.storage.get<UntieModel>("snapshot"))!;
      expect(snapshot.relations).toEqual([]);
      expect(getRoots(instance.document).relations.has("rel_broken")).toBe(false);
    });
    expect((await exportModel()).relations).toEqual([]);
  });

  it("検証に通らない中身は ydoc も snapshot も書かず、console.error に記録する", async () => {
    const { room, importModel } = await openRoom(newId());
    await importModel(emptyModel("正常"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await inRoom(room, async (instance, state) => {
        const ydocBefore = await state.storage.get<Uint8Array>("ydoc");
        // スキーマの上限を超える名前にする (repair では直らず、検証に通らない)
        getRoots(instance.document).meta.set("name", "x".repeat(5000));
        await instance.onSave();
        expect(await state.storage.get<Uint8Array>("ydoc")).toEqual(ydocBefore);
        expect((await state.storage.get<UntieModel>("snapshot"))!.meta.name).toBe("正常");
      });
      expect(error).toHaveBeenCalled();
      expect(String(error.mock.calls[0][0])).toContain("検証に通らない");
    } finally {
      error.mockRestore();
    }
  });

  it("スナップショットは 1 時間に 1 件。その時間の最初の保存の直前の状態を残す", async () => {
    const { room, importModel } = await openRoom(newId());
    await importModel(emptyModel("最初"));
    // 取り込みが最初の保存。直前の状態が無いので、まだ残すものが無い
    expect(await room.listSnapshots()).toEqual([]);

    // この時間の最初の保存 (rename) の直前 = 取り込んだ状態が残る
    await room.rename("一回目の変更");
    const [first] = await room.listSnapshots();
    expect(first).toMatch(/^snapshot:\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect(((await room.getSnapshot(first)) as unknown as UntieModel).meta.name).toBe("最初");

    // 同じ時間の 2 回目以降の保存では上書きしない
    await room.rename("二回目の変更");
    expect(await room.listSnapshots()).toEqual([first]);
    expect(((await room.getSnapshot(first)) as unknown as UntieModel).meta.name).toBe("最初");

    // 最新の snapshot は常に最後の状態
    const latest = await inRoom(room, (_i, state) => state.storage.get<UntieModel>("snapshot"));
    expect(latest!.meta.name).toBe("二回目の変更");
  });

  it("スナップショットは直近 24 件まで残し、古いものを消す", async () => {
    const { room, importModel } = await openRoom(newId());
    await importModel(emptyModel("最初"));
    // 古いスナップショットが 30 件あっても、保存のあとは新しい 24 件だけになる
    await inRoom(room, async (_i, state) => {
      for (let h = 1; h <= 30; h++) await state.storage.put(`snapshot:2020-01-01T${String(h % 24).padStart(2, "0")}:00:00.${String(h).padStart(3, "0")}Z`, emptyModel());
    });
    await room.rename("もう一度");
    const keys = await room.listSnapshots();
    expect(keys).toHaveLength(SNAPSHOT_KEEP);
    // 新しい順。この時間のキーが先頭、いちばん古い 7 件が消える
    expect(keys[0]).toMatch(/^snapshot:20(2[6-9]|[3-9]\d)-/);
    expect(keys).not.toContain("snapshot:2020-01-01T01:00:00.001Z");
    expect(await room.getSnapshot("snapshot:2020-01-01T01:00:00.001Z")).toBeNull();
    expect(await room.getSnapshot("ydoc")).toBeNull();
  });
});

describe("閲覧専用", () => {
  it("owner と editor 以外 (viewer・guest・役割なし) の接続は書き込みを捨てる (isReadOnly)", async () => {
    const { room } = await openRoom(newId());
    await inRoom(room, (instance) => {
      const connection = (role?: string) => ({ state: role ? { role } : null }) as never;
      expect(instance.isReadOnly(connection("viewer"))).toBe(true);
      expect(instance.isReadOnly(connection("guest"))).toBe(true);
      expect(instance.isReadOnly(connection("editor"))).toBe(false);
      expect(instance.isReadOnly(connection("owner"))).toBe(false);
      // 役割が無い接続・知らない役割は読み取り専用
      expect(instance.isReadOnly(connection())).toBe(true);
      expect(instance.isReadOnly(connection("admin"))).toBe(true);
      expect(instance.isReadOnly({ state: undefined } as never)).toBe(true);
    });
  });
});
