import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyModelDiff, loadModel, rebuildModel } from "@untie/collab";
import { addElement, moveNode, removeElement, updateElement } from "@untie/core/model/commands";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { createHotelSample } from "@untie/core/sample";
import type { Role } from "@untie/api";
import { useAgentStore } from "../../ai/agentStore";
import { attachCloudDoc } from "../../cloud/collab";
import { selectReadOnly, useUntieStore } from "..";
import { hasUnsavedChanges } from "..";
import { resetStore } from "../../test/utils";

const st = () => useUntieStore.getState();
const rename = (id: string, name: string) => (m: UntieModel) => updateElement(m, { id, patch: { name } });
const nameOf = (m: UntieModel, id: string) => m.elements.find((e) => e.id === id)?.name;

/** 2 つの Doc を、同期的に互いへ写し合う (サーバー越しの合流の代わり) */
function link(a: Y.Doc, b: Y.Doc): { disconnect: () => void; reconnect: () => void } {
  let connected = true;
  a.on("update", (u: Uint8Array, origin: unknown) => connected && origin !== "link" && Y.applyUpdate(b, u, "link"));
  b.on("update", (u: Uint8Array, origin: unknown) => connected && origin !== "link" && Y.applyUpdate(a, u, "link"));
  return {
    disconnect: () => {
      connected = false;
    },
    // つなぎ直したら、溜まっていた分を互いに渡す
    reconnect: () => {
      connected = true;
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "link");
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "link");
    },
  };
}

let mine: Y.Doc; // ストアに付ける Doc
let peer: Y.Doc; // 他の人の Doc
let detach: (() => void) | null = null;
let wire: ReturnType<typeof link>;

/** 他の人の編集 (origin は "peer") */
function peerEdit(command: (m: UntieModel) => CommandResult): void {
  const before = rebuildModel(peer);
  const result = command(before);
  if (!result.ok) throw new Error(result.reason);
  applyModelDiff(peer, before, result.model, "peer");
}

function attach(role: Role = "editor", connected = true) {
  detach = attachCloudDoc(mine, { fileId: "f1", role });
  // つながって同期が済んだ状態から始める (つながっていない間の変更の印は、別のテストで確かめる)
  if (connected) st().setCloudStatus("connected");
}

beforeEach(() => {
  resetStore();
  const seed = new Y.Doc();
  loadModel(seed, createHotelSample());
  mine = new Y.Doc();
  peer = new Y.Doc();
  Y.applyUpdate(mine, Y.encodeStateAsUpdate(seed));
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(seed));
  wire = link(mine, peer);
});
afterEach(() => {
  detach?.();
  detach = null;
});

describe("ストア: クラウドファイル", () => {
  it("付けると cloud が入り、Doc から組み立てたモデルになる。履歴は空で、未保存の変更は無い", () => {
    attach("editor", false);
    expect(st().cloud).toMatchObject({ fileId: "f1", role: "editor", status: "loading" });
    expect(st().cloud?.doc).toBe(mine);
    expect(st().model).toEqual(rebuildModel(mine));
    expect(st().history).toEqual({ past: [], future: [] });
    expect(hasUnsavedChanges(st())).toBe(false);
    expect(selectReadOnly(st())).toBe(false);
  });

  it("dispatch は Doc に書き、もう一方の Doc に写すと同じモデルになる。履歴には積まない", () => {
    attach();
    const r = st().dispatch((m) => addElement(m, { kind: "context", name: "新しいコンテキスト" }));
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect(nameOf(rebuildModel(mine), id)).toBe("新しいコンテキスト");
    expect(st().model.elements.some((e) => e.id === id)).toBe(true);
    // link で写っている
    expect(rebuildModel(peer)).toEqual(st().model);
    expect(st().history).toEqual({ past: [], future: [] });
    expect(hasUnsavedChanges(st())).toBe(false);
  });

  it("手元の変更は Doc を通して組み立て直したモデルが表示に出る (Doc が正本)", () => {
    attach();
    st().dispatch(rename("actor_front", "受付係"));
    expect(st().model).toEqual(rebuildModel(mine));
    expect(nameOf(st().model, "actor_front")).toBe("受付係");
  });

  it("失敗したコマンドと、変更のないコマンドは Doc に何も書かない", () => {
    attach();
    let updates = 0;
    mine.on("update", () => updates++);
    const before = st().model;
    expect(st().dispatch(rename("nothing", "x")).ok).toBe(false);
    expect(st().dispatch((m) => ({ ok: true, model: m })).ok).toBe(true);
    expect(updates).toBe(0);
    expect(st().model).toBe(before);
  });

  it("他の人の変更は model に反映され、消えた要素の選択は外れる", () => {
    attach();
    st().select({ type: "element", id: "actor_front" });
    peerEdit(rename("actor_manager", "総支配人"));
    expect(nameOf(st().model, "actor_manager")).toBe("総支配人");
    expect(st().ui.selection).toEqual({ type: "element", id: "actor_front" });
    peerEdit((m) => removeElement(m, { id: "actor_front" }));
    expect(st().model.elements.some((e) => e.id === "actor_front")).toBe(false);
    expect(st().ui.selection).toBeNull();
    expect(st().model).toEqual(rebuildModel(mine));
  });

  it("自分の変更では、観測側が組み立て直さない (参照を使い回す)", () => {
    attach();
    st().dispatch(rename("actor_front", "A"));
    const after = st().model;
    // 変えていない要素は同じ参照のまま
    peerEdit(rename("actor_manager", "B"));
    const next = st().model;
    expect(next).not.toBe(after);
    expect(next.elements.find((e) => e.id === "actor_front")).toBe(after.elements.find((e) => e.id === "actor_front"));
  });

  it("ドラッグ中に来たリモートの変更は commitDrag のあとで反映され、ドラッグした座標も残る", () => {
    attach();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 777, y: 888 });
    expect(st().dragBase).not.toBeNull();

    peerEdit(rename("actor_manager", "ドラッグ中の変更"));
    // 後回し: 表示はまだ古い名前で、ドラッグ中の座標は動いたまま
    expect(st().pendingRemote).toBe(true);
    expect(nameOf(st().model, "actor_manager")).not.toBe("ドラッグ中の変更");
    expect(st().model.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: 777, y: 888 });
    // Doc にはまだ書いていない
    expect(rebuildModel(mine).boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });

    st().commitDrag();
    expect(st().pendingRemote).toBe(false);
    expect(st().dragBase).toBeNull();
    expect(nameOf(st().model, "actor_manager")).toBe("ドラッグ中の変更");
    for (const m of [st().model, rebuildModel(mine), rebuildModel(peer)]) {
      expect(m.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: 777, y: 888 });
      expect(nameOf(m, "actor_manager")).toBe("ドラッグ中の変更");
    }
    expect(st().history.past).toEqual([]);
  });

  it("ドラッグを取り消すと、開始時点に戻りつつ後回しにしていたリモートの変更を含める", () => {
    attach();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 1, y: 2 });
    peerEdit(rename("actor_manager", "取り消し中の変更"));
    st().cancelDrag();
    expect(st().pendingRemote).toBe(false);
    expect(nameOf(st().model, "actor_manager")).toBe("取り消し中の変更");
    expect(st().model.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
    expect(rebuildModel(mine).boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
  });

  it("ドラッグ中に相手が要素を消したら、確定しても復活しない (消した側が勝つ)", () => {
    attach();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 5, y: 6 });
    peerEdit((m) => removeElement(m, { id: node.elementId }));
    st().commitDrag();
    for (const m of [st().model, rebuildModel(mine), rebuildModel(peer)]) {
      expect(m.elements.some((e) => e.id === node.elementId)).toBe(false);
      expect(m.boards[0]!.nodes.some((n) => n.elementId === node.elementId)).toBe(false);
    }
  });

  it("dispatch はドラッグ中なら先に確定し、リモートの変更を揃えてからコマンドを当てる", () => {
    attach();
    const board = st().model.boards[0]!;
    st().previewNode(board.id, board.nodes[0]!.elementId, { x: 9, y: 9 });
    peerEdit(rename("actor_manager", "先に来た変更"));
    st().dispatch(rename("actor_front", "後から当てた変更"));
    expect(nameOf(st().model, "actor_manager")).toBe("先に来た変更");
    expect(nameOf(st().model, "actor_front")).toBe("後から当てた変更");
    expect(st().model).toEqual(rebuildModel(mine));
  });

  it("commitDrag の command も Doc に書く", () => {
    attach();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 10, y: 20 });
    st().commitDrag((m) => moveNode(m, { boardId: board.id, elementId: node.elementId, position: { x: 30, y: 40 } }));
    expect(rebuildModel(peer).boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: 30, y: 40 });
  });

  it("AI エージェントの編集 (agentApply) も Doc に書く。履歴は積まない", () => {
    attach();
    st().beginAgentEdit();
    const r = st().agentApply(rename("actor_front", "AI が直した"));
    expect(r.ok).toBe(true);
    expect(nameOf(rebuildModel(peer), "actor_front")).toBe("AI が直した");
    // 途中で他の人の変更が来ても、後回しにせずそのまま反映される
    peerEdit(rename("actor_manager", "途中の変更"));
    expect(nameOf(st().model, "actor_manager")).toBe("途中の変更");
    st().endAgentEdit();
    expect(st().agentBase).toBeNull();
    expect(st().history).toEqual({ past: [], future: [] });
  });

  it("ドラッグ中の agentApply は、先にドラッグを確定する。後回しのリモート変更を自分の変更として書き直さない", () => {
    attach();
    st().beginAgentEdit();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 777, y: 888 });
    let remoteId = "";
    peerEdit((m) => {
      const r = addElement(m, { kind: "context", name: "相手の要素" });
      if (r.ok) remoteId = r.id;
      return r;
    });
    expect(st().pendingRemote).toBe(true);
    const remoteMap = mine.getMap<Y.Map<unknown>>("elements").get(remoteId)!;
    expect(remoteMap).toBeInstanceOf(Y.Map);

    expect(st().agentApply(rename("actor_front", "AI が直した")).ok).toBe(true);

    expect(st().dragBase).toBeNull();
    expect(st().pendingRemote).toBe(false);
    // ドラッグした座標が残り、相手の要素の Y.Map は置き換わらない
    expect(mine.getMap<Y.Map<unknown>>("elements").get(remoteId)).toBe(remoteMap);
    expect(st().model.elements.some((e) => e.id === remoteId)).toBe(true);
    for (const m of [st().model, rebuildModel(mine), rebuildModel(peer)]) {
      expect(m.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: 777, y: 888 });
      expect(nameOf(m, "actor_front")).toBe("AI が直した");
      expect(nameOf(m, remoteId)).toBe("相手の要素");
    }
  });

  it("AI の編集中でなければ (ローカルで走っていたエージェントなど)、agentApply はクラウドに書かない", () => {
    attach();
    const before = st().model;
    const r = st().agentApply(rename("actor_front", "書かせない"));
    expect(r.ok).toBe(false);
    expect(st().model).toBe(before);
    expect(nameOf(rebuildModel(mine), "actor_front")).not.toBe("書かせない");
    // 開いた時点で、ローカルの編集中の印も消える
    detach!();
    st().beginAgentEdit();
    expect(st().agentBase).not.toBeNull();
    detach = attachCloudDoc(mine, { fileId: "f1", role: "editor" });
    expect(st().agentBase).toBeNull();
    expect(st().agentApply(rename("actor_front", "書かせない")).ok).toBe(false);
  });

  it("ドラッグ中に複数のリモート変更が来ても、すべて後回しにして、確定のあとにまとめて反映する", () => {
    attach();
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 11, y: 22 });
    let addedId = "";
    peerEdit(rename("actor_manager", "変更 1"));
    peerEdit(rename("actor_front", "変更 2"));
    peerEdit((m) => {
      const r = addElement(m, { kind: "context", name: "変更 3" });
      if (r.ok) addedId = r.id;
      return r;
    });
    peerEdit(rename("actor_manager", "変更 1 の上書き"));
    expect(st().pendingRemote).toBe(true);
    expect(nameOf(st().model, "actor_manager")).not.toBe("変更 1 の上書き");
    expect(st().model.elements.some((e) => e.id === addedId)).toBe(false);

    st().commitDrag();
    expect(st().pendingRemote).toBe(false);
    expect(nameOf(st().model, "actor_manager")).toBe("変更 1 の上書き");
    expect(nameOf(st().model, "actor_front")).toBe("変更 2");
    expect(nameOf(st().model, addedId)).toBe("変更 3");
    expect(st().model.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: 11, y: 22 });
    expect(st().model).toEqual(rebuildModel(mine));
    expect(rebuildModel(peer)).toEqual(rebuildModel(mine));
  });

  it("消した側が勝つ: 切り離している間に相手が消した要素を手元で更新しても、つなぎ直すと消える", () => {
    attach();
    wire.disconnect();
    peerEdit((m) => removeElement(m, { id: "actor_manager" }));
    // 手元はまだ知らないので、更新できる
    expect(st().dispatch(rename("actor_manager", "手元で更新")).ok).toBe(true);
    expect(nameOf(st().model, "actor_manager")).toBe("手元で更新");
    wire.reconnect();
    for (const m of [st().model, rebuildModel(mine), rebuildModel(peer)]) {
      expect(m.elements.some((e) => e.id === "actor_manager")).toBe(false);
      expect(m.boards.every((b) => b.nodes.every((n) => n.elementId !== "actor_manager"))).toBe(true);
    }
    expect(st().model).toEqual(rebuildModel(mine));
  });

  it("閲覧専用の役割になったら、途中のドラッグと AI の編集は捨てる (setCloudRole)", () => {
    attach("editor");
    const before = st().model;
    const board = before.boards[0]!;
    const node = board.nodes[0]!;
    st().beginAgentEdit();
    st().previewNode(board.id, node.elementId, { x: 5, y: 5 });
    expect(st().dragBase).not.toBeNull();
    st().setCloudRole("viewer");
    expect(st().dragBase).toBeNull();
    expect(st().agentBase).toBeNull();
    expect(st().model.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
    expect(rebuildModel(mine).boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
  });

  it("閲覧専用になっているときの commitDrag は、ドラッグを残さず捨てる", () => {
    attach("editor");
    const board = st().model.boards[0]!;
    const node = board.nodes[0]!;
    st().previewNode(board.id, node.elementId, { x: 5, y: 5 });
    // 役割だけが先に変わった (setCloudRole を通らない) 場合
    useUntieStore.setState((s) => ({ cloud: { ...s.cloud!, role: "viewer" } }));
    st().commitDrag();
    expect(st().dragBase).toBeNull();
    expect(st().model.boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
    expect(rebuildModel(mine).boards[0]!.nodes.find((n) => n.elementId === node.elementId)).toMatchObject({ x: node.x, y: node.y });
  });

  it("つながっていない間の変更は未保存として数え、つながって同期が済むと解く", () => {
    attach();
    st().setCloudStatus("offline");
    expect(hasUnsavedChanges(st())).toBe(false);
    // dispatch
    st().dispatch(rename("actor_front", "A"));
    expect(st().cloud?.dirtySinceOffline).toBe(true);
    expect(hasUnsavedChanges(st())).toBe(true);
    st().setCloudStatus("connecting");
    expect(hasUnsavedChanges(st())).toBe(true);
    st().setCloudStatus("connected");
    expect(st().cloud?.dirtySinceOffline).toBe(false);
    expect(hasUnsavedChanges(st())).toBe(false);
    // つながっている間の変更は数えない
    st().dispatch(rename("actor_front", "B"));
    expect(hasUnsavedChanges(st())).toBe(false);

    // ドラッグの確定と AI の編集も同じ
    const board = st().model.boards[0]!;
    st().setCloudStatus("offline");
    st().previewNode(board.id, board.nodes[0]!.elementId, { x: 1, y: 2 });
    expect(hasUnsavedChanges(st())).toBe(false);
    st().commitDrag();
    expect(hasUnsavedChanges(st())).toBe(true);
    st().setCloudStatus("connected");
    st().setCloudStatus("offline");
    st().beginAgentEdit();
    st().agentApply(rename("actor_front", "C"));
    expect(hasUnsavedChanges(st())).toBe(true);
  });

  it("閲覧者の編集は何もしない (dispatch・agentApply・previewNode・commitDrag)", () => {
    attach("viewer");
    expect(selectReadOnly(st())).toBe(true);
    const before = st().model;
    const board = before.boards[0]!;
    expect(st().dispatch(rename("actor_front", "x"))).toEqual({ ok: false, reason: "閲覧専用です" });
    expect(st().agentApply(rename("actor_front", "x"))).toEqual({ ok: false, reason: "閲覧専用です" });
    st().previewNode(board.id, board.nodes[0]!.elementId, { x: 1, y: 1 });
    st().previewCommand((m) => updateElement(m, { id: "actor_front", patch: { name: "x" } }));
    st().commitDrag();
    st().beginAgentEdit();
    expect(st().model).toBe(before);
    expect(st().dragBase).toBeNull();
    expect(st().agentBase).toBeNull();
    expect(rebuildModel(peer)).toEqual(rebuildModel(mine));
    expect(nameOf(rebuildModel(mine), "actor_front")).not.toBe("x");
  });

  it("閲覧者が AI エージェントに依頼しても、送らずにエラーを出す", async () => {
    attach("viewer");
    useAgentStore.getState().newConversation();
    await useAgentStore.getState().send("名前を直して");
    const { items, running } = useAgentStore.getState();
    expect(running).toBe(false);
    expect(items.map((i) => [i.role, i.text])).toEqual([["error", "閲覧専用のため、AI エージェントは使えません。"]]);
    useAgentStore.getState().newConversation();
  });

  it("閲覧者にも他の人の変更は届く", () => {
    attach("viewer");
    peerEdit(rename("actor_manager", "届く"));
    expect(nameOf(st().model, "actor_manager")).toBe("届く");
  });

  it("役割が guest でも閲覧専用", () => {
    attach("guest");
    expect(selectReadOnly(st())).toBe(true);
  });

  it("undo / redo は何もしない", () => {
    attach();
    st().dispatch(rename("actor_front", "A"));
    const after = st().model;
    st().undo();
    st().redo();
    expect(st().model).toBe(after);
    expect(nameOf(rebuildModel(mine), "actor_front")).toBe("A");
  });

  it("接続の状態・役割・閉じられたことを記録する", () => {
    attach();
    st().setCloudStatus("connected");
    expect(st().cloud?.status).toBe("connected");
    st().setCloudStatus("offline");
    expect(st().cloud?.status).toBe("offline");
    st().setCloudRole("viewer");
    expect(selectReadOnly(st())).toBe(true);
    st().setCloudClosed({ code: 4003, reason: "共有から外されました" });
    expect(st().cloud?.closed).toEqual({ code: 4003, reason: "共有から外されました" });
  });

  it("detach のあとは通常に戻る (サンプル・未変更・履歴あり)", () => {
    attach();
    st().dispatch(rename("actor_front", "A"));
    st().setPeers([{ clientId: 1, userId: "u", name: "n", color: "#000000", boardId: null, selection: null }]);
    detach!();
    detach = null;
    expect(st().cloud).toBeNull();
    expect(st().peers).toEqual([]);
    expect(hasUnsavedChanges(st())).toBe(false);
    expect(st().model.meta.name).toBe(createHotelSample().meta.name);
    // 以後の Doc の変更は届かない
    peerEdit(rename("actor_manager", "届かない"));
    expect(nameOf(st().model, "actor_manager")).not.toBe("届かない");
    // ローカルの編集は履歴に積まれ、Undo できる
    st().dispatch(rename("actor_front", "ローカル"));
    expect(st().history.past).toHaveLength(1);
    st().undo();
    expect(nameOf(st().model, "actor_front")).not.toBe("ローカル");
    expect(hasUnsavedChanges(st())).toBe(false);
  });

  it("クラウドを開いていないときの closeCloud は、ローカルの編集中のモデルに触らない", () => {
    st().dispatch(rename("actor_front", "ローカルの編集"));
    st().closeCloud();
    expect(nameOf(st().model, "actor_front")).toBe("ローカルの編集");
    expect(st().history.past).toHaveLength(1);
  });

  it("別のファイルを付け直したあと、前の detach は新しい方に触らない", () => {
    attach();
    const other = new Y.Doc();
    loadModel(other, createHotelSample());
    const detachOther = attachCloudDoc(other, { fileId: "f2", role: "editor" });
    detach!();
    detach = detachOther;
    expect(st().cloud?.fileId).toBe("f2");
  });

  it("loadDocument / newDocument は cloud を外す", () => {
    attach();
    st().newDocument(createHotelSample(), { pristine: true });
    expect(st().cloud).toBeNull();
    expect(st().peers).toEqual([]);
  });
});
