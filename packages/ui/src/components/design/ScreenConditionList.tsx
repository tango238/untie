import { useMemo } from "react";
import { screenConditions } from "@untie/core/model/placement";
import type { UntieModel } from "@untie/core/model/types";

/** 分析の画面 id が判断する条件 (名前・説明・根拠の操作名)。placement.ts の screenConditions から導く */
export function useScreenConditions(model: UntieModel, analysisId: string | undefined) {
  return useMemo(() => {
    if (!analysisId) return [];
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    return (screenConditions(model).get(analysisId) ?? []).map((d) => {
      const el = byId.get(d.id);
      return { id: d.id, name: el?.name || "(名前なし)", description: el?.description, usecases: d.usecaseIds.map((u) => byId.get(u)?.name || "(名前なし)") };
    });
  }, [model, analysisId]);
}

/** 「この画面が判断する条件」の一覧 (読み取り)。条件名と、小さく根拠の操作名。説明は title に入れる */
export function ScreenConditionList({ conditions }: { conditions: ReturnType<typeof useScreenConditions> }) {
  return (
    <ul className="plain-list" data-testid="screen-conditions">
      {conditions.map((c) => (
        <li key={c.id} title={c.description || undefined}>
          {c.name}
          {c.usecases.length > 0 && <small className="hint-inline"> ({c.usecases.join("、")})</small>}
        </li>
      ))}
    </ul>
  );
}
