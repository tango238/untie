import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createNetshopSample } from "@untie/core/sample";
import { emptyDomain } from "@untie/core/model/types";
import { Toolbar } from "../../components/Toolbar";
import { useUntieStore } from "../../store";
import { memory } from "../../test/platform";
import { resetStore } from "../../test/utils";
import { exportDomainDocsToFolder } from "../document";
import { crc32, makeZip } from "../zip";

const st = () => useUntieStore.getState();
const lastToast = () => st().toasts[st().toasts.length - 1]!;

beforeEach(() => {
  resetStore(createNetshopSample());
  useUntieStore.setState({ toasts: [] });
  memory().folder = "/repo/docs/domain";
  memory().savedFolders.length = 0;
});

describe("ドメインモデルの書き出し (distill-ddd)", () => {
  it("選んだフォルダへ、docs/domain の md とセッションのファイルを書き出し、図に出ないものの数を知らせる", async () => {
    expect(await exportDomainDocsToFolder()).toBe(true);
    const saved = memory().savedFolders[0]!;
    expect(saved.folder).toBe("/repo/docs/domain");
    expect(saved.files.map((f) => f.name)).toEqual(["event-storming.md", "bounded-contexts.md", "context-map.md", "aggregates.md", "domain-events.md", "glossary.md", ".ddd-session.json"]);
    expect(saved.files.find((f) => f.name === "aggregates.md")!.text).toContain("### Order (Bounded Context: 受注)");
    expect(saved.options).toEqual({ zipName: "ネットショップの業務 (サンプル)-domain.zip", zipFolder: "docs/domain", keep: [".ddd-session.json"] });
    // セッションの日付は今日
    expect(JSON.parse(saved.files.find((f) => f.name === ".ddd-session.json")!.text).lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lastToast().message).toContain("ドメインモデルを「/repo/docs/domain」に書き出しました (7 ファイル)");
    expect(lastToast().message).toContain("distill-ddd の図に出ないものが");
  });

  it("distill-ddd のセッションのファイルが既にあれば、上書きせずに残して、その旨を知らせる", async () => {
    memory().existingFiles.add(".ddd-session.json");
    expect(await exportDomainDocsToFolder()).toBe(true);
    const saved = memory().savedFolders[0]!;
    expect(saved.files.map((f) => f.name)).not.toContain(".ddd-session.json");
    expect(saved.files).toHaveLength(6);
    expect(lastToast().message).toContain("(6 ファイル)。.ddd-session.json は既にあるので、そのままにしました");
    memory().existingFiles.clear();
  });

  it("フォルダを選ぶのを取り消したら何もしない。保存したドメインモデルが無ければ、その旨を知らせる", async () => {
    memory().folder = null;
    expect(await exportDomainDocsToFolder()).toBe(false);
    expect(st().toasts).toEqual([]);
    resetStore({ ...createNetshopSample(), domain: emptyDomain() });
    memory().folder = "/x";
    expect(await exportDomainDocsToFolder()).toBe(false);
    expect(memory().savedFolders).toEqual([]);
    expect(lastToast()).toMatchObject({ tone: "error" });
  });

  it("ファイルのメニューから書き出せる (保存したドメインモデルがあるときだけ項目を出す)", async () => {
    const { unmount } = render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: /^ファイル/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /ドメインモデルを書き出す \(distill-ddd\)/ }));
    });
    expect(memory().savedFolders).toHaveLength(1);
    unmount();
    resetStore({ ...createNetshopSample(), domain: emptyDomain() });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: /^ファイル/ }));
    expect(screen.queryByRole("menuitem", { name: /ドメインモデルを書き出す/ })).toBeNull();
  });
});

describe("makeZip", () => {
  it("圧縮なしの zip を作る (ファイル名は UTF-8。中身と CRC が読み戻せる)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const files = [
      { path: "docs/domain/aggregates.md", text: "# Aggregates\n集約\n" },
      { path: "docs/domain/.ddd-session.json", text: "{}\n" },
    ];
    const zip = makeZip(files);
    const view = new DataView(zip.buffer);
    const decoder = new TextDecoder();
    // 末尾のレコードから、セントラルディレクトリを辿って読み戻す
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    let at = view.getUint32(end + 16, true);
    const read: { path: string; text: string }[] = [];
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      const path = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      const dataAt = local + 30 + view.getUint16(local + 26, true);
      const data = zip.subarray(dataAt, dataAt + size);
      expect(crc32(data)).toBe(view.getUint32(at + 16, true));
      read.push({ path, text: decoder.decode(data) });
      at += 46 + nameLength;
    }
    expect(read).toEqual(files);
    // いつも同じバイト列になる (日付を入れない)
    expect(makeZip(files)).toEqual(zip);
  });
});
