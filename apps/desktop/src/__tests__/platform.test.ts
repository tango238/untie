import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Platform } from "@untie/ui/platform";
import { desktopPlatform } from "../platform";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => opener);
const win = vi.hoisted(() => ({ handler: null as null | ((e: { preventDefault: () => void }) => Promise<void>), off: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: typeof win.handler) => {
      win.handler = h;
      return win.off;
    },
  }),
}));

let platform: Platform;
beforeEach(() => {
  vi.resetAllMocks();
  win.handler = null;
  platform = desktopPlatform();
});

describe("デスクトップアプリのファイル", () => {
  it("ダイアログで選んだパスを Rust のコマンドで読む。取り消したら null", async () => {
    dialog.open.mockResolvedValueOnce("/docs/hotel.json");
    vi.mocked(invoke).mockResolvedValueOnce("{}");
    expect(await platform.openTextFile()).toEqual({ path: "/docs/hotel.json", name: "hotel.json", text: "{}" });
    expect(invoke).toHaveBeenCalledWith("read_model_file", { path: "/docs/hotel.json" });
    dialog.open.mockResolvedValueOnce(null);
    expect(await platform.openTextFile()).toBeNull();
  });

  it("path があればそこへ上書きし、無ければ保存先を選ばせる。取り消したら null", async () => {
    expect(await platform.saveTextFile("x", "/docs/a.json", "ignored.json")).toEqual({ path: "/docs/a.json", name: "a.json" });
    expect(invoke).toHaveBeenCalledWith("write_model_file", { path: "/docs/a.json", contents: "x" });
    expect(dialog.save).not.toHaveBeenCalled();
    dialog.save.mockResolvedValueOnce("/docs/new.json");
    expect(await platform.saveTextFile("y", null, "モデル.json")).toEqual({ path: "/docs/new.json", name: "new.json" });
    expect(dialog.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "モデル.json" }));
    dialog.save.mockResolvedValueOnce(null);
    expect(await platform.saveTextFile("z", null, "a.json")).toBeNull();
  });

  it("確認ダイアログと外部リンクはネイティブのものを使う", async () => {
    dialog.ask.mockResolvedValueOnce(true);
    expect(await platform.confirmDiscard("破棄しますか？", "破棄する")).toBe(true);
    expect(dialog.ask).toHaveBeenCalledWith("破棄しますか？", expect.objectContaining({ okLabel: "破棄する", kind: "warning" }));
    await platform.openExternalUrl("https://example.com/");
    expect(opener.openUrl).toHaveBeenCalledWith("https://example.com/");
  });
});

describe("デスクトップアプリの API キー (キーチェーン)", () => {
  it("Rust のコマンドで読み書きし、ブラウザへの保存は無い", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("sk-a").mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    expect(await platform.secrets.get("claude")).toBe("sk-a");
    expect(invoke).toHaveBeenCalledWith("get_api_key", { provider: "claude" });
    await platform.secrets.set("claude", "sk-b", { remember: true });
    expect(invoke).toHaveBeenCalledWith("set_api_key", { provider: "claude", key: "sk-b" });
    await platform.secrets.delete("claude");
    expect(invoke).toHaveBeenCalledWith("delete_api_key", { provider: "claude" });
    expect(platform.secrets.isRemembered("claude")).toBe(false);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await platform.secrets.get("gemini")).toBeNull();
  });
});

describe("デスクトップアプリの閉じる前の確認", () => {
  const closeEvent = () => ({ preventDefault: vi.fn() });
  const ready = () => vi.waitFor(() => expect(win.handler).not.toBeNull());

  it("変更が無ければそのまま閉じ、あれば確かめて、断られたら止める", async () => {
    let dirty = false;
    platform.onCloseRequested(() => dirty);
    await ready();
    let e = closeEvent();
    await win.handler!(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(dialog.ask).not.toHaveBeenCalled();
    dirty = true;
    dialog.ask.mockResolvedValueOnce(false);
    e = closeEvent();
    await win.handler!(e);
    expect(e.preventDefault).toHaveBeenCalled();
    dialog.ask.mockResolvedValueOnce(true);
    e = closeEvent();
    await win.handler!(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("登録を外すと、ウィンドウの監視をやめる", async () => {
    const off = platform.onCloseRequested(() => false);
    await ready();
    off();
    await vi.waitFor(() => expect(win.off).toHaveBeenCalled());
  });

  it("登録が済む前に外しても、済んだところで監視をやめる", async () => {
    const off = platform.onCloseRequested(() => false);
    off();
    expect(win.off).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(win.off).toHaveBeenCalled());
  });
});

describe("サーバーとの接続", () => {
  afterEach(() => localStorage.removeItem("untie.serverOrigin"));

  it("serverOrigin は localStorage の untie.serverOrigin のオリジン。無ければ空 (サーバー未設定)", () => {
    expect(platform.serverOrigin()).toBe("");
    localStorage.setItem("untie.serverOrigin", "https://untie.example.com");
    expect(platform.serverOrigin()).toBe("https://untie.example.com");
  });

  it("serverOrigin は URL として読み、パスや末尾のスラッシュは落とす。http(s) 以外や読めないものは空", () => {
    for (const [value, expected] of [
      ["https://untie.example.com/", "https://untie.example.com"],
      ["http://localhost:8787/app/x?y=1#z", "http://localhost:8787"],
      ["untie.example.com", ""],
      ["ftp://untie.example.com", ""],
      ["javascript:alert(1)", ""],
      ["not a url", ""],
      ["", ""],
    ] as const) {
      localStorage.setItem("untie.serverOrigin", value);
      expect(platform.serverOrigin(), value).toBe(expected);
    }
  });

  it("login は次の段階まで未対応", async () => {
    await expect(platform.login("google", "#/")).rejects.toThrow("デスクトップ版のログインは次の段階で対応します");
  });

  it("authorize は 6 段階目まで init をそのまま返す (キーチェーンは読まない)", async () => {
    const init = { method: "GET", headers: { Accept: "application/json" } };
    expect(await platform.authorize(init)).toBe(init);
    expect(invoke).not.toHaveBeenCalled();
  });
});
