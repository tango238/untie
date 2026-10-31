import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError, type PresenceEntry, type Role } from "@untie/api";
import { createHotelSample } from "@untie/core/sample";
import { hasUnsavedChanges, useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { apiError, fakeServer, summary, user, type FakeServer } from "../../test/server";
import { PEER_COLORS, attachPresence, closeCloudFile, colorFor, openCloudFile } from "../collab";
import { useSessionStore } from "../session";
import { useAgentStore } from "../../ai/agentStore";

// y-partyserver の provider は WebSocket をつなぐので、手元で動かせる偽物にする
interface FakeOptions {
  party: string;
  protocol: string;
  disableBc: boolean;
  connect: boolean;
  params: () => Promise<Record<string, string>>;
}
vi.mock("y-partyserver/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class FakeProvider {
    static last: FakeProvider | null = null;
    /** true にすると、次の生成で例外を投げる (attach のあとの失敗の確認用) */
    static failNext = false;
    handlers = new Map<string, ((...args: never[]) => void)[]>();
    awareness: InstanceType<typeof Awareness>;
    synced = false;
    destroyed = false;
    disconnected = false;
    connected = 0;
    constructor(
      public host: string,
      public room: string,
      public doc: Y.Doc,
      public options: FakeOptions,
    ) {
      if (FakeProvider.failNext) {
        FakeProvider.failNext = false;
        throw new Error("つなげません");
      }
      this.awareness = new Awareness(doc);
      FakeProvider.last = this;
    }
    on(name: string, fn: (...args: never[]) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    }
    emit(name: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(name) ?? []) (fn as (...a: unknown[]) => void)(...args);
    }
    async connect() {
      this.connected++;
    }
    disconnect() {
      this.disconnected = true;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeProvider };
});
const { default: FakeProvider } = (await import("y-partyserver/provider")) as unknown as {
  default: {
    failNext: boolean;
    last: {
      host: string;
      room: string;
      doc: Y.Doc;
      options: FakeOptions;
      awareness: Awareness;
      synced: boolean;
      destroyed: boolean;
      disconnected: boolean;
      connected: number;
      emit: (name: string, ...args: unknown[]) => void;
    } | null;
  };
};
const provider = () => FakeProvider.last!;
const st = () => useUntieStore.getState();

let server: FakeServer;
beforeEach(() => {
  resetStore();
  FakeProvider.last = null;
  server = fakeServer({ mine: [summary({ id: "a", name: "ホテルの業務" })], shared: [summary({ id: "v", role: "viewer", ownerId: "u2" })] });
  useSessionStore.setState({ status: "signedIn", user, providers: [], hasServer: true, error: null });
});
afterEach(() => {
  closeCloudFile();
  server.restore();
});

describe("プレゼンスの色", () => {
  it("同じ id なら同じ色で、決めた色の中から選ぶ", () => {
    expect(colorFor("u1")).toBe(colorFor("u1"));
    for (const id of ["u1", "u2", "abc", "ゲスト", ""]) expect(PEER_COLORS).toContain(colorFor(id));
    // 何人かで色が散らばる
    expect(new Set(["a", "b", "c", "d", "e", "f"].map(colorFor)).size).toBeGreaterThan(2);
  });
});

describe("attachPresence", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let other: Awareness;
  /** 他の人の awareness の状態を、自分の awareness に写す */
  const receive = (from: Awareness) => applyAwarenessUpdate(awareness, encodeAwarenessUpdate(from, [from.clientID]), "remote");
  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    other = new Awareness(new Y.Doc());
  });
  afterEach(() => {
    awareness.destroy();
    other.destroy();
  });

  it("自分の状態を awareness に出し、ボードや選択が変わると更新する", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "テスト太郎" });
    expect(awareness.getLocalState()).toMatchObject({
      userId: "u1",
      name: "テスト太郎",
      color: colorFor("u1"),
      boardId: st().ui.currentBoardId,
      selection: null,
    });
    st().select({ type: "element", id: "actor_front" });
    expect(awareness.getLocalState()?.selection).toEqual({ type: "element", id: "actor_front" });
    st().setCurrentBoard("board_flow");
    expect(awareness.getLocalState()?.boardId).toBe("board_flow");
    // 選択はボードを変えると外れる
    expect(awareness.getLocalState()?.selection).toBeNull();
    stop();
    expect(awareness.getLocalState()).toBeNull();
    // 解除のあとは追いかけない
    st().select({ type: "element", id: "actor_manager" });
    expect(awareness.getLocalState()).toBeNull();
  });

  it("ゲスト (userId が null) の色は接続 id から決める", () => {
    const stop = attachPresence(awareness, { userId: null, name: "ゲスト 1" });
    expect(awareness.getLocalState()).toMatchObject({ userId: null, color: colorFor(String(awareness.clientID)) });
    stop();
  });

  it("他の人の状態を peers に写す (自分は含めない)", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" });
    expect(st().peers).toEqual([]);
    other.setLocalState({ userId: "u2", name: "花子", color: "#3e63dd", boardId: "board_flow", selection: { type: "element", id: "actor_front" } });
    receive(other);
    expect(st().peers).toEqual([
      { clientId: other.clientID, userId: "u2", name: "花子", color: "#3e63dd", boardId: "board_flow", selection: { type: "element", id: "actor_front" } },
    ]);
    // 更新
    other.setLocalStateField("selection", { type: "relation", id: "rel1" });
    receive(other);
    expect(st().peers[0]!.selection).toEqual({ type: "relation", id: "rel1" });
    // 抜けた
    other.setLocalState(null);
    receive(other);
    expect(st().peers).toEqual([]);
    stop();
  });

  it("形の壊れた状態は安全な値にする (色は決め直し、選択は外す)", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" });
    other.setLocalState({ userId: 5, name: 7, color: "red; background:url(x)", boardId: 3, selection: { type: "evil", id: "x" } });
    receive(other);
    const [peer] = st().peers;
    expect(peer).toMatchObject({ userId: null, name: "(名前なし)", boardId: null, selection: null });
    expect(PEER_COLORS).toContain(peer!.color);
    stop();
  });

  it("自分の別のタブ (同じ userId) は peers に入れない。ゲストは clientId で区別する", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" });
    other.setLocalState({ userId: "u1", name: "自分", color: "#3e63dd", boardId: null, selection: null });
    receive(other);
    expect(st().peers).toEqual([]);
    stop();

    const stopGuest = attachPresence(awareness, { userId: null, name: "ゲスト 1" });
    other.setLocalState({ userId: null, name: "ゲスト 2", color: "#3e63dd", boardId: null, selection: null });
    receive(other);
    expect(st().peers.map((p) => p.name)).toEqual(["ゲスト 2"]);
    stopGuest();
  });

  it("自分の状態だけが変わったときは peers を組み立て直さず、変わっていない人の参照を使い回す", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" });
    other.setLocalState({ userId: "u2", name: "花子", color: "#3e63dd", boardId: null, selection: null });
    receive(other);
    const first = st().peers;
    expect(first).toHaveLength(1);
    // 自分が選ぶたびに起きる change では、peers の参照が変わらない
    let writes = 0;
    const unsubscribe = useUntieStore.subscribe((s, prev) => {
      if (s.peers !== prev.peers) writes++;
    });
    st().select({ type: "element", id: "actor_front" });
    st().select({ type: "element", id: "actor_manager" });
    expect(st().peers).toBe(first);
    // 他の人の同じ内容の更新も、参照は変わらない
    other.setLocalState({ userId: "u2", name: "花子", color: "#3e63dd", boardId: null, selection: null });
    receive(other);
    expect(st().peers).toBe(first);
    expect(writes).toBe(0);
    // 3 人目が来ても、1 人目の参照はそのまま
    const third = new Awareness(new Y.Doc());
    third.setLocalState({ userId: "u3", name: "次郎", color: "#30a46c", boardId: null, selection: null });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(third, [third.clientID]), "remote");
    expect(st().peers).toHaveLength(2);
    expect(st().peers.find((p) => p.userId === "u2")).toBe(first[0]);
    third.destroy();
    unsubscribe();
    stop();
  });

  it("解除すると peers を空にし、以後の変化を追わない", () => {
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" });
    other.setLocalState({ userId: "u2", name: "花子", color: "#3e63dd", boardId: null, selection: null });
    receive(other);
    expect(st().peers).toHaveLength(1);
    stop();
    expect(st().peers).toEqual([]);
    other.setLocalStateField("name", "x");
    receive(other);
    expect(st().peers).toEqual([]);
  });
});

describe("attachPresence: サーバーの一覧で照らす (verify)", () => {
  let awareness: Awareness;
  const others: Awareness[] = [];
  const entry = (userId: string | null, name: string, role: Role = "editor"): PresenceEntry => ({ userId, name, role });
  /** 他の人の自己申告を、自分の awareness に写す */
  const join = (state: Record<string, unknown>) => {
    const a = new Awareness(new Y.Doc());
    others.push(a);
    a.setLocalState({ color: "#3e63dd", boardId: null, selection: null, ...state });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(a, [a.clientID]), "remote");
    return a;
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers();
    awareness = new Awareness(new Y.Doc());
  });
  afterEach(() => {
    vi.useRealTimers();
    awareness.destroy();
    for (const a of others.splice(0)) a.destroy();
  });

  it("一覧に userId が無い人は「ゲスト」にし (名前も userId も捨てる)、ある人の名前はサーバーの値にする", async () => {
    const verify = vi.fn<() => Promise<PresenceEntry[]>>().mockResolvedValue([entry("u2", "花子")]);
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" }, { verify });
    await flush();
    join({ userId: "u2", name: "花子になりすました名前" });
    join({ userId: "u9", name: "偽者" });
    join({ userId: null, name: "ゲスト 7" });
    // 来たばかりの人は、次の一覧が届くまで自己申告のまま
    expect(st().peers.map((p) => p.name).sort()).toEqual(["ゲスト 7", "偽者", "花子になりすました名前"].sort());
    await vi.advanceTimersByTimeAsync(1000);
    const named = st().peers.filter((p) => p.userId === "u2");
    expect(named.map((p) => p.name)).toEqual(["花子"]);
    const guests = st().peers.filter((p) => p.userId === null);
    expect(guests).toHaveLength(2);
    expect(guests.every((p) => p.name === "ゲスト")).toBe(true);
    stop();
  });

  it("最初の一覧が届くまでは自己申告のまま。取れなければそのまま", async () => {
    let release!: (v: PresenceEntry[]) => void;
    const verify = vi
      .fn<() => Promise<PresenceEntry[]>>()
      .mockImplementationOnce(() => new Promise<PresenceEntry[]>((resolve) => (release = resolve)))
      .mockResolvedValue([entry("u2", "花子 (サーバー)")]);
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" }, { verify });
    join({ userId: "u2", name: "花子" });
    expect(st().peers.map((p) => p.name)).toEqual(["花子"]);
    release([]);
    await flush();
    // 来る前に取った一覧は、あとから来た人を覆わない (自己申告のまま)。次の取得で揃う
    expect(st().peers.map((p) => p.name)).toEqual(["花子"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(st().peers.map((p) => p.name)).toEqual(["花子 (サーバー)"]);
    stop();

    const failing = vi.fn<() => Promise<PresenceEntry[]>>().mockRejectedValue(new Error("つながりません"));
    const other = new Awareness(new Y.Doc());
    const stop2 = attachPresence(other, { userId: "u1", name: "自分" }, { verify: failing });
    await flush();
    const peer = new Awareness(new Y.Doc());
    others.push(peer, other);
    peer.setLocalState({ userId: "u3", name: "次郎", color: "#3e63dd", boardId: null, selection: null });
    applyAwarenessUpdate(other, encodeAwarenessUpdate(peer, [peer.clientID]), "remote");
    await vi.advanceTimersByTimeAsync(1000);
    expect(st().peers.map((p) => p.name)).toEqual(["次郎"]);
    stop2();
  });

  it("選択が変わっただけでは取り直さない。人が来る・抜けるたびに、前の取得から 1 秒空けて取る", async () => {
    const verify = vi.fn<() => Promise<PresenceEntry[]>>().mockResolvedValue([entry("u2", "花子")]);
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" }, { verify });
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    const hanako = join({ userId: "u2", name: "花子" });
    // 取ったばかりなので、1 秒たつまで待つ
    await vi.advanceTimersByTimeAsync(500);
    expect(verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(verify).toHaveBeenCalledTimes(2);
    // 選択だけの変化は取り直さない
    hanako.setLocalStateField("selection", { type: "element", id: "actor_front" });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(hanako, [hanako.clientID]), "remote");
    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(st().peers[0]!.selection).toEqual({ type: "element", id: "actor_front" });
    // 抜けたら取り直す
    hanako.setLocalState(null);
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(hanako, [hanako.clientID]), "remote");
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(3);
    stop();
  });

  it("一覧に載らない人がいても、取り直しは回数に上限がある。解除したあとに届いた応答は捨てる", async () => {
    const verify = vi.fn<() => Promise<PresenceEntry[]>>().mockResolvedValue([]);
    const stop = attachPresence(awareness, { userId: "u1", name: "自分" }, { verify });
    await flush();
    join({ userId: "u9", name: "偽者" });
    await vi.advanceTimersByTimeAsync(10_000);
    // 最初の 1 回 + 人が来たときの 1 回 + 載るのを待つ取り直し 3 回
    expect(verify).toHaveBeenCalledTimes(5);
    expect(st().peers.map((p) => [p.userId, p.name])).toEqual([[null, "ゲスト"]]);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(st().peers).toEqual([]);
  });
});

describe("openCloudFile", () => {
  it("チケットを取ってつなぎ、最初の同期までは loading、同期したら connected にする", async () => {
    await openCloudFile("a");
    expect(server.calls.filter((c) => c.method === "POST" && c.path === "/api/files/a/ticket")).toHaveLength(1);
    const p = provider();
    expect(p).toMatchObject({ host: "test", room: "a" });
    expect(p.options).toMatchObject({ party: "untie-room", protocol: "ws", disableBc: true });
    expect(p.connected).toBe(1);
    expect(st().cloud).toMatchObject({ fileId: "a", role: "owner", status: "loading" });
    expect(st().cloud?.doc).toBe(p.doc);

    p.emit("status", { status: "connecting" });
    p.emit("status", { status: "connected" });
    expect(st().cloud?.status).toBe("loading");

    p.synced = true;
    p.emit("sync", true);
    expect(st().cloud?.status).toBe("connected");
  });

  it("同期のあとは、接続の状態を connecting / connected / offline に写す", async () => {
    await openCloudFile("a");
    const p = provider();
    p.synced = true;
    p.emit("sync", true);
    p.synced = false;
    p.emit("sync", false);
    p.emit("status", { status: "disconnected" });
    expect(st().cloud?.status).toBe("offline");
    // 再接続を試している間も、同期が済むまでは「切断」のまま (失敗し続けても接続中と出さない)
    p.emit("status", { status: "connecting" });
    expect(st().cloud?.status).toBe("offline");
    p.emit("status", { status: "connecting" });
    p.emit("status", { status: "connected" });
    expect(st().cloud?.status).toBe("offline");
    p.synced = true;
    p.emit("sync", true);
    expect(st().cloud?.status).toBe("connected");
    // 同期が済んだあとの、切れていない接続の試行は接続中
    p.emit("status", { status: "connecting" });
    expect(st().cloud?.status).toBe("connecting");
  });

  it("つながっていない間の自分の変更は、同期が済むまで未保存として数える", async () => {
    await openCloudFile("a");
    const p = provider();
    p.synced = true;
    p.emit("sync", true);
    // 切れると synced は false に戻る (本物の provider と同じ)
    p.synced = false;
    p.emit("sync", false);
    p.emit("status", { status: "disconnected" });
    st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "切れている間の変更" } } }));
    expect(hasUnsavedChanges(st())).toBe(true);
    p.emit("status", { status: "connected" });
    expect(hasUnsavedChanges(st())).toBe(true);
    p.synced = true;
    p.emit("sync", true);
    expect(hasUnsavedChanges(st())).toBe(false);
  });

  it("最初の接続は取ったチケットを使い、再接続のたびにチケットを取り直す", async () => {
    await openCloudFile("a");
    const { params } = provider().options;
    expect(await params()).toEqual({ ticket: "ticket-a" });
    expect(server.calls.filter((c) => c.path === "/api/files/a/ticket")).toHaveLength(1);
    expect(await params()).toEqual({ ticket: "ticket-a" });
    expect(server.calls.filter((c) => c.path === "/api/files/a/ticket")).toHaveLength(2);
  });

  it("再接続で役割が変わっていたら、新しい役割にする", async () => {
    await openCloudFile("a");
    const { params } = provider().options;
    await params();
    server.mine = [summary({ id: "a", role: "viewer" })];
    await params();
    expect(st().cloud?.role).toBe("viewer");
  });

  it("再接続のチケットが 404 / 409 なら、再接続せずに閉じられた扱いにする", async () => {
    await openCloudFile("a");
    const p = provider();
    await p.options.params();
    server.overrides["POST /api/files/a/ticket"] = () => apiError(404, "file_not_found", "ファイルが見つかりません");
    await expect(p.options.params()).rejects.toBeInstanceOf(ApiError);
    expect(st().cloud?.closed).toEqual({ code: 4003, reason: "ファイルが見つかりません" });
    expect(p.disconnected).toBe(true);
  });

  it("自分のプレゼンスを出す (session のユーザー)", async () => {
    await openCloudFile("a");
    expect(provider().awareness.getLocalState()).toMatchObject({ userId: "u1", name: "テスト太郎", color: colorFor("u1") });
    // 他の人の状態が peers に写る
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ userId: "u2", name: "花子", color: "#3e63dd", boardId: null, selection: null });
    applyAwarenessUpdate(provider().awareness, encodeAwarenessUpdate(other, [other.clientID]), "remote");
    expect(st().peers.map((x) => x.name)).toEqual(["花子"]);
    other.destroy();
  });

  it("閉じるコード 4000〜4004 は再接続せずに cloud.closed へ入れる (サーバーの理由を優先)", async () => {
    await openCloudFile("a");
    const p = provider();
    p.emit("connection-close", { code: 4003, reason: "共有から外されました" });
    expect(st().cloud?.closed).toEqual({ code: 4003, reason: "共有から外されました" });
    expect(p.disconnected).toBe(true);
  });

  it.each([
    [4000, "認証されていません。ログインし直してください"],
    [4001, "役割が変わりました。開き直してください"],
    [4003, "共有から外されたか、ファイルがゴミ箱に入りました"],
    [4004, "リンクが無効になりました"],
  ])("理由が空なら、閉じるコード %i の決まりの文言にする", async (code, reason) => {
    await openCloudFile("a");
    provider().emit("connection-close", { code, reason: "" });
    expect(st().cloud?.closed).toEqual({ code, reason });
    expect(provider().disconnected).toBe(true);
  });

  it("それ以外の閉じ方 (ネットワークの切断など) は閉じた扱いにしない", async () => {
    await openCloudFile("a");
    provider().emit("connection-close", { code: 1006, reason: "" });
    provider().emit("connection-close", { code: 1000, reason: "" });
    expect(st().cloud?.closed).toBeUndefined();
    expect(provider().disconnected).toBe(false);
  });

  it("closeCloudFile は接続を切り、ストアをサンプルに戻す", async () => {
    await openCloudFile("a");
    const p = provider();
    closeCloudFile();
    expect(p.destroyed).toBe(true);
    expect(st().cloud).toBeNull();
    expect(st().peers).toEqual([]);
    expect(st().model.meta.name).toBe(createHotelSample().meta.name);
    // 開いていなくても呼んでよい
    closeCloudFile();
  });

  it("開き直すと前のファイルを閉じる", async () => {
    await openCloudFile("a");
    const first = provider();
    await openCloudFile("v");
    expect(first.destroyed).toBe(true);
    expect(st().cloud).toMatchObject({ fileId: "v", role: "viewer" });
  });

  it("チケットの取得中に閉じたら、何もつながない", async () => {
    const opening = openCloudFile("a");
    closeCloudFile();
    await opening;
    expect(FakeProvider.last).toBeNull();
    expect(st().cloud).toBeNull();
  });

  it("チケットの取得中に開き直したら、新しい方だけをつなぐ", async () => {
    const first = openCloudFile("a");
    const second = openCloudFile("v");
    await Promise.all([first, second]);
    expect(st().cloud?.fileId).toBe("v");
    expect(provider().room).toBe("v");
  });

  it("開くときに、走っているローカルの AI エージェントを止める", async () => {
    const original = useAgentStore.getState().cancel;
    const cancel = vi.fn();
    useAgentStore.setState({ cancel });
    onTestFinished(() => useAgentStore.setState({ cancel: original }));
    await openCloudFile("a");
    expect(cancel).toHaveBeenCalled();
  });

  it("つなぐ途中で例外になったら、ストアに cloud を残さず、Doc を捨てて投げる", async () => {
    FakeProvider.failNext = true;
    await expect(openCloudFile("a")).rejects.toThrow("つなげません");
    expect(st().cloud).toBeNull();
    expect(st().peers).toEqual([]);
    expect(st().model.meta.name).toBe(createHotelSample().meta.name);
  });

  it("チケットの取得が失敗したら ApiError を投げ、ストアは触らない", async () => {
    st().dispatch((m) => ({ ok: true, model: { ...m, meta: { ...m.meta, name: "ローカル" } } }));
    for (const [status, code] of [
      [401, "unauthenticated"],
      [403, "forbidden"],
      [404, "file_not_found"],
    ] as const) {
      server.overrides["POST /api/files/a/ticket"] = () => apiError(status, code, "だめです");
      await expect(openCloudFile("a")).rejects.toMatchObject({ status });
    }
    expect(FakeProvider.last).toBeNull();
    expect(st().cloud).toBeNull();
    expect(st().model.meta.name).toBe("ローカル");
  });

  it("ゴミ箱の中のファイルは 409", async () => {
    server.mine = [];
    server.trash = [summary({ id: "t", deletedAt: Date.now() })];
    await expect(openCloudFile("t")).rejects.toMatchObject({ status: 409, code: "in_trash" });
  });
});

describe("openCloudFile: リンクで開く (link)", () => {
  beforeEach(() => {
    server.others = [summary({ id: "g", name: "リンクのファイル", ownerId: "u9", ownerName: "山田" })];
    server.shares.g = { members: [], invitations: [], linkToken: "tok" };
  });

  it("チケットは links.ticket で取る (X-Untie-Token ヘッダー、files.ticket は呼ばない)。ログインしていなくても開く", async () => {
    server.signedIn = false;
    useSessionStore.setState({ status: "anonymous", user: null });
    await openCloudFile("g", { link: "tok" });
    const ticket = server.calls.filter((c) => c.path === "/api/links/ticket");
    expect(ticket).toHaveLength(1);
    expect(ticket[0]!.headers["X-Untie-Token"]).toBe("tok");
    expect(ticket[0]!.path).not.toContain("tok");
    expect(server.calls.filter((c) => c.path === "/api/files/g/ticket")).toHaveLength(0);
    expect(st().cloud).toMatchObject({ fileId: "g", role: "guest", link: "tok" });
    expect(provider().room).toBe("g");
  });

  it("再接続のたびも links.ticket で取り直す。リンクが無効になっていたら (404) 閉じられた扱いにして再接続しない", async () => {
    await openCloudFile("g", { link: "tok" });
    const p = provider();
    expect(await p.options.params()).toEqual({ ticket: "ticket-link-g" });
    expect(await p.options.params()).toEqual({ ticket: "ticket-link-g" });
    expect(server.calls.filter((c) => c.path === "/api/links/ticket")).toHaveLength(2);
    expect(server.calls.filter((c) => c.path === "/api/files/g/ticket")).toHaveLength(0);
    server.shares.g!.linkToken = null;
    await expect(p.options.params()).rejects.toMatchObject({ status: 404 });
    expect(st().cloud?.closed).toMatchObject({ code: 4003 });
    expect(p.disconnected).toBe(true);
  });

  it("ゲストのプレゼンスは、ログインしていても「ゲスト」で userId なし。サーバーの「ゲスト n」は使わない", async () => {
    // ログイン済みでもメンバーでなければ guest で開く
    await openCloudFile("g", { link: "tok" });
    expect(provider().awareness.getLocalState()).toMatchObject({ userId: null, name: "ゲスト" });
  });

  it("ログイン済みでメンバーなら、メンバーの役割で開き、自分の名前でプレゼンスを出す", async () => {
    server.shared = [summary({ id: "g", role: "editor", ownerId: "u9", ownerName: "山田" })];
    server.others = [];
    await openCloudFile("g", { link: "tok" });
    expect(st().cloud).toMatchObject({ role: "editor", link: "tok" });
    expect(provider().awareness.getLocalState()).toMatchObject({ userId: "u1", name: "テスト太郎" });
  });

  it("他の人の自己申告は、リンクなら links.presence (X-Untie-Token)、メンバーなら files.presence の一覧で照らす", async () => {
    await openCloudFile("g", { link: "tok" });
    await vi.waitFor(() => expect(server.calls.some((c) => c.path === "/api/links/presence")).toBe(true));
    const call = server.calls.find((c) => c.path === "/api/links/presence")!;
    expect(call.headers["X-Untie-Token"]).toBe("tok");
    closeCloudFile();
    await openCloudFile("a");
    await vi.waitFor(() => expect(server.calls.some((c) => c.path === "/api/files/a/presence")).toBe(true));
  });

  it("無効なリンクのチケット (404) は ApiError を投げ、ストアを触らない", async () => {
    server.shares.g!.linkToken = null;
    await expect(openCloudFile("g", { link: "tok" })).rejects.toMatchObject({ status: 404 });
    expect(st().cloud).toBeNull();
    expect(FakeProvider.last).toBeNull();
  });
});

