import { describe, expect, it, vi } from "vitest";
import { applyDomainDraft, type DomainDraft } from "@untie/core/model/domainDraft";
import { validateModel } from "@untie/core/model/validate";
import { createNetshopSample } from "@untie/core/sample";
import { sample } from "@untie/core/testing";
import type { ChatOptions } from "../chat";

const fake = vi.hoisted(() => ({ texts: [] as string[], tool: [] as unknown[], toolResults: [] as { ok: boolean; content: string }[], sent: [] as string[], systems: [] as string[] }));
vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string) => {
        fake.sent.push(text);
        fake.systems.push(o.system);
        while (fake.tool.length > 0) {
          const r = await o.runTool("submit_domain_model", fake.tool.shift());
          fake.toolResults.push(r);
          if (r.ok) break;
        }
        return fake.texts.shift() ?? "";
      },
    }),
  };
});

const { DOMAIN_DRAFT_MAX_ATTEMPTS, domainDesignRequest, generateDomainDraft, readDomainDraft, SUBMIT_DOMAIN_TOOL } = await import("../designDomain");

const opts = { provider: "claude" as const, model: "m", apiKey: "k" };
const reset = () => {
  fake.texts = [];
  fake.tool = [];
  fake.toolResults = [];
  fake.sent = [];
  fake.systems = [];
};

const good: DomainDraft = {
  contexts: [
    {
      name: "予約",
      english: "Reservation",
      subdomain: "core",
      contextIds: ["ctx_reservation"],
      aggregates: [{ english: "Reservation", rootInformationId: "info_reservation", stateGroup: "予約の状態", commands: [{ usecaseId: "uc_confirm_reservation", english: "ConfirmReservation" }] }],
    },
  ],
};
/** 英語名の抜けた下書き (出し直しになる) */
const bad: DomainDraft = { contexts: [{ name: "予約", english: "", aggregates: [] }] };

describe("ドメインモデルの下書きの依頼", () => {
  it("依頼に、分析のコンテキストと情報・コマンドとイベントの候補・気づき・残すコンテキスト・今のドメインモデルを入れる", () => {
    const text = domainDesignRequest(createNetshopSample(), "sys_oms");
    expect(text).toContain("システム「販売管理システム」のドメインモデルの下書き");
    for (const tag of ["<分析のコンテキストと情報>", "<コマンドの候補", "<問い合わせ", "<イベントの候補>", "<気づき", "<残すコンテキスト", "<今のドメインモデル"]) expect(text).toContain(tag);
    // 候補は分析から導いたまま (操作の id と名前)。保存した名前 (出荷する) ではない
    expect(text).toContain('"usecaseId": "uc_record_shipment"');
    expect(text).toContain("出荷を記録する");
    // 気づきの問い
    expect(text).toContain("- ");
    // 残すのは、ほかのシステムのコンテキスト (決済・会計)。置き換えるのは、販売管理システムだけのもの (受注・在庫・出荷)
    const kept = text.slice(text.indexOf("<残すコンテキスト"), text.indexOf("</残すコンテキスト>"));
    expect(kept).toContain('"english":"Payment"');
    expect(kept).toContain('"english":"PaymentConfirmed"');
    expect(kept).not.toContain("Ordering");
    const current = text.slice(text.indexOf("<今のドメインモデル"), text.indexOf("</今のドメインモデル>"));
    expect(current).toContain('"english": "Ordering"');
    expect(current).toContain("出荷済の注文は取り消せない。");
    // 保存した判断が無ければ、その旨
    expect(domainDesignRequest(sample(), "sys_pms")).toContain("(まだ無い)");
  });

  it("道具の定義は、英語名を必須にする", () => {
    const contexts = (SUBMIT_DOMAIN_TOOL.parameters as { properties: { contexts: { items: { required: string[] } } } }).properties.contexts;
    expect(contexts.items.required).toEqual(["name", "english"]);
    expect(readDomainDraft(null)).toBeNull();
    expect(readDomainDraft({ contexts: "x" })).toBeNull();
    expect(readDomainDraft(good)).toBe(good);
  });
});

describe("generateDomainDraft", () => {
  it("提出された下書きを確かめて返す (モデルには書かない)。返した下書きは、そのまま当てられる", async () => {
    reset();
    const m = sample();
    fake.tool = [good];
    const r = await generateDomainDraft(m, "sys_pms", opts);
    expect(fake.systems[0]).toContain("ドメイン駆動設計");
    expect(fake.toolResults.map((t) => t.ok)).toEqual([true]);
    expect(r.summary).toMatchObject({ contexts: 1, aggregates: 1, commands: 1 });
    const applied = applyDomainDraft(m, { systemId: "sys_pms", draft: r.draft });
    expect(applied.ok && validateModel(applied.model).ok).toBe(true);
  });

  it("当てられないところがあれば、理由を返して出し直させる", async () => {
    reset();
    fake.tool = [bad, good];
    const r = await generateDomainDraft(sample(), "sys_pms", opts);
    expect(fake.toolResults.map((t) => t.ok)).toEqual([false, true]);
    expect(fake.toolResults[0]!.content).toContain("英語名 (english) が必要です");
    expect(fake.toolResults[0]!.content).toContain("出し直してください");
    expect(r.summary.contexts).toBe(1);
  });

  it("上限まで直らなければ、保存せずに失敗にする (理由を添える)", async () => {
    reset();
    fake.tool = Array.from({ length: DOMAIN_DRAFT_MAX_ATTEMPTS }, () => bad);
    await expect(generateDomainDraft(sample(), "sys_pms", opts)).rejects.toThrow(/当てられないところが残ったため、保存しませんでした[\s\S]*英語名/);
    expect(fake.toolResults).toHaveLength(DOMAIN_DRAFT_MAX_ATTEMPTS);
    expect(fake.toolResults[fake.toolResults.length - 1]!.content).toContain("これ以上は受け付けません");
  });

  it("文章で返された JSON も読む。何も提出しなければ、もう一度頼んでから失敗にする", async () => {
    reset();
    fake.texts = [`下書きです\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``];
    const r = await generateDomainDraft(sample(), "sys_pms", opts);
    expect(r.summary.aggregates).toBe(1);
    reset();
    fake.texts = ["わかりません", "やはりわかりません"];
    await expect(generateDomainDraft(sample(), "sys_pms", opts)).rejects.toThrow("AI がドメインモデルの下書きを提出しませんでした");
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]).toContain("submit_domain_model");
  });
});
