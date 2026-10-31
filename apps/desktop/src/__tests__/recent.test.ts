import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RECENT_LIMIT, type Platform } from "@untie/ui/platform";
import { desktopPlatform } from "../platform";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let recent: Platform["recentFiles"];

beforeEach(() => {
  localStorage.clear();
  recent = desktopPlatform().recentFiles;
});

describe("最近開いたファイル (デスクトップアプリ)", () => {
  it("新しい順に並べ、同じファイルは先頭へ移し、最大 5 件にする", async () => {
    for (let i = 1; i <= 6; i++) await recent.add({ path: `/docs/${i}.json`, name: `${i}.json` });
    await recent.add({ path: "/docs/4.json", name: "4.json" });
    const list = await recent.load();
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list.map((f) => f.name)).toEqual(["4.json", "6.json", "5.json", "3.json", "2.json"]);
  });

  it("パスの無いファイル (まだ保存していない) は足さない。外す・消去できる", async () => {
    await recent.add({ path: null, name: "x.json" });
    expect(await recent.load()).toEqual([]);
    await recent.add({ path: "/docs/a.json", name: "a.json" });
    await recent.add({ path: "/docs/b.json", name: "b.json" });
    await recent.remove({ path: "/docs/a.json", name: "a.json" });
    expect((await recent.load()).map((f) => f.name)).toEqual(["b.json"]);
    await recent.clear();
    expect(await recent.load()).toEqual([]);
  });

  it("壊れた記録は空とみなす", async () => {
    localStorage.setItem("untie.recentFiles", "{ broken");
    expect(await recent.load()).toEqual([]);
  });

  it("パスから読み直す", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("{}");
    expect(await recent.read({ path: "/docs/a.json", name: "a.json" })).toEqual({ path: "/docs/a.json", name: "a.json", text: "{}" });
    expect(invoke).toHaveBeenCalledWith("read_model_file", { path: "/docs/a.json" });
  });
});
