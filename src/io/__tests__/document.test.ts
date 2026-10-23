import { beforeEach, describe, expect, it, vi } from "vitest";
import { addElement } from "../../model/commands";
import { createHotelSample } from "../../sample";
import { hasUnsavedChanges, useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

const files = vi.hoisted(() => ({
  opened: null as null | { path: string | null; name: string; text: string },
  saved: [] as { text: string; path: string | null; name: string }[],
  confirm: true,
}));

vi.mock("../file", () => ({
  openTextFile: async () => files.opened,
  saveTextFile: async (text: string, path: string | null, name: string) => {
    files.saved.push({ text, path, name });
    return { path: path ?? `/docs/${name}`, name: path ? path.split("/").pop()! : name };
  },
  confirmDiscard: async () => files.confirm,
}));

const { openDocument, parseModel, saveDocument, serializeModel } = await import("../document");
const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  files.opened = null;
  files.saved = [];
  files.confirm = true;
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

  it("開くと置き換え、履歴を捨てて作業のボードを開く。未保存の変更があれば確かめ、断れば何もしない", async () => {
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
    expect(st().ui.currentBoardId).toBe("fixed:activity");
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
});
