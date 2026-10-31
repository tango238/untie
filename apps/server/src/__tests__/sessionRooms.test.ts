// セッションを消したときのルームの切断 (設計書 7.2・7.5)、チケットの 1 回限り、保存できないときの知らせ、長すぎる文字列の切り詰め
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CLOSE_UNAUTHENTICATED, LOGGED_OUT_REASON, SAVE_FAILED_MESSAGE, SAVE_OK_MESSAGE, TICKET_USED_REASON } from "@untie/api";
import { addElement, addRelation, emptyModel, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { getRoots, ORDER_KEY } from "@untie/collab";
import { sha256Hex } from "../auth/crypto";
import { getRoom } from "../rooms";
import { breakUnrepairably, callWorker, env, inRoom, loginAs, resetDb } from "./helpers";
import { closedCode, createFile, join, share, tok, tokenOf } from "./shareHelpers";
import { closeAllClients, connectRoom, expectClient } from "./roomClient";

beforeEach(resetDb);
afterEach(closeAllClients);

const ticketOf = async (client: Awaited<ReturnType<typeof loginAs>>, fileId: string) =>
  (await client.json(`/api/files/${fileId}/ticket`, { method: "POST" })).body.ticket as string;

describe("ログアウトで、そのセッションで開いているルームの接続を閉じる", () => {
  it("POST /auth/logout: そのセッションの接続は 4000「ログアウトしました」で閉じ、同じユーザーの別のセッションの接続は残る", async () => {
    const first = await loginAs("taro@example.com");
    const second = await loginAs("taro@example.com");
    const id = await createFile(first);
    const onFirst = await join(first, id);
    const onSecond = await join(second, id);

    expect((await first.fetch("/auth/logout", { method: "POST" })).status).toBe(204);
    expect(await closedCode(onFirst)).toBe(CLOSE_UNAUTHENTICATED);
    expect(onFirst.closed!.reason).toBe(LOGGED_OUT_REASON);
    // 別のセッションはそのまま使える
    await onSecond.sync();
    expect(onSecond.closed).toBeNull();
  });

  it("ログアウトしたセッションで取ったチケットは、kick のあとに使っても閉じられる (つなぎ直しを防ぐ)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const ticket = await ticketOf(taro, id);
    await taro.fetch("/auth/logout", { method: "POST" });
    const room = expectClient(await connectRoom(id, ticket));
    expect(await closedCode(room)).toBe(CLOSE_UNAUTHENTICATED);
    expect(room.closed!.reason).toBe(LOGGED_OUT_REASON);
  });

  it("POST /auth/logout-all: そのユーザーの全セッションの接続を閉じ、ほかのユーザーの接続は残る", async () => {
    const taro1 = await loginAs("taro@example.com");
    const taro2 = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro1);
    await share(taro1, id, hanako, "editor");
    const a = await join(taro1, id);
    const b = await join(taro2, id);
    const c = await join(hanako, id);

    expect((await taro1.fetch("/auth/logout-all", { method: "POST" })).status).toBe(204);
    expect(await closedCode(a)).toBe(CLOSE_UNAUTHENTICATED);
    expect(await closedCode(b)).toBe(CLOSE_UNAUTHENTICATED);
    expect(a.closed!.reason).toBe(LOGGED_OUT_REASON);
    await c.sync();
    expect(c.closed).toBeNull();
  });

  it("logout-all は、メンバーであるすべてのファイル (共有されたもの・ゴミ箱の中も) のルームに届く", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const mine = await createFile(taro, "自分の");
    const shared = await createFile(hanako, "共有された");
    await share(hanako, shared, taro, "viewer");
    const trashed = await createFile(taro, "ゴミ箱");
    const rooms = [await join(taro, mine), await join(taro, shared), await join(taro, trashed)];
    // ゴミ箱に入れる API は接続も閉じるので、行だけ書き換えて「ゴミ箱の中のファイルのルームに接続が残っている」状態にする
    await env.DB.prepare("update files set deleted_at = ? where id = ?").bind(Date.now(), trashed).run();

    await taro.fetch("/auth/logout-all", { method: "POST" });
    for (const room of rooms) expect(await closedCode(room)).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("ファイルが多いとき (waitUntil で続ける) も、全部のルームの接続が閉じる", async () => {
    const taro = await loginAs("taro@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await createFile(taro, `ファイル ${i}`));
    const rooms = [await join(taro, ids[0]), await join(taro, ids[7])];
    await taro.fetch("/auth/logout-all", { method: "POST" });
    for (const room of rooms) expect(await closedCode(room)).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("セッションが無い・期限切れの logout は、何も閉じず 204", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const room = await join(taro, id);
    const response = await callWorker("/auth/logout", { method: "POST", headers: { Cookie: "untie_session=nothing", "X-Requested-With": "untie" } });
    expect(response.status).toBe(204);
    await room.sync();
    expect(room.closed).toBeNull();
  });

  it("チケットの sid はセッションのハッシュの先頭 16 文字。リンクで開くゲストには付かない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const decode = (ticket: string) => JSON.parse(atob(ticket.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const cookie = taro.cookie.split("=")[1];
    expect(decode(await ticketOf(taro, id)).sid).toBe((await sha256Hex(cookie)).slice(0, 16));

    const link = (await taro.json(`/api/files/${id}/link`, { method: "PUT", json: {} })).body.url as string;
    const guest = await callWorker("/api/links/ticket", { method: "POST", headers: tok(tokenOf(link, "link")) });
    const guestTicket = ((await guest.json()) as { ticket: string }).ticket;
    expect(decode(guestTicket).sid).toBeNull();
    // ログインしているメンバーがリンクで開いたチケットには、セッションの印が付く (ログアウトで閉じられる)
    const asMember = await taro.fetch("/api/links/ticket", { method: "POST", headers: tok(tokenOf(link, "link")) });
    expect(decode(((await asMember.json()) as { ticket: string }).ticket).sid).toBe((await sha256Hex(cookie)).slice(0, 16));
  });
});

describe("チケットは 1 回しか使えない", () => {
  it("同じチケットで 2 回目の接続は 4000「このチケットは使用済みです」で閉じる。1 回目は残る", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const ticket = await ticketOf(taro, id);
    const first = expectClient(await connectRoom(id, ticket));
    await first.sync();
    const second = expectClient(await connectRoom(id, ticket));
    expect(await closedCode(second)).toBe(CLOSE_UNAUTHENTICATED);
    expect(second.closed!.reason).toBe(TICKET_USED_REASON);
    expect(first.closed).toBeNull();
    // 取り直せばつながる (provider は再接続のたびに params でチケットを取り直す)
    const again = expectClient(await connectRoom(id, await ticketOf(taro, id)));
    await again.sync();
    expect(again.closed).toBeNull();
  });

  it("同時に 2 本つないでも通るのは 1 本だけ", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const ticket = await ticketOf(taro, id);
    const [a, b] = (await Promise.all([connectRoom(id, ticket), connectRoom(id, ticket)])).map(expectClient);
    await vi.waitFor(() => expect([a, b].filter((r) => r.closed !== null)).toHaveLength(1));
    const rejected = [a, b].find((r) => r.closed)!;
    expect(rejected.closed).toEqual({ code: CLOSE_UNAUTHENTICATED, reason: TICKET_USED_REASON });
  });

  it("使用済みの記録は期限まで残り、期限を過ぎたものは次の接続で消える", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const stub = await getRoom(env, id);
    await inRoom(stub, async (_room, state) => {
      await state.storage.put("ticket:stale", Date.now() - 1000);
      await state.storage.put("ticket:fresh", Date.now() + 60_000);
    });
    const room = expectClient(await connectRoom(id, await ticketOf(taro, id)));
    await room.sync();
    const keys = await inRoom(stub, async (_room, state) => [...(await state.storage.list({ prefix: "ticket:" })).keys()]);
    expect(keys).toContain("ticket:fresh");
    expect(keys).not.toContain("ticket:stale");
    expect(keys).toHaveLength(2); // fresh と、いま使ったチケット
  });

  it("kick されたチケットは、使用済みにしない (取り消しの記録が先)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const ticket = await ticketOf(taro, id);
    await taro.fetch("/auth/logout", { method: "POST" });
    const room = expectClient(await connectRoom(id, ticket));
    expect(await closedCode(room)).toBe(CLOSE_UNAUTHENTICATED);
    expect(room.closed!.reason).toBe(LOGGED_OUT_REASON);
    const keys = await inRoom(await getRoom(env, id), async (_r, state) => [...(await state.storage.list({ prefix: "ticket:" })).keys()]);
    expect(keys).toEqual([]);
  });
});

/** 作業と担当が関係で結ばれたモデル */
function modelWithRelation(): UntieModel {
  let m = emptyModel("保存");
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error("失敗");
    return r as Extract<T, { ok: true }>;
  };
  m = ok(addElement(m, { kind: "actor", name: "担当", id: "actor_a", boardId: "board_main" })).model;
  m = ok(addElement(m, { kind: "activity", name: "秘密の業務名", id: "act_a", boardId: "board_main" })).model;
  m = ok(addRelation(m, { sourceId: "actor_a", targetId: "act_a", id: "rel_a" })).model;
  return m;
}

describe("保存できないとき (save_failed / save_ok)", () => {
  it("検証に通らず保存できないと save_failed をつながっている全員に送り、直って保存できたら save_ok を送る。あとから入った人にも知らせる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await share(taro, id, hanako, "viewer");
    const a = await join(taro, id);
    const b = await join(hanako, id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = await getRoom(env, id);
    try {
      await inRoom(stub, async (room) => {
        breakUnrepairably(room);
        await room.onSave();
      });
      await vi.waitFor(() => expect(a.custom).toEqual([SAVE_FAILED_MESSAGE]));
      await vi.waitFor(() => expect(b.custom).toEqual([SAVE_FAILED_MESSAGE]));
      // 失敗の記録に名前などの中身を出さない
      expect(error.mock.calls.flat().join("\n")).not.toContain("衝突");

      const late = await join(taro, id);
      await vi.waitFor(() => expect(late.custom).toEqual([SAVE_FAILED_MESSAGE]));

      // 直って保存できたら save_ok
      await inRoom(stub, async (room) => {
        getRoots(room.document).elements.delete([...getRoots(room.document).boards.keys()][0]);
        await room.onSave();
      });
      await vi.waitFor(() => expect(a.custom).toEqual([SAVE_FAILED_MESSAGE, SAVE_OK_MESSAGE]));
      // その後の保存では重ねて送らない
      await inRoom(stub, (room) => room.onSave());
      expect(a.custom).toEqual([SAVE_FAILED_MESSAGE, SAVE_OK_MESSAGE]);
    } finally {
      error.mockRestore();
    }
  });

  it("保存の put が失敗したら console.error に記録し、save_failed を送る。保存済みの内容は壊さない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const room = await join(taro, id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await inRoom(await getRoom(env, id), async (instance, state) => {
        const before = await state.storage.get<UntieModel>("snapshot");
        const put = vi.spyOn(state.storage, "put").mockRejectedValue(new Error("value too large"));
        getRoots(instance.document).meta.set("name", "新しい名前");
        await instance.onSave();
        put.mockRestore();
        expect(await state.storage.get<UntieModel>("snapshot")).toEqual(before);
      });
      await vi.waitFor(() => expect(room.custom).toEqual([SAVE_FAILED_MESSAGE]));
      expect(error.mock.calls.flat().join("\n")).toContain("保存に失敗しました");
    } finally {
      error.mockRestore();
    }
  });
});

describe("長すぎる文字列は要素を外さず切り詰める", () => {
  it("説明 4001 文字の要素が残り、関係も残る。snapshot は検証に通り、save_failed は出ない。ログに中身は出ない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const stub = await getRoom(env, id);
    // 作った空のファイルに、他の端末が書いたように Y.Doc へ直接書く
    const room = await join(taro, id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await inRoom(stub, async (instance, state) => {
        const roots = getRoots(instance.document);
        const model = modelWithRelation();
        instance.document.transact(() => {
          for (const e of model.elements) {
            const ymap = new Y.Map<unknown>();
            for (const [k, v] of Object.entries(e)) if (k !== "id") ymap.set(k, v);
            ymap.set(ORDER_KEY, e.id === "actor_a" ? "a0" : "a1");
            roots.elements.set(e.id, ymap);
          }
          const r = model.relations[0];
          roots.relations.set(r.id, { kind: r.kind, sourceId: r.sourceId, targetId: r.targetId, order: "a0" });
          (roots.elements.get("act_a") as Y.Map<unknown>).set("description", "あ".repeat(4001));
        });
        await instance.onSave();
        const snapshot = (await state.storage.get<UntieModel>("snapshot"))!;
        expect(snapshot.elements.map((e) => e.id).sort()).toEqual(["act_a", "actor_a"]);
        expect(snapshot.relations.map((r) => r.id)).toEqual(["rel_a"]);
        expect(snapshot.elements.find((e) => e.id === "act_a")!.description).toHaveLength(4000);
        expect(validateModel(snapshot).ok).toBe(true);
        // Y.Doc にも切り詰めが書かれている
        expect(((roots.elements.get("act_a") as Y.Map<unknown>).get("description") as string).length).toBe(4000);
      });
      expect(room.custom).toEqual([]);
      const logged = log.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("作業 act_a の説明が長すぎたので切り詰めた");
      expect(logged).not.toContain("秘密の業務名");
    } finally {
      log.mockRestore();
    }
  });
});
