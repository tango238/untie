import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { addElement, addRelation, emptyModel, validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import { applyModelDiff, getRoots, loadModel, readModel, readRawModel, rebuildModel, repairDoc } from "..";
import { sync } from "./helpers";

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
}

/** 作業 act (説明つき) と担当 actor が関係で結ばれたモデル */
function model(): UntieModel {
  let m = emptyModel();
  m = ok(addElement(m, { kind: "actor", name: "担当", id: "actor_a", boardId: "board_main" })).model;
  m = ok(addElement(m, { kind: "activity", name: "作業", id: "act_a", boardId: "board_main" })).model;
  m = ok(addRelation(m, { sourceId: "actor_a", targetId: "act_a", id: "rel_a" })).model;
  return m;
}

/** 古い版のクライアントなど、コマンドを通らずに長い文字列を Y.Doc に書く */
function writeLong(doc: Y.Doc, id: string, key: string, text: unknown): void {
  (getRoots(doc).elements.get(id) as Y.Map<unknown>).set(key, text);
}

describe("上限を超える文字列は要素を外さず切り詰める", () => {
  it("説明 4001 文字: 要素も関係も残り、読み出しは 4000 文字に切り詰められる", () => {
    const doc = new Y.Doc();
    loadModel(doc, model());
    writeLong(doc, "act_a", "description", "あ".repeat(4001));

    for (const read of [readModel(doc), rebuildModel(doc)]) {
      expect(read.elements.map((e) => e.id).sort()).toEqual(["act_a", "actor_a"]);
      expect(read.relations.map((r) => r.id)).toEqual(["rel_a"]);
      expect(read.elements.find((e) => e.id === "act_a")!.description).toHaveLength(4000);
      expect(validateModel(JSON.parse(JSON.stringify(read))).ok).toBe(true);
    }
    // Y.Doc の中身は切り詰めた形で読めるが、readRawModel は書いてあるままを返す
    expect(readRawModel(doc).elements.find((e) => e.id === "act_a")!.description).toHaveLength(4001);
    // Y.Doc 自体は変えない (直すのはサーバーの repairDoc だけ)
    expect((getRoots(doc).elements.get("act_a") as Y.Map<unknown>).get("description")).toHaveLength(4001);
  });

  it("名前・課題の分析・リンクなどが長くても同じ", () => {
    const doc = new Y.Doc();
    let m = model();
    m = ok(addElement(m, { kind: "issue", name: "課題", id: "issue_a" })).model;
    loadModel(doc, m);
    writeLong(doc, "actor_a", "name", "あ".repeat(201));
    const analysis = (getRoots(doc).elements.get("issue_a") as Y.Map<unknown>).get("analysis") as Y.Map<unknown>;
    analysis.set("cause", "あ".repeat(4001));
    writeLong(doc, "act_a", "links", [{ title: "あ".repeat(201), url: "https://example.com/" + "a".repeat(2000) }]);
    const read = rebuildModel(doc);
    expect(read.elements).toHaveLength(3);
    expect(read.relations).toHaveLength(1);
    expect(validateModel(JSON.parse(JSON.stringify(read))).ok).toBe(true);
  });

  it("ペルソナの長い文字列・不正な IT の習熟があっても、要素を外さず repairDoc が直す", () => {
    const server = new Y.Doc();
    loadModel(server, model());
    writeLong(server, "actor_a", "persona", { handle: "あ".repeat(201), itSkill: "bogus", goals: "目標" });
    expect(rebuildModel(server).elements).toHaveLength(2);
    const changes = repairDoc(server, "repair");
    expect(changes).toEqual(["アクター actor_a のペルソナの呼び名が長すぎたので切り詰めた", "アクター actor_a のペルソナの IT の習熟を外した (値が正しくない)"]);
    // 表示用の読み (readModel) は、Y.Doc を直す前でも不正な習熟を外して要素を残す
    const fixed = rebuildModel(server).elements.find((e) => e.id === "actor_a") as { persona?: unknown };
    expect(fixed.persona).toEqual({ handle: "あ".repeat(200), goals: "目標" });
  });

  it("不正な IT の習熟は readModel(表示用)でも外れ、Y.Doc は repairDoc が直す。空のペルソナ {} は知らせなしで消える", () => {
    const doc = new Y.Doc();
    loadModel(doc, model());
    writeLong(doc, "actor_a", "persona", { itSkill: "bogus", goals: "目標" });
    expect((readModel(doc).elements.find((e) => e.id === "actor_a") as { persona?: unknown }).persona).toEqual({ goals: "目標" });
    expect((readRawModel(doc).elements.find((e) => e.id === "actor_a") as { persona?: unknown }).persona).toEqual({ itSkill: "bogus", goals: "目標" });
    expect(repairDoc(doc, "repair")).toHaveLength(1);
    expect((getRoots(doc).elements.get("actor_a") as Y.Map<unknown>).get("persona")).toEqual({ goals: "目標" });
    writeLong(doc, "actor_a", "persona", {});
    expect(repairDoc(doc, "repair")).toEqual([]);
    expect((getRoots(doc).elements.get("actor_a") as Y.Map<unknown>).has("persona")).toBe(false);
  });

  it("形が壊れた要素 (型が違う・項目が欠けた) は、これまでどおり外す", () => {
    const doc = new Y.Doc();
    loadModel(doc, model());
    writeLong(doc, "act_a", "name", 123 as unknown as string);
    expect(readModel(doc).elements.map((e) => e.id)).toEqual(["actor_a"]);
  });

  it("repairDoc が切り詰めを Y.Doc に書き、changes に出す (名前などの中身は出さない)。他の人にも届く", () => {
    const server = new Y.Doc();
    loadModel(server, model());
    const client = new Y.Doc();
    sync(server, client);
    writeLong(server, "act_a", "description", "秘密の説明".repeat(1000));
    expect(validateModel(JSON.parse(JSON.stringify(readRawModel(server)))).ok).toBe(false);

    const changes = repairDoc(server, "repair");
    expect(changes).toEqual(["作業 act_a の説明が長すぎたので切り詰めた"]);
    expect(changes.join("")).not.toContain("秘密");
    expect(((getRoots(server).elements.get("act_a") as Y.Map<unknown>).get("description") as string).length).toBe(4000);
    // 2 回目は直すものが無い
    expect(repairDoc(server, "repair")).toEqual([]);

    sync(server, client);
    const received = readRawModel(client);
    expect(validateModel(JSON.parse(JSON.stringify(received))).ok).toBe(true);
    expect(received.relations).toHaveLength(1);
  });

  it("切り詰めたあとにクライアントが別の項目を編集しても、説明は 4000 文字のまま", () => {
    const doc = new Y.Doc();
    loadModel(doc, model());
    writeLong(doc, "act_a", "description", "あ".repeat(4001));
    const before = rebuildModel(doc);
    const after: UntieModel = { ...before, elements: before.elements.map((e) => (e.id === "act_a" ? { ...e, name: "改名" } : e)) };
    applyModelDiff(doc, before, after, "local");
    // 説明は before と同じなので書き戻されない (Y.Doc の説明は 4001 のまま) が、読み出しはどちらも 4000 文字
    expect(rebuildModel(doc).elements.find((e) => e.id === "act_a")).toMatchObject({ name: "改名" });
    expect(rebuildModel(doc).elements.find((e) => e.id === "act_a")!.description).toHaveLength(4000);
  });

  it("ボードの名前・ファイル名・説明も切り詰める", () => {
    const doc = new Y.Doc();
    loadModel(doc, model());
    getRoots(doc).meta.set("name", "あ".repeat(201));
    getRoots(doc).meta.set("description", "あ".repeat(4001));
    (getRoots(doc).boards.get("board_main") as Y.Map<unknown>).set("name", "あ".repeat(201));
    const read = rebuildModel(doc);
    expect(read.meta.name).toHaveLength(200);
    expect(read.meta.description).toHaveLength(4000);
    expect(read.boards[0].name).toHaveLength(200);
    expect(validateModel(JSON.parse(JSON.stringify(read))).ok).toBe(true);
  });
});
