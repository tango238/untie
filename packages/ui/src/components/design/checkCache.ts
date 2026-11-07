import { checkDesign, type DesignCheckResult } from "@untie/core/model/designCheck";
import type { UntieModel } from "@untie/core/model/types";

let last: { model: UntieModel; systemId: string; result: DesignCheckResult } | undefined;

/** 設計の検証。ツールバーのバッジと検証パネルが同じ結果を使う (モデルと対象のシステムが同じなら使い回す) */
export function cachedCheckDesign(model: UntieModel, systemId: string): DesignCheckResult {
  if (last && last.model === model && last.systemId === systemId) return last.result;
  const result = checkDesign(model, systemId);
  last = { model, systemId, result };
  return result;
}
