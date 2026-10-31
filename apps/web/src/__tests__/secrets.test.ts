import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStore } from "@untie/ui/platform";
import { webPlatform } from "../platform";

let secrets: SecretStore;
const deleteApiKey = (k: string) => secrets.delete(k);
const getApiKey = (k: string) => secrets.get(k);
const isApiKeyRemembered = (k: string) => secrets.isRemembered(k);
const setApiKey = (k: string, v: string, o?: { remember?: boolean }) => secrets.set(k, v, o);

beforeEach(async () => {
  secrets = webPlatform().secrets;
  localStorage.clear();
  await deleteApiKey("claude");
  vi.restoreAllMocks();
});

describe("API キー (Web の secrets)", () => {
  it("ふだんはメモリにだけ持ち、localStorage には置かない", async () => {
    await setApiKey("claude", " sk-a ");
    expect(await getApiKey("claude")).toBe("sk-a");
    expect(isApiKeyRemembered("claude")).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("remember なら localStorage にも置き、再読み込みの後 (メモリが空) でも読める", async () => {
    localStorage.setItem("untie.apiKey.gemini", "g-key");
    expect(await getApiKey("gemini")).toBe("g-key");
    expect(isApiKeyRemembered("gemini")).toBe(true);
    await setApiKey("claude", "sk-b", { remember: true });
    expect(localStorage.getItem("untie.apiKey.claude")).toBe("sk-b");
    await deleteApiKey("gemini");
  });

  it("localStorage に書けないときは理由付きで失敗し、タブの間は使える", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(setApiKey("claude", "sk-c", { remember: true })).rejects.toThrow(/このブラウザには保存できませんでした/);
    expect(await getApiKey("claude")).toBe("sk-c");
  });

  it("localStorage が読めないときは保存されていないとみなす", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(await getApiKey("codex")).toBeNull();
    expect(isApiKeyRemembered("codex")).toBe(false);
  });
});
