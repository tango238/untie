import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UntieModel } from "@untie/core";
import { applyModelDiff, rebuildModel } from "@untie/collab";
import { CLOSE_LINK_DISABLED, CLOSE_REMOVED, CLOSE_ROLE_CHANGED, ROOM_HEADERS } from "@untie/api";
import { issueTicket } from "../auth/ticket";
import type { TicketClaims } from "../auth/ticket";
import { getRoom } from "../rooms";
import { callWorker, env, loginAs, resetDb, userIdOf } from "./helpers";

/** workerd の時計は I/O や待ちで進む。kick の時刻より後に発行したチケットにするため、少し待つ */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
import type { Client } from "./helpers";
import { awarenessMessage, closeAllClients, connectRoom, expectClient } from "./roomClient";
import type { RoomClient } from "./roomClient";

beforeEach(resetDb);
afterEach(closeAllClients);

async function addMember(fileId: string, userId: string, role: "editor" | "viewer") {
  await env.DB.prepare("insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)")
    .bind(fileId, userId, role, null, Date.now())
    .run();
}

/** ファイルを作る (中身は空のモデル) */
async function createFile(owner: Client): Promise<string> {
  return (await owner.json("/api/files", { method: "POST", json: { name: "ルーム" } })).body.id;
}

async function ticketFor(client: Client, fileId: string): Promise<string> {
  return (await client.json(`/api/files/${fileId}/ticket`, { method: "POST" })).body.ticket;
}

/** チケットの発行から接続、手元の Doc がサーバーと同期するまで */
async function join(client: Client, fileId: string): Promise<RoomClient> {
  const room = expectClient(await connectRoom(fileId, await ticketFor(client, fileId)));
  await room.sync();
  return room;
}

async function joinWith(fileId: string, claims: Omit<TicketClaims, "fileId">): Promise<RoomClient> {
  const { ticket } = await issueTicket(env, { fileId, ...claims });
  const room = expectClient(await connectRoom(fileId, ticket));
  await room.sync();
  return room;
}

/** 手元の Doc に要素を 1 つ足す (要素の追加が update としてサーバーへ送られる) */
function addActor(room: RoomClient, id: string): void {
  const before = rebuildModel(room.doc);
  const after: UntieModel = { ...before, elements: [...before.elements, { id, kind: "actor", name: id }] };
  applyModelDiff(room.doc, before, after, "local");
}

const elementIds = async (fileId: string) => ((await (await getRoom(env, fileId)).currentModel()) as unknown as UntieModel).elements.map((e) => e.id);

describe("接続の認証", () => {
  it("正しいチケットで 101 (WebSocket が開く)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const room = await join(taro, id);
    expect(room.closed).toBeNull();
    expect(await (await getRoom(env, id)).presence()).toEqual([{ userId: await userIdOf(taro), name: expect.any(String), role: "owner" }]);
  });

  it("チケット無し・偽造・期限切れは 401 (invalid_ticket)", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const real = await ticketFor(taro, id);
    const forged = real.slice(0, -3) + (real.endsWith("AAA") ? "BBB" : "AAA");
    const { ticket: expired } = await issueTicket(env, { fileId: id, userId: "usr_x", name: "x", role: "owner", via: "member" }, Date.now() - 120_000);
    for (const ticket of [null, "", "でたらめ", forged, expired]) {
      const result = await connectRoom(id, ticket);
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);
      expect((await response.json<any>()).error.code).toBe("invalid_ticket");
    }
  });

  it("別のファイルのチケットでは 403", async () => {
    const taro = await loginAs("taro@example.com");
    const a = await createFile(taro);
    const b = await createFile(taro);
    const response = (await connectRoom(b, await ticketFor(taro, a))) as Response;
    expect(response.status).toBe(403);
    expect((await response.json<any>()).error.code).toBe("forbidden");
  });

  it("HTTP (Upgrade 無し) は 401。ルームへの HTTP は使わない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const ticket = await ticketFor(taro, id);
    for (const path of [`/parties/untie-room/${id}`, `/parties/untie-room/${id}?ticket=${ticket}`]) {
      const response = await callWorker(path);
      expect(response.status).toBe(401);
      expect((await response.json<any>()).error.code).toBe("unauthenticated");
    }
  });

  it("クライアントが偽の x-untie-* ヘッダーを付けても、チケットの中身で上書きされる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "viewer");
    const response = await callWorker(`/parties/untie-room/${id}?ticket=${encodeURIComponent(await ticketFor(hanako, id))}`, {
      headers: { Upgrade: "websocket", [ROOM_HEADERS.role]: "owner", [ROOM_HEADERS.user]: "usr_other", [ROOM_HEADERS.via]: "link" },
    });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    const [entry] = await (await getRoom(env, id)).presence();
    expect(entry).toMatchObject({ userId: await userIdOf(hanako), role: "viewer" });
    response.webSocket!.close(1000, "終了");
  });

  it("ゲストが偽の x-untie-user を付けても、チケットの中身 (userId なし) で上書きされる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const { ticket } = await issueTicket(env, { fileId: id, userId: null, name: "ゲスト", role: "guest", via: "link" });
    const response = await callWorker(`/parties/untie-room/${id}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Upgrade: "websocket", [ROOM_HEADERS.user]: await userIdOf(taro) },
    });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    const room = await getRoom(env, id);
    expect(await room.presence()).toEqual([{ userId: null, name: "ゲスト 1", role: "guest" }]);
    // 偽の userId を指す kick にも掛からない
    expect(await room.kick({ userId: await userIdOf(taro) })).toBe(0);
    response.webSocket!.close(1000, "終了");
  });

  it("名前は URL エンコードされて届き、日本語のまま presence に出る", async () => {
    const taro = await loginAs("taro@example.com", "山田 太郎 🍣");
    const id = await createFile(taro);
    await join(taro, id);
    expect((await (await getRoom(env, id)).presence())[0].name).toBe("山田 太郎 🍣");
  });
});

describe("接続 id (_pk)", () => {
  it("クライアントが同じ _pk で 2 本つないでも、別の接続として扱われ、kick で両方閉じる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    const first = expectClient(await connectRoom(id, await ticketFor(hanako, id), "_pk=same-id"));
    const second = expectClient(await connectRoom(id, await ticketFor(hanako, id), "_pk=same-id"));
    await first.sync();
    await second.sync();
    const room = await getRoom(env, id);
    expect(await room.presence()).toHaveLength(2);
    expect(await room.kick({ userId: await userIdOf(hanako) })).toBe(2);
    await vi.waitFor(() => {
      expect(first.closed?.code).toBe(4001);
      expect(second.closed?.code).toBe(4001);
    });
  });
});

describe("閲覧専用と同時編集", () => {
  it("viewer の update は捨てられ、モデルは変わらない。editor の update は反映される", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    await addMember(id, await userIdOf(jiro), "viewer");
    expect(await elementIds(id)).toEqual([]);

    const viewer = await join(jiro, id);
    addActor(viewer, "act_viewer");
    await viewer.sync();
    expect(await elementIds(id)).toEqual([]);

    const editor = await join(hanako, id);
    addActor(editor, "act_editor");
    await editor.sync();
    expect(await elementIds(id)).toEqual(["act_editor"]);

    // presence には両方が出ている
    const roles = (await (await getRoom(env, id)).presence()).map((p) => p.role).sort();
    expect(roles).toEqual(["editor", "viewer"]);
  });

  it("guest の update も捨てられる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const guest = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });
    addActor(guest, "act_guest");
    await guest.sync();
    expect(await elementIds(id)).toEqual([]);
  });

  it("2 つの editor の接続で、片方の update がもう片方に届く", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    const a = await join(taro, id);
    const b = await join(hanako, id);
    addActor(a, "act_from_a");
    await vi.waitFor(() => expect(rebuildModel(b.doc).elements.map((e) => e.id)).toEqual(["act_from_a"]));
    addActor(b, "act_from_b");
    await vi.waitFor(() =>
      expect(
        rebuildModel(a.doc)
          .elements.map((e) => e.id)
          .sort(),
      ).toEqual(["act_from_a", "act_from_b"]),
    );
  });

  it("editor の update は viewer の画面にも届く (閲覧専用でも変更は見える)", async () => {
    const taro = await loginAs("taro@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(jiro), "viewer");
    const editor = await join(taro, id);
    const viewer = await join(jiro, id);
    addActor(editor, "act_seen");
    await vi.waitFor(() => expect(rebuildModel(viewer.doc).elements.map((e) => e.id)).toEqual(["act_seen"]));
  });

  it("awareness: viewer からの awareness は他の接続に届く (閲覧専用でも選択が見える)", async () => {
    const taro = await loginAs("taro@example.com");
    const jiro = await loginAs("jiro@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(jiro), "viewer");
    const editor = await join(taro, id);
    const viewer = await join(jiro, id);
    viewer.send(awarenessMessage(4242, 1, { selection: ["act_1"] }));
    await vi.waitFor(() => expect(editor.awareness).toContain(JSON.stringify({ selection: ["act_1"] })));
    // awareness を送っても接続の state (役割) は残る
    expect((await (await getRoom(env, id)).presence()).map((p) => p.role).sort()).toEqual(["owner", "viewer"]);
  });
});

describe("ゲスト", () => {
  it("via: link・role: guest のチケットは「ゲスト 1」「ゲスト 2」と接続順に番号が付く", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const guest = { userId: null, name: "ゲスト", role: "guest", via: "link" } as const;
    const one = await joinWith(id, guest);
    const two = await joinWith(id, guest);
    const room = await getRoom(env, id);
    expect(await room.presence()).toEqual([
      { userId: null, name: "ゲスト 1", role: "guest" },
      { userId: null, name: "ゲスト 2", role: "guest" },
    ]);

    // 1 人目が抜けると、その番号 (1) が次の人に振られる。いま居る 2 番とは重ならない
    one.close();
    await vi.waitFor(async () => expect((await room.presence()).map((p) => p.name)).toEqual(["ゲスト 2"]));
    await joinWith(id, guest);
    expect((await room.presence()).map((p) => p.name).sort()).toEqual(["ゲスト 1", "ゲスト 2"]);
    expect(two.closed).toBeNull();
  });
});

describe("kick", () => {
  it("kick({ userId }) でその人の接続が 4001 で閉じ、他は残る", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    const owner = await join(taro, id);
    const editor1 = await join(hanako, id);
    const editor2 = await join(hanako, id);
    const guest = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });

    const room = await getRoom(env, id);
    expect(await room.kick({ userId: await userIdOf(hanako) })).toBe(2);
    await vi.waitFor(() => {
      expect(editor1.closed).toEqual({ code: CLOSE_ROLE_CHANGED, reason: "役割が変わりました" });
      expect(editor2.closed?.code).toBe(4001);
    });
    expect(owner.closed).toBeNull();
    expect(guest.closed).toBeNull();
    await vi.waitFor(async () => expect((await room.presence()).map((p) => p.role).sort()).toEqual(["guest", "owner"]));
    // 該当する人がいなければ 0
    expect(await room.kick({ userId: "usr_nobody" })).toBe(0);
  });

  it("kick のあとに同じチケットでつなぎ直すと閉じられる。kick のあとに取り直したチケットなら通る", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    const oldTicket = await ticketFor(hanako, id);
    const before = expectClient(await connectRoom(id, oldTicket));
    await before.sync();
    await tick();
    const room = await getRoom(env, id);
    expect(await room.kick({ userId: await userIdOf(hanako) })).toBe(1);

    // 古いチケット (有効期間内) での再接続は 4001 で閉じる。ほかの人のチケットには影響しない
    const again = expectClient(await connectRoom(id, oldTicket));
    await vi.waitFor(() => expect(again.closed?.code).toBe(4001));
    const other = await join(taro, id);
    expect(other.closed).toBeNull();

    await tick();
    const fresh = await join(hanako, id);
    expect(fresh.closed).toBeNull();
    expect((await room.presence()).map((p) => p.role).sort()).toEqual(["editor", "owner"]);
  });

  it("removed の kick は 4003。同じチケットでの再接続も 4003", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "viewer");
    const oldTicket = await ticketFor(hanako, id);
    const before = expectClient(await connectRoom(id, oldTicket));
    await before.sync();
    await tick();
    const room = await getRoom(env, id);
    expect(await room.kick({ userId: await userIdOf(hanako), reason: "removed" })).toBe(1);
    await vi.waitFor(() => expect(before.closed).toEqual({ code: CLOSE_REMOVED, reason: "共有から外されました" }));
    const again = expectClient(await connectRoom(id, oldTicket));
    await vi.waitFor(() => expect(again.closed?.code).toBe(4003));
  });

  it("kick({ via: \"link\" }) のあとも、古いリンクのチケットでは入れない。ログインしたメンバーの通常のチケットは通る", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const guest = { userId: null, name: "ゲスト", role: "guest", via: "link" } as const;
    const { ticket: oldGuest } = await issueTicket(env, { fileId: id, ...guest });
    await tick();
    const room = await getRoom(env, id);
    expect(await room.kick({ via: "link" })).toBe(0);
    const again = expectClient(await connectRoom(id, oldGuest));
    await vi.waitFor(() => expect(again.closed?.code).toBe(4004));
    // 取り消しの記録は userId の記録とは別。メンバーとしての接続は通る
    const owner = await join(taro, id);
    expect(owner.closed).toBeNull();
  });

  it("kick({ all: true }) は全員を 4003 で閉じる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "viewer");
    const a = await join(taro, id);
    const b = await join(hanako, id);
    const g = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });
    const room = await getRoom(env, id);
    expect(await room.kick({ all: true })).toBe(3);
    await vi.waitFor(() => expect([a, b, g].map((c) => c.closed?.code)).toEqual([4003, 4003, 4003]));
  });

  it("ゴミ箱に入れると、つながっていた全員が 4003 で閉じる。戻したあとも、入れる前のチケットは使えない", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "editor");
    const oldTicket = await ticketFor(hanako, id);
    const a = await join(taro, id);
    const b = expectClient(await connectRoom(id, oldTicket));
    await b.sync();
    await tick();
    expect((await taro.fetch(`/api/files/${id}`, { method: "DELETE" })).status).toBe(204);
    await vi.waitFor(() => expect([a.closed?.code, b.closed?.code]).toEqual([4003, 4003]));
    // ゴミ箱の中はチケットが出ない (owner には 409、member には 404)
    expect((await taro.json(`/api/files/${id}/ticket`, { method: "POST" })).status).toBe(409);
    expect((await hanako.json(`/api/files/${id}/ticket`, { method: "POST" })).status).toBe(404);
    // 戻しても、入れる前に取ったチケットでは入れない。取り直せば入れる
    await tick();
    expect((await taro.fetch(`/api/files/${id}/restore`, { method: "POST" })).status).toBe(200);
    const again = expectClient(await connectRoom(id, oldTicket));
    await vi.waitFor(() => expect(again.closed?.code).toBe(4003));
    const fresh = await join(hanako, id);
    expect(fresh.closed).toBeNull();
  });

  it("kick の userId が空・null・無いときは例外で、ゲストを巻き込まない", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const guest = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });
    const room = await getRoom(env, id);
    for (const bad of [{ userId: null }, { userId: "" }, {}, { userId: 5 }, { all: false }]) {
      await expect(room.kick(bad as never)).rejects.toThrow("kick の対象が正しくありません");
    }
    expect(guest.closed).toBeNull();
    expect(await room.presence()).toHaveLength(1);
  });

  it("kick({ via: \"link\" }) でゲストだけが 4004 で閉じる", async () => {
    const taro = await loginAs("taro@example.com");
    const hanako = await loginAs("hanako@example.com");
    const id = await createFile(taro);
    await addMember(id, await userIdOf(hanako), "viewer");
    const owner = await join(taro, id);
    const viewer = await join(hanako, id);
    const guest1 = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });
    const guest2 = await joinWith(id, { userId: null, name: "ゲスト", role: "guest", via: "link" });

    const room = await getRoom(env, id);
    expect(await room.kick({ via: "link" })).toBe(2);
    await vi.waitFor(() => {
      expect(guest1.closed).toEqual({ code: CLOSE_LINK_DISABLED, reason: "リンクが無効になりました" });
      expect(guest2.closed?.code).toBe(4004);
    });
    expect(owner.closed).toBeNull();
    expect(viewer.closed).toBeNull();
  });

  it("リンクから開いたメンバー (via: link で role が editor) も kick({ via: \"link\" }) で閉じる", async () => {
    const taro = await loginAs("taro@example.com");
    const id = await createFile(taro);
    const viaLink = await joinWith(id, { userId: "usr_member", name: "花子", role: "editor", via: "link" });
    const room = await getRoom(env, id);
    expect(await room.kick({ via: "link" })).toBe(1);
    await vi.waitFor(() => expect(viaLink.closed?.code).toBe(4004));
  });
});

describe("Worker を通らない接続", () => {
  /** Worker の onBeforeConnect を通さず、ルームの Durable Object に直接 WebSocket を張って、閉じられたコードを返す */
  async function connectDirect(id: string, headers: Record<string, string>) {
    const room = await getRoom(env, id);
    const response = await room.fetch(
      new Request(`http://x/parties/untie-room/${id}`, {
        headers: { Upgrade: "websocket", "x-partykit-room": id, "x-partykit-namespace": "untie-room", ...headers },
      }),
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve as never));
    const received: unknown[] = [];
    ws.addEventListener("message", (event) => received.push(event.data));
    ws.accept();
    return { event: await closed, room, received };
  }

  it("ヘッダーが無い接続は 4000 で閉じる (onConnect が拒む)", async () => {
    const { event, room, received } = await connectDirect("room-direct-test", {});
    expect(event.code).toBe(4000);
    // 閉じる前に sync step1 などを送っていない (文書の中身を渡さない)
    expect(received).toEqual([]);
    expect(event.reason).toBe("認証されていません");
    expect(await room.presence()).toEqual([]);
  });

  it("知らない役割・メンバーなのに userId が無い接続も 4000", async () => {
    const base = { [ROOM_HEADERS.name]: "x", [ROOM_HEADERS.via]: "member", [ROOM_HEADERS.iat]: String(Date.now()) };
    expect((await connectDirect("room-direct-role", { ...base, [ROOM_HEADERS.role]: "admin", [ROOM_HEADERS.user]: "usr_x" })).event.code).toBe(4000);
    expect((await connectDirect("room-direct-user", { ...base, [ROOM_HEADERS.role]: "editor" })).event.code).toBe(4000);
    // iat が無い (チケットを通っていない) 接続も 4000
    const { [ROOM_HEADERS.iat]: _iat, ...withoutIat } = base;
    expect((await connectDirect("room-direct-iat", { ...withoutIat, [ROOM_HEADERS.role]: "editor", [ROOM_HEADERS.user]: "usr_x" })).event.code).toBe(4000);
  });
});
