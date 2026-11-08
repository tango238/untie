import { expect } from "vitest";
import type { CommandResult } from "../commands";
import type { UntieModel } from "../types";
import { createHotelSample } from "../../sample";

export function sample(): UntieModel {
  return createHotelSample();
}

/** 成功を期待して model を取り出す */
export function okModel<T>(r: CommandResult<T>): UntieModel {
  if (!r.ok) throw new Error(`コマンドが失敗しました: ${r.reason}`);
  return r.model;
}

export function expectFail<T>(r: CommandResult<T>, pattern?: RegExp) {
  expect(r.ok).toBe(false);
  if (!r.ok && pattern) expect(r.reason).toMatch(pattern);
}

/** 古いファイル・同時編集で重なった状態を作る (コマンドは断るので関係を直接足す) */
export function shareScreen(model: UntieModel, usecaseId: string, screenId: string): UntieModel {
  const rels = model.relations.filter((r) => !(r.sourceId === usecaseId && (r.kind === "usecaseSystem" || r.kind === "usecaseScreen")));
  return { ...model, relations: [...rels, { id: `rel_share_${usecaseId}_${screenId}`, kind: "usecaseScreen", sourceId: usecaseId, targetId: screenId } as UntieModel["relations"][number]] };
}
