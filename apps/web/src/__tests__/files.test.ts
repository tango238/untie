import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@untie/ui/platform";
import { webPlatform } from "../platform";

let platform: Platform;
beforeEach(() => {
  platform = webPlatform();
});

// File System Access API の代わり。書いた中身を contents に残す
function fakeHandle(name: string, initial = "") {
  const handle = {
    name,
    contents: initial,
    getFile: async () => new File([handle.contents], name),
    createWritable: async () => {
      let buffer = "";
      return {
        write: async (text: string) => {
          buffer += text;
        },
        close: async () => {
          handle.contents = buffer;
        },
      };
    },
  };
  return handle;
}

const w = window as unknown as Record<string, unknown>;
const abort = () => Promise.reject(new DOMException("The user aborted a request.", "AbortError"));

afterEach(() => {
  delete w.showOpenFilePicker;
  delete w.showSaveFilePicker;
});

describe("ブラウザでのファイル (File System Access API あり)", () => {
  it("開いたファイルには、次の保存で上書きする", async () => {
    const handle = fakeHandle("hotel.json", "{\"a\":1}");
    w.showOpenFilePicker = vi.fn(async () => [handle]);
    w.showSaveFilePicker = vi.fn(abort);
    const opened = (await platform.openTextFile())!;
    expect(opened).toMatchObject({ name: "hotel.json", text: "{\"a\":1}" });
    expect(opened.path).toMatch(/^browser:/);
    expect(await platform.saveTextFile("{\"a\":2}", opened.path, "ignored.json")).toEqual({ path: opened.path, name: "hotel.json" });
    expect(handle.contents).toBe("{\"a\":2}");
    expect(w.showSaveFilePicker).not.toHaveBeenCalled();
  });

  it("保存先が無ければ選ばせ、選んだファイルに以後も上書きする", async () => {
    const handle = fakeHandle("new.json");
    w.showSaveFilePicker = vi.fn(async () => handle);
    const saved = (await platform.saveTextFile("one", null, "モデル.json"))!;
    expect(w.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "モデル.json" }));
    expect(saved.name).toBe("new.json");
    expect(handle.contents).toBe("one");
    await platform.saveTextFile("two", saved.path, "new.json");
    expect(handle.contents).toBe("two");
    expect(w.showSaveFilePicker).toHaveBeenCalledTimes(1);
  });

  it("選ぶのを取り消したら null", async () => {
    w.showOpenFilePicker = vi.fn(abort);
    w.showSaveFilePicker = vi.fn(abort);
    expect(await platform.openTextFile()).toBeNull();
    expect(await platform.saveTextFile("x", null, "a.json")).toBeNull();
  });

  it("書き込みの失敗は呼ぶ側に伝える", async () => {
    w.showSaveFilePicker = vi.fn(async () => ({
      name: "a.json",
      createWritable: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    }));
    await expect(platform.saveTextFile("x", null, "a.json")).rejects.toThrow("denied");
  });
});

describe("ブラウザでの確認ダイアログ・外部リンク・閉じる前の確認", () => {
  it("Web では window.confirm で確かめ、外部リンクは別のタブで開く", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(await platform.confirmDiscard("破棄しますか？")).toBe(false);
    expect(await platform.confirmDiscard("破棄しますか？")).toBe(true);
    expect(confirm).toHaveBeenCalledWith("破棄しますか？");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await platform.openExternalUrl("https://example.com/");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener");
    confirm.mockRestore();
    open.mockRestore();
  });

  it("閉じる前の確認は、保存していない変更があるときだけブラウザに任せ、登録を外せる", () => {
    let dirty = false;
    const off = platform.onCloseRequested(() => dirty);
    const fire = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    dirty = true;
    expect(fire()).toBe(true);
    off();
    expect(fire()).toBe(false);
  });
});

describe("ブラウザでのファイル (File System Access API なし)", () => {
  it("保存はダウンロードになり、保存先は持たない", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    expect(platform.canReopenFiles()).toBe(false);
    expect(await platform.saveTextFile("x", null, "a.json")).toEqual({ path: null, name: "a.json" });
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe("最近開いたファイル (Web)", () => {
  it("File System Access API の無いブラウザでは、開き直せないので一覧を持たない", async () => {
    await platform.recentFiles.add({ path: "browser:1", name: "a.json" });
    expect(await platform.recentFiles.load()).toEqual([]);
  });

  it("開いたファイルのハンドルは browser:<番号> の path で引き、path の無いファイルは足さない", async () => {
    const handle = fakeHandle("hotel.json", "{}");
    w.showOpenFilePicker = vi.fn(async () => [handle]);
    const a = (await platform.openTextFile())!;
    const b = (await platform.openTextFile())!;
    expect(a.path).toBe("browser:1");
    expect(b.path).toBe("browser:2");
    // indexedDB の無い環境 (jsdom) では覚えないだけで、止まらない
    await expect(platform.recentFiles.add(a)).resolves.toBeUndefined();
    await expect(platform.recentFiles.add({ path: null, name: "x.json" })).resolves.toBeUndefined();
  });

  it("一覧のファイルを読み直すときに、読み書きの許可を求める。断られたら理由付きで失敗する", async () => {
    const handle = Object.assign(fakeHandle("a.json", "{\"a\":1}"), {
      queryPermission: vi.fn(async () => "prompt"),
      requestPermission: vi.fn(async () => "granted"),
    });
    const opened = await platform.recentFiles.read({ name: "a.json", handle: handle as unknown as FileSystemFileHandle });
    expect(opened).toMatchObject({ name: "a.json", text: "{\"a\":1}" });
    expect(opened.path).toMatch(/^browser:/);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    handle.requestPermission.mockResolvedValueOnce("denied");
    await expect(platform.recentFiles.read({ name: "a.json", handle: handle as unknown as FileSystemFileHandle })).rejects.toThrow("許可がありません");
  });
});

describe("サーバーとの接続 (Platform)", () => {
  it("serverOrigin は自分のオリジン、authorize はリクエストをそのまま返す (Cookie で認証)", async () => {
    expect(platform.serverOrigin()).toBe(location.origin);
    const init = { method: "GET", headers: { Accept: "application/json" } };
    expect(await platform.authorize(init)).toBe(init);
  });
});
