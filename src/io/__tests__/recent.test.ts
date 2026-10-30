import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RECENT_LIMIT, addRecentFile, clearRecentFiles, loadRecentFiles, readRecentFile, removeRecentFile } from "../recent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const w = window as unknown as Record<string, unknown>;

describe("最近開いたファイル (デスクトップアプリ)", () => {
  beforeEach(() => {
    w.__TAURI_INTERNALS__ = {};
    localStorage.clear();
  });
  afterEach(() => {
    delete w.__TAURI_INTERNALS__;
  });

  it("新しい順に並べ、同じファイルは先頭へ移し、最大 5 件にする", async () => {
    for (let i = 1; i <= 6; i++) await addRecentFile({ path: `/docs/${i}.json`, name: `${i}.json` });
    await addRecentFile({ path: "/docs/4.json", name: "4.json" });
    const list = await loadRecentFiles();
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list.map((f) => f.name)).toEqual(["4.json", "6.json", "5.json", "3.json", "2.json"]);
  });

  it("パスの無いファイル (まだ保存していない) は足さない。外す・消去できる", async () => {
    await addRecentFile({ path: null, name: "x.json" });
    expect(await loadRecentFiles()).toEqual([]);
    await addRecentFile({ path: "/docs/a.json", name: "a.json" });
    await addRecentFile({ path: "/docs/b.json", name: "b.json" });
    await removeRecentFile({ path: "/docs/a.json", name: "a.json" });
    expect((await loadRecentFiles()).map((f) => f.name)).toEqual(["b.json"]);
    await clearRecentFiles();
    expect(await loadRecentFiles()).toEqual([]);
  });

  it("壊れた記録は空とみなす", async () => {
    localStorage.setItem("untie.recentFiles", "{ broken");
    expect(await loadRecentFiles()).toEqual([]);
  });

  it("パスから読み直す", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("{}");
    expect(await readRecentFile({ path: "/docs/a.json", name: "a.json" })).toEqual({ path: "/docs/a.json", name: "a.json", text: "{}" });
    expect(invoke).toHaveBeenCalledWith("read_model_file", { path: "/docs/a.json" });
  });
});

describe("最近開いたファイル (File System Access API の無いブラウザ)", () => {
  it("開き直せないので一覧を持たない", async () => {
    await addRecentFile({ path: "browser:1", name: "a.json" });
    expect(await loadRecentFiles()).toEqual([]);
  });
});
