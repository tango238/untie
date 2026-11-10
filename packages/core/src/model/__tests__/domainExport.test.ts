import { describe, expect, it } from "vitest";
import { createNetshopSample } from "../../sample";
import { adoptDomainCandidates } from "../domainResolve";
import { exportDomainDocs } from "../domainExport";
import { updateAggregate, updateBoundedContext } from "../domainCommands";
import { okModel, sample, sampleWithDomain } from "./helpers";

const file = (docs: ReturnType<typeof exportDomainDocs>, name: string) => docs.files.find((f) => f.name === name)!.text;

describe("exportDomainDocs: distill-ddd の形式で書き出す", () => {
  it("サンプル (ネットショップ) の書き出しは、スナップショットと同じ (distill-ddd の golden テストが同じファイルを読む)", async () => {
    const docs = exportDomainDocs(createNetshopSample(), { today: "2026-01-01" });
    expect(docs.files.map((f) => f.name)).toEqual(["event-storming.md", "bounded-contexts.md", "context-map.md", "aggregates.md", "domain-events.md", "glossary.md", ".ddd-session.json"]);
    // 形式を変えたら、distill-ddd の scripts/fixtures/untie-export/ も同じ内容に差し替えて、そちらのテスト (test_diagrams.py) を通すこと
    for (const f of docs.files) await expect(f.text).toMatchFileSnapshot(`./__fixtures__/domain-export/${f.name}`);
  });

  it("distill-ddd が正規表現で読む箇所の書式", () => {
    const docs = exportDomainDocs(createNetshopSample());
    // コンテキスト: `### 名前 (分類)`。`###` はコンテキストにしか使わない
    const contexts = file(docs, "bounded-contexts.md");
    expect(contexts.match(/^### .+$/gm)).toEqual(["### 受注 (Core)", "### 在庫 (Supporting)", "### 出荷 (Supporting)", "### 決済 (Generic)", "### 会計 (Generic)"]);
    // 関係: 最初の表のヘッダに Upstream と Downstream。関係は英語の綴り
    const map = file(docs, "context-map.md");
    expect(map).toContain("| Upstream | Downstream | 関係 | 統合方式 | 備考 |\n|----------|-----------|------|---------|------|\n| 受注 | 在庫 | Customer-Supplier | Messaging |");
    expect(map).toContain("| 決済 | 受注 | Anticorruption Layer | Messaging |");
    // 集約: `### 英語名 (Bounded Context: コンテキスト名)`、操作は `- \`command()\`: 説明 → 発行: \`Event\``
    const aggregates = file(docs, "aggregates.md");
    expect(aggregates.match(/^### .+$/gm)).toEqual([
      "### Order (Bounded Context: 受注)",
      "### ReturnRequest (Bounded Context: 受注)",
      "### Stock (Bounded Context: 在庫)",
      "### Shipment (Bounded Context: 出荷)",
      "### Receivable (Bounded Context: 会計)",
      "### Payout (Bounded Context: 会計)",
    ]);
    expect(aggregates).toContain("**操作**:\n- `placeOrder()`: 注文を受け付ける → 発行: `OrderPlaced`");
    expect(aggregates).toContain("- `markOrderPaid()`: 注文を入金済にする → 発行: `OrderPaid`");
    // 英語名の無いコマンド (まだ候補のもの) は、操作の節の外に書く (図には出ない)
    expect(aggregates).toContain("**英語名の無い操作 (図には出ない)**:\n- 在庫数を更新する");
    for (const line of aggregates.split("\n").filter((l) => /^- `/.test(l))) expect(line).toMatch(/^- `[a-z][A-Za-z0-9_]*\(\)`: /);
    // イベント: `#### 名前`、発生元の集約は集約の見出しと同じ綴り、Consumer はコンテキストの名前
    const events = file(docs, "domain-events.md");
    expect(events).toContain("#### OrderConfirmed\n- **日本語名**: 注文が確定した\n- **発生元 Aggregate**: Order\n- **トリガー**: confirmOrder\n- **Consumer**: 在庫\n- **ポリシー**: allocateStock (自動)");
    // あるべき姿: 決済 (外部) のイベントを受けて、受注が動く
    expect(events).toContain("#### PaymentConfirmed\n- **日本語名**: 入金が確認された\n- **トリガー**: 外部 (このコンテキストの外で発生する)\n- **Consumer**: 受注\n- **ポリシー**: markOrderPaid (自動)");
    expect(events).toContain("## Event Flow (コンテキスト間)\n\n<!-- ddd:diagram:event-flow -->\n\n受注 --{OrderConfirmed}--> 在庫\n出荷 --{OrderShipped}--> 会計\n決済 --{PaymentConfirmed}--> 受注\n");
    // 用語集: コンテキストごとの表
    const glossary = file(docs, "glossary.md");
    expect(glossary).toContain("## 受注\n\n| 用語 | 英語 | 定義 |\n|------|------|------|\n| 注文 | Order | 購入者からの 1 回の申し込み。");
    expect(glossary).toContain("| 引き当て | Allocation |");
    // セッション: Untie が書いたフェーズだけを済みにし、discover から再開する
    const session = JSON.parse(file(docs, ".ddd-session.json")) as { currentPhase: string; completedPhases: string[]; lastUpdated?: string };
    expect(session.currentPhase).toBe("discover");
    expect(session.completedPhases).toEqual(["storming", "contexts", "mapping", "aggregates", "events", "glossary"]);
    expect(session.lastUpdated).toBeUndefined();
    // 英語名の無いものを知らせる
    expect(docs.warnings.some((w) => w.includes("コマンド「在庫数を更新する」に英語名がありません"))).toBe(true);
  });

  it("保存した判断が無ければ何も書き出さない。分類・英語名・関係が未定でも書き出せ、未決のフェーズは済みにしない", () => {
    expect(exportDomainDocs(sample())).toEqual({ files: [], warnings: ["境界づけられたコンテキストがまだありません"] });
    const m = okModel(adoptDomainCandidates(sample(), { systemId: "sys_pms" }));
    const docs = exportDomainDocs(m, { today: "2026-11-10" });
    // 分類が未定なら括弧を付けない。集約は英語名が無ければ日本語の名前
    expect(file(docs, "bounded-contexts.md")).toContain("### 予約\n- **責務**: TBD");
    expect(file(docs, "aggregates.md")).toContain("### 予約 (Bounded Context: 予約)\n\n**Root Entity**: 予約\n");
    // コマンドは英語名が無いので、操作の節は空 (図には出ない)
    expect(file(docs, "aggregates.md")).toContain("**操作**:\n- なし\n\n**英語名の無い操作 (図には出ない)**:\n- 予約を確定する");
    const session = JSON.parse(file(docs, ".ddd-session.json")) as { completedPhases: string[]; lastUpdated: string; openQuestions: string[] };
    // 関係を決めていない組があるので mapping は済みにしない。用語も無い
    expect(session.completedPhases).toEqual(["storming", "contexts", "aggregates", "events"]);
    expect(session.lastUpdated).toBe("2026-11-10");
    expect(session.openQuestions.length).toBeGreaterThan(0);
    expect(file(docs, "context-map.md")).toContain("## 未解決の問い\n- 「");
  });

  it("書式を壊す文字 (括弧・縦線・改行) は置き換え、同じ名前が重なれば知らせる", () => {
    let m = sampleWithDomain();
    m = okModel(updateBoundedContext(m, { id: "bc_pay", patch: { name: "決済 (外部)", description: "a|b\nc" } }));
    m = okModel(updateAggregate(m, { id: "ag_bill", patch: { english: "Reservation" } }));
    const docs = exportDomainDocs(m);
    const contexts = file(docs, "bounded-contexts.md");
    // 末尾の括弧は分類と読まれるので、名前の括弧は全角にする
    expect(contexts).toContain("### 決済 （外部）\n");
    expect(contexts).toContain("- **責務**: a／b c");
    expect(docs.warnings.some((w) => w.includes("集約「Reservation」が 2 つあります"))).toBe(true);
  });
});
