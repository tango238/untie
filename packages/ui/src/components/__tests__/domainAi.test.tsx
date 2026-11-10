import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDomainDraft, type DomainDraft } from "@untie/core/model/domainDraft";
import { emptyDomain, type UntieModel } from "@untie/core/model/types";
import { createNetshopSample } from "@untie/core/sample";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";

const fake = vi.hoisted(() => ({ key: "k" as string | null, calls: [] as string[], draft: null as unknown, error: null as string | null }));
vi.mock("../../ai/keys", () => ({ getApiKey: async () => fake.key, setApiKey: async () => {}, deleteApiKey: async () => {} }));
vi.mock("../../ai/designDomain", () => ({
  generateDomainDraft: async (model: UntieModel, systemId: string) => {
    fake.calls.push(systemId);
    if (fake.error) throw new Error(fake.error);
    const r = applyDomainDraft(model, { systemId, draft: fake.draft as DomainDraft });
    if (!r.ok) throw new Error(r.reason);
    return { draft: fake.draft, summary: r.summary };
  },
}));

const { DomainBoard } = await import("../design/DomainBoard");
const { useAgentStore } = await import("../../ai/agentStore");
const st = () => useUntieStore.getState();

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixStub {
  m22 = 1;
  constructor(_init?: string) {}
}

const draft: DomainDraft = {
  contexts: [{ name: "販売", english: "Sales", subdomain: "core", contextIds: ["ctx_order"], aggregates: [{ english: "Order", rootInformationId: "info_order", commands: [{ usecaseId: "uc_confirm_order", english: "ConfirmOrder" }] }] }],
};

function start(withDomain: boolean) {
  const sample = createNetshopSample();
  resetStore(withDomain ? sample : { ...sample, domain: emptyDomain() });
  act(() => st().enterDesign("sys_oms"));
  act(() => st().setCurrentBoard("design:domain"));
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixStub;
  localStorage.clear();
  useUntieStore.setState({ cloud: null, toasts: [] });
  fake.key = "k";
  fake.calls = [];
  fake.draft = draft;
  fake.error = null;
});

describe("ドメインボードの AI", () => {
  it("AI で下書き: 保存した判断が無ければ、そのまま作って保存し、結果を知らせる", async () => {
    start(false);
    render(<DomainBoard />);
    const button = await screen.findByRole("button", { name: "AI で下書き" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(st().model.domain.contexts).toHaveLength(1));
    expect(fake.calls).toEqual(["sys_oms"]);
    expect(st().model.domain.contexts[0]).toMatchObject({ name: "販売", english: "Sales", systemIds: ["sys_oms"] });
    expect(st().model.domain.commands[0]).toMatchObject({ english: "ConfirmOrder", source: { usecaseId: "uc_confirm_order" } });
    expect(st().toasts[st().toasts.length - 1]!.message).toContain("下書きを作りました (コンテキスト 1・集約 1・コマンド 1・イベント 0)");
    // 1 回の変更なので、元に戻すで全部戻る
    act(() => st().undo());
    expect(st().model.domain.contexts).toEqual([]);
  });

  it("このシステムだけのコンテキストがあれば、置き換える前に確認する。ほかのシステムのコンテキストは残る", async () => {
    start(true);
    render(<DomainBoard />);
    const button = await screen.findByRole("button", { name: "AI で下書き" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("境界づけられたコンテキスト 3 つ");
    expect(fake.calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "置き換える" }));
    await waitFor(() => expect(st().model.domain.contexts.map((c) => c.english)).toEqual(["Payment", "Accounting", "Sales"]));
  });

  it("失敗したら理由を知らせ、何も変えない。API キーが無ければボタンを押せず、設定への案内を出す", async () => {
    start(false);
    fake.error = "AI がドメインモデルの下書きを提出しませんでした。もう一度試してください。";
    const { unmount } = render(<DomainBoard />);
    const button = await screen.findByRole("button", { name: "AI で下書き" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(st().toasts[st().toasts.length - 1]).toMatchObject({ tone: "error" }));
    expect(st().model.domain.contexts).toEqual([]);
    unmount();
    fake.key = null;
    render(<DomainBoard />);
    await screen.findByText(/を使うには、/);
    expect((screen.getByRole("button", { name: "AI で下書き" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "AI と決める" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "AI の設定" }));
    expect(useAgentStore.getState().settingsOpen).toBe(true);
    act(() => useAgentStore.getState().setSettingsOpen(false));
  });

  it("閲覧専用では、AI のボタンを出さない", async () => {
    start(true);
    act(() => st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never }));
    act(() => st().enterDesign("sys_oms"));
    render(<DomainBoard />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "AI で下書き" })).toBeNull());
    expect(screen.queryByRole("button", { name: "AI と決める" })).toBeNull();
  });
});
