import { beforeEach, describe, expect, it } from "vitest";
import { forgetSources, recallSources, rememberSources } from "../sourceRegistry";
import { memorySourceTree } from "../sourceTree";

const tree = memorySourceTree("api", { "a.ts": "1" });

beforeEach(() => forgetSources());

describe("sourceRegistry (登録したソースを、メモリの中だけで覚える)", () => {
  it("同じモデル (docSeq) では、覚えた登録をそのまま返す。返す配列は書き換えても覚えているものに響かない", () => {
    rememberSources(3, [{ label: "バックエンド", tree, fileCount: 1 }]);
    const a = recallSources(3);
    expect(a).toEqual([{ label: "バックエンド", tree, fileCount: 1 }]);
    a[0]!.label = "書き換え";
    expect(recallSources(3)[0]!.label).toBe("バックエンド");
  });

  it("別のモデルを開いた (docSeq が替わった) ら、取り違えないよう返さない", () => {
    rememberSources(3, [{ label: "", tree, fileCount: 1 }]);
    expect(recallSources(4)).toEqual([]);
    expect(recallSources(3)).toHaveLength(1);
  });

  it("何も選んでいない空の 1 行は覚えず、前に覚えたものも消す。forget で忘れる", () => {
    rememberSources(1, [{ label: "", tree, fileCount: 1 }]);
    rememberSources(1, [{ label: "", tree: null, fileCount: 0 }]);
    expect(recallSources(1)).toEqual([]);
    rememberSources(1, [{ label: "x", tree: null, fileCount: 0 }]);
    expect(recallSources(1)).toHaveLength(1);
    forgetSources();
    expect(recallSources(1)).toEqual([]);
  });
});
