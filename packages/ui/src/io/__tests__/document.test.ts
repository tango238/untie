import { beforeEach, describe, expect, it, vi } from "vitest";
import { addElement } from "@untie/core/model/commands";
import { createHotelSample } from "@untie/core/sample";
import { hasUnsavedChanges, useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import { openDocument, openRecentDocument, parseModel, saveDocument, serializeModel } from "../document";
const st = () => useUntieStore.getState();
const recentPaths = async () => (await memory().recentFiles.load()).map((f) => f.path);

beforeEach(() => resetStore());

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
    expect(memory().saved[0]).toMatchObject({ path: null, name: "宿泊施設の業務 (サンプル).json" });
    expect(st().file).toEqual({ path: "/docs/宿泊施設の業務 (サンプル).json", name: "宿泊施設の業務 (サンプル).json" });
    expect(hasUnsavedChanges(st())).toBe(false);
    await saveDocument();
    expect(memory().saved[1]!.path).toBe("/docs/宿泊施設の業務 (サンプル).json");
    await saveDocument(true);
    expect(memory().saved[2]!.path).toBeNull();
    expect(parseModel(memory().saved[0]!.text).ok).toBe(true);
  });

  it("開くと置き換え、履歴を捨てて課題の分布と課題一覧を開く。未保存の変更があれば確かめ、断れば何もしない", async () => {
    const m = createHotelSample();
    m.meta.name = "別のモデル";
    memory().opened = { path: "/docs/b.json", name: "b.json", text: serializeModel(m) };
    st().dispatch((x) => addElement(x, { kind: "context", name: "x" }));
    memory().discard = false;
    await openDocument();
    expect(st().model.meta.name).not.toBe("別のモデル");
    memory().discard = true;
    await openDocument();
    expect(st().model.meta.name).toBe("別のモデル");
    expect(st().file).toEqual({ path: "/docs/b.json", name: "b.json" });
    expect(st().history.past).toHaveLength(0);
    expect(st().ui.currentBoardId).toBe("analysis:issues");
    expect(st().ui.rightPanel).toBe("issues");
    expect(hasUnsavedChanges(st())).toBe(false);
  });

  it("開けないファイルはエラーを出し、今のモデルを残す", async () => {
    memory().opened = { path: "/docs/c.json", name: "c.json", text: "{ broken" };
    const before = st().model;
    await openDocument();
    expect(st().model).toBe(before);
    const last = st().toasts[st().toasts.length - 1]!;
    expect(last).toMatchObject({ tone: "error" });
    expect(last.message).toMatch(/「c.json」を開けません/);
  });

  it("開いたファイル・保存したファイルを最近開いたファイルに足す。開けなかったファイルは足さない", async () => {
    memory().opened = { path: "/docs/c.json", name: "c.json", text: "{ broken" };
    await openDocument();
    expect(await recentPaths()).toEqual([]);
    memory().opened = { path: "/docs/b.json", name: "b.json", text: serializeModel(createHotelSample()) };
    await openDocument();
    expect(await recentPaths()).toEqual(["/docs/b.json"]);
    // 保存したファイルも足す。開いたものとは違う名前・場所に保存して、先頭に新しい path が来ることを見る
    const add = vi.spyOn(memory().recentFiles, "add");
    st().markSaved({ path: "/docs/other.json", name: "other.json" }, st().model);
    await saveDocument(true);
    expect(add).toHaveBeenCalledWith({ path: "/docs/other.json", name: "other.json" });
    expect(await recentPaths()).toEqual(["/docs/other.json", "/docs/b.json"]);
  });

  it("最近開いたファイルを開く。未保存の変更があれば確かめる", async () => {
    const m = createHotelSample();
    m.meta.name = "最近のモデル";
    memory().contents.set("/docs/r.json", serializeModel(m));
    st().dispatch((x) => addElement(x, { kind: "context", name: "x" }));
    memory().discard = false;
    await openRecentDocument({ name: "r.json", path: "/docs/r.json" });
    expect(st().model.meta.name).not.toBe("最近のモデル");
    memory().discard = true;
    await openRecentDocument({ name: "r.json", path: "/docs/r.json" });
    expect(st().model.meta.name).toBe("最近のモデル");
    expect(st().file).toEqual({ path: "/docs/r.json", name: "r.json" });
    expect(await recentPaths()).toEqual(["/docs/r.json"]);
  });

  it("最近開いたファイルが読めなければエラーを出して一覧から外し、今のモデルを残す", async () => {
    const entry = { name: "gone.json", path: "/docs/gone.json" };
    await memory().recentFiles.add(entry);
    const before = st().model;
    await openRecentDocument(entry);
    expect(st().model).toBe(before);
    expect(await recentPaths()).toEqual([]);
    expect(st().toasts[st().toasts.length - 1]!.message).toMatch(/「gone.json」を開けませんでした \(最近開いたファイルから外しました\)/);
  });
});
