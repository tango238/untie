import { afterEach, describe, expect, it, vi } from "vitest";
import { openTextFile, saveTextFile } from "../file";

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
    const opened = (await openTextFile())!;
    expect(opened).toMatchObject({ name: "hotel.json", text: "{\"a\":1}" });
    expect(opened.path).toMatch(/^browser:/);
    expect(await saveTextFile("{\"a\":2}", opened.path, "ignored.json")).toEqual({ path: opened.path, name: "hotel.json" });
    expect(handle.contents).toBe("{\"a\":2}");
    expect(w.showSaveFilePicker).not.toHaveBeenCalled();
  });

  it("保存先が無ければ選ばせ、選んだファイルに以後も上書きする", async () => {
    const handle = fakeHandle("new.json");
    w.showSaveFilePicker = vi.fn(async () => handle);
    const saved = (await saveTextFile("one", null, "モデル.json"))!;
    expect(w.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "モデル.json" }));
    expect(saved.name).toBe("new.json");
    expect(handle.contents).toBe("one");
    await saveTextFile("two", saved.path, "new.json");
    expect(handle.contents).toBe("two");
    expect(w.showSaveFilePicker).toHaveBeenCalledTimes(1);
  });

  it("選ぶのを取り消したら null", async () => {
    w.showOpenFilePicker = vi.fn(abort);
    w.showSaveFilePicker = vi.fn(abort);
    expect(await openTextFile()).toBeNull();
    expect(await saveTextFile("x", null, "a.json")).toBeNull();
  });

  it("書き込みの失敗は呼ぶ側に伝える", async () => {
    w.showSaveFilePicker = vi.fn(async () => ({
      name: "a.json",
      createWritable: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    }));
    await expect(saveTextFile("x", null, "a.json")).rejects.toThrow("denied");
  });
});

describe("ブラウザでのファイル (File System Access API なし)", () => {
  it("保存はダウンロードになり、保存先は持たない", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    expect(await saveTextFile("x", null, "a.json")).toEqual({ path: null, name: "a.json" });
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});
