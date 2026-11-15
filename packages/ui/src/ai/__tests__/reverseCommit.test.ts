// 段階の結果の反映 (commitStageModel) と、AI のペインの会話への足し込み (appendContext)
import { beforeEach, describe, expect, it } from "vitest";
import { emptyModel } from "@untie/core/model/types";
import { useAgentStore } from "../agentStore";
import { agentIsEditing, commitStageModel } from "../reverseCommit";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

beforeEach(() => {
  resetStore(emptyModel("テスト"));
  useAgentStore.setState({ items: [], running: false });
});

describe("commitStageModel: AI のペインの編集中は反映しない", () => {
  const next = () => ({ ...useUntieStore.getState().model, meta: { ...useUntieStore.getState().model.meta, name: "段階の結果" } });

  it("AI のペインが実行中なら断る。モデルも履歴も変わらない", () => {
    const st = () => useUntieStore.getState();
    const base = st().model;
    useAgentStore.setState({ running: true });
    expect(agentIsEditing()).toBe(true);
    const r = commitStageModel(base, next(), st().docSeq);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/AI のペインが作業中/);
    expect(st().model).toBe(base);
    expect(st().history.past).toHaveLength(0);
  });

  it("AI のペインの編集の途中 (beginAgentEdit〜endAgentEdit) も断る。ペインの履歴 1 件に段階の結果が混ざらない", () => {
    const st = () => useUntieStore.getState();
    const base = st().model;
    st().beginAgentEdit();
    expect(agentIsEditing()).toBe(true);
    expect(commitStageModel(base, next(), st().docSeq).ok).toBe(false);
    st().endAgentEdit();
    expect(agentIsEditing()).toBe(false);
    expect(commitStageModel(base, next(), st().docSeq)).toEqual({ ok: true });
    expect(st().history.past).toHaveLength(1);
  });
});

describe("appendContext: 会話を置き換えずに足す", () => {
  it("すでにある表示の行を残し、あとに足す。ペインを開く。作業中は何もしない", () => {
    useAgentStore.setState({ items: [{ id: 1, role: "user", text: "前の会話" }] });
    expect(useAgentStore.getState().appendContext([{ role: "user", text: "u" }, { role: "assistant", text: "a" }], [{ role: "info", text: "知らせ" }])).toBe(true);
    const s = useAgentStore.getState();
    expect(s.items.map((i) => i.text)).toEqual(["前の会話", "知らせ"]);
    expect(s.open).toBe(true);
    useAgentStore.setState({ running: true });
    expect(useAgentStore.getState().appendContext([], [{ role: "info", text: "足さない" }])).toBe(false);
    expect(useAgentStore.getState().items).toHaveLength(2);
  });

  it("continueFrom は置き換える (会話が無いときの最初の 1 回だけ使う)", () => {
    useAgentStore.setState({ items: [{ id: 1, role: "user", text: "前の会話" }] });
    useAgentStore.getState().continueFrom([], [{ role: "info", text: "新しい会話" }]);
    expect(useAgentStore.getState().items.map((i) => i.text)).toEqual(["新しい会話"]);
  });
});
