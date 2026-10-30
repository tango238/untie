import { beforeEach, describe, expect, it, vi } from "vitest";
import { addElement } from "../../model/commands";
import { createHotelSample } from "../../sample";
import { hasUnsavedChanges, useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

const files = vi.hoisted(() => ({
  opened: null as null | { path: string | null; name: string; text: string },
  saved: [] as { text: string; path: string | null; name: string }[],
  confirm: true,
  recent: [] as { path: string | null; name: string }[],
  removed: [] as unknown[],
  readRecent: null as null | (() => Promise<{ path: string | null; name: string; text: string }>),
}));

vi.mock("../file", () => ({
  openTextFile: async () => files.opened,
  saveTextFile: async (text: string, path: string | null, name: string) => {
    files.saved.push({ text, path, name });
    return { path: path ?? `/docs/${name}`, name: path ? path.split("/").pop()! : name };
  },
  confirmDiscard: async () => files.confirm,
}));

vi.mock("../recent", () => ({
  addRecentFile: async (f: { path: string | null; name: string }) => {
    files.recent.push(f);
  },
  removeRecentFile: async (f: unknown) => {
    files.removed.push(f);
  },
  readRecentFile: () => files.readRecent!(),
}));

const { openDocument, openRecentDocument, parseModel, saveDocument, serializeModel } = await import("../document");
const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  files.opened = null;
  files.saved = [];
  files.confirm = true;
  files.recent = [];
  files.removed = [];
  files.readRecent = null;
});

describe("保存・読み込み", () => {
  it("保存した JSON を読むと同じモデルに戻る", () => {
    const m = createHotelSample();
    const parsed = parseModel(serializeModel(m));
    expect(parsed.ok && parsed.model).toEqual(m);
  });

  it("壊れた JSON・スキーマ違反・参照切れは理由付きで拒否する", () => {
    expect(parseModel("{").ok).toBe(false);
    const r1 = parseModel(JSON.stringify({ version: 1 }));
    expect(r1.ok).toBe(false);
    const m = createHotelSample();
    const broken = { ...m, relations: [...m.relations, { id: "rel_x", kind: "activityUsecase", sourceId: "act_clean", targetId: "nope" }] };
    const r2 = parseModel(JSON.stringify(broken));
    expect(r2.ok ? [] : r2.errors.join()).toMatch(/nope/);
  });

  it("保存すると保存先を覚え、次からは同じ場所に上書きする。別名で保存は選び直す", async () => {
    st().dispatch((m) => addElement(m, { kind: "context", name: "x" }));
    expect(hasUnsavedChanges(st())).toBe(true);
    expect(await saveDocument()).toBe(true);
    expect(files.saved[0]).toMatchObject({ path: null, name: "宿泊施設の業務 (サンプル).json" });
    expect(st().file).toEqual({ path: "/docs/宿泊施設の業務 (サンプル).json", name: "宿泊施設の業務 (サンプル).json" });
    expect(hasUnsavedChanges(st())).toBe(false);
    await saveDocument();
    expect(files.saved[1]!.path).toBe("/docs/宿泊施設の業務 (サンプル).json");
    await saveDocument(true);
    expect(files.saved[2]!.path).toBeNull();
    expect(parseModel(files.saved[0]!.text).ok).toBe(true);
  });

  it("開くと置き換え、履歴を捨てて課題の分布と課題一覧を開く。未保存の変更があれば確かめ、断れば何もしない", async () => {
    const m = createHotelSample();
    m.meta.name = "別のモデル";
    files.opened = { path: "/docs/b.json", name: "b.json", text: serializeModel(m) };
    st().dispatch((x) => addElement(x, { kind: "context", name: "x" }));
    files.confirm = false;
    await openDocument();
    expect(st().model.meta.name).not.toBe("別のモデル");
    files.confirm = true;
    await openDocument();
    expect(st().model.meta.name).toBe("別のモデル");
    expect(st().file).toEqual({ path: "/docs/b.json", name: "b.json" });
    expect(st().history.past).toHaveLength(0);
    expect(st().ui.currentBoardId).toBe("analysis:issues");
    expect(st().ui.rightPanel).toBe("issues");
    expect(hasUnsavedChanges(st())).toBe(false);
  });

  it("開けないファイルはエラーを出し、今のモデルを残す", async () => {
    files.opened = { path: "/docs/c.json", name: "c.json", text: "{ broken" };
    const before = st().model;
    await openDocument();
    expect(st().model).toBe(before);
    const last = st().toasts[st().toasts.length - 1]!;
    expect(last).toMatchObject({ tone: "error" });
    expect(last.message).toMatch(/「c.json」を開けません/);
  });

  it("開いたファイル・保存したファイルを最近開いたファイルに足す。開けなかったファイルは足さない", async () => {
    files.opened = { path: "/docs/c.json", name: "c.json", text: "{ broken" };
    await openDocument();
    expect(files.recent).toEqual([]);
    files.opened = { path: "/docs/b.json", name: "b.json", text: serializeModel(createHotelSample()) };
    await openDocument();
    await saveDocument(true);
    expect(files.recent.map((f) => f.path)).toEqual(["/docs/b.json", "/docs/b.json"]);
  });

  it("最近開いたファイルを開く。未保存の変更があれば確かめる", async () => {
    const m = createHotelSample();
    m.meta.name = "最近のモデル";
    files.readRecent = async () => ({ path: "/docs/r.json", name: "r.json", text: serializeModel(m) });
    st().dispatch((x) => addElement(x, { kind: "context", name: "x" }));
    files.confirm = false;
    await openRecentDocument({ name: "r.json", path: "/docs/r.json" });
    expect(st().model.meta.name).not.toBe("最近のモデル");
    files.confirm = true;
    await openRecentDocument({ name: "r.json", path: "/docs/r.json" });
    expect(st().model.meta.name).toBe("最近のモデル");
    expect(st().file).toEqual({ path: "/docs/r.json", name: "r.json" });
    expect(files.recent.map((f) => f.path)).toEqual(["/docs/r.json"]);
  });

  it("最近開いたファイルが読めなければエラーを出して一覧から外し、今のモデルを残す", async () => {
    files.readRecent = async () => {
      throw "/docs/gone.json を読めませんでした: No such file";
    };
    const before = st().model;
    const entry = { name: "gone.json", path: "/docs/gone.json" };
    await openRecentDocument(entry);
    expect(st().model).toBe(before);
    expect(files.removed).toEqual([entry]);
    expect(st().toasts[st().toasts.length - 1]!.message).toMatch(/「gone.json」を開けませんでした \(最近開いたファイルから外しました\)/);
  });
});
