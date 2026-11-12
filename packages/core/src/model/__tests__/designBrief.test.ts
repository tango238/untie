import { describe, expect, it } from "vitest";
import { createHotelSample, createRetailSample, SAMPLES } from "../../sample";
import { removeRelation } from "../commands";
import { designBriefFileName, exportDesignBrief, exportDesignBriefAll } from "../designBrief";
import { okModel } from "./helpers";

describe("exportDesignBrief: 実装に渡す設計書", () => {
  it("操作のあるシステムだけを書き出す。ファイルの名前は、システムの id から決まる", () => {
    const all = exportDesignBriefAll(createHotelSample());
    expect(all.map((b) => b.fileName)).toContain(designBriefFileName("sys_pms"));
    expect(all.every((b) => b.usecases > 0)).toBe(true);
    expect(exportDesignBrief(createHotelSample(), "sys_none").usecases).toBe(0);
  });

  it("操作ごとに、担当・情報・前提の状態・次の状態・条件のときの流れ (そのあとの状態も) を書く", () => {
    const text = exportDesignBrief(createHotelSample(), "sys_pms").text;
    const section = text.slice(text.indexOf("### 予約を取り消す"), text.indexOf("### チェックインを記録する"));
    expect(section).toContain("- 情報: 予約 (");
    expect(section).toContain("- 前提の状態: 予約の状態 = 確定 (これ以外のときは、行えない)");
    expect(section).toContain("- 次の状態: 予約の状態 = 取消");
    expect(section).toContain("- 条件「取消料が発生する」: 条件を満たすとき、取消料を請求に加えてから、予約を取り消す。 (そのあとの状態: ふだんと同じ)");
  });

  it("このシステムの外で作られる前提 (ほかのシステムの操作・状態の持ち主・結びつく情報・条件の判断のもと) を書く", () => {
    const text = exportDesignBrief(createHotelSample(), "sys_pms").text;
    // 状態が、どの情報のものか。最初の状態と、それを作る操作 (ほかのシステムのもの)
    expect(text).toContain("### 予約の状態\n\n情報「予約」の状態。");
    expect(text).toMatch(/\| 仮予約 \| 「予約を登録する」\(ほかのシステム「予約サイト」\) \| 「予約を確定する」 \|/);
    expect(text).toContain("作られたときの状態: 仮予約");
    // 部屋は、作る操作が設計に無い
    expect(text).toContain("### 部屋の状態\n\n情報「部屋」の状態。");
    expect(text).toMatch(/作られたときの状態: 設計に無い/);
    // 予約と部屋の結びつき (チェックアウトは、両方の状態を変える)
    expect(text).toMatch(/### 予約\n[\s\S]*?- 結びつく情報: [^\n]*部屋/);
    // 条件を何で判断するか (説明と、結んだ状態)
    expect(text).toContain("- 何で判断するか: 宿泊日が近い取消は取消料がかかる。状態 (予約の状態 = 確定) を見る");
    expect(text).toContain("### 早めのチェックインができる\n\n- 何で判断するか: 状態 (部屋の状態 = 準備完了) を見る");
  });

  it("決まっていないことは、決まっていないと書き、終わりに一覧にする", () => {
    const hotel = exportDesignBrief(createHotelSample(), "sys_pms");
    expect(hotel.remaining).toBeGreaterThan(0);
    expect(hotel.text).toContain("## まだ決まっていないこと");
    expect(hotel.text).toContain("- 情報「料金プラン」を保存する操作がありません");
    // 状態の持ち主が決まらないグループ
    const retail = exportDesignBrief(createRetailSample(), "sys_pos").text;
    expect(retail).toContain("### 1 日の締めの状態\n\nどの情報の状態かは、**決まっていない**。");
    expect(retail).toContain("- 「1 日の締めの状態」が、どの情報の状態かが決まりません");
    // 代替パターンを決めていない条件
    const m = createHotelSample();
    const rel = m.relations.find((r) => r.kind === "usecaseCondition" && r.sourceId === "uc_cancel_reservation")!;
    const undecided = { ...m, relations: m.relations.map((r) => (r.id === rel.id ? { ...r, alternate: undefined } : r)) };
    expect(exportDesignBrief(undecided, "sys_pms").text).toContain("- 条件「取消料が発生する」を判断する (条件のときにどうなるかは、決まっていない)");
    // 関係を消すと、結びつく情報からも消える
    const cut = okModel(removeRelation(m, { id: m.relations.find((r) => r.kind === "informationRelated" && r.sourceId === "info_reservation" && r.targetId === "info_room")!.id }));
    expect(exportDesignBrief(cut, "sys_pms").text).toContain("は「予約の状態」と「部屋の状態」に関わりますが、情報「予約」と「部屋」が結ばれていません");
  });

  it("内部のドメインモデルの言葉を出さない", () => {
    for (const sample of SAMPLES) {
      for (const brief of exportDesignBriefAll(sample.create())) expect(brief.text).not.toMatch(/集約|境界づけられた|ドメインイベント|コマンド|ポリシー|エンティティ|値オブジェクト/);
    }
  });
});
