import { useMemo, useState } from "react";
import { FIXED_LAYERS, FIXED_LAYER_LABELS, fixedLayerOf, type FixedLayer } from "../model/fixedBoards";
import { globalFilterCount } from "../model/lineage";
import { ELEMENT_KIND_LABELS, type Element } from "../model/types";
import { useUntieStore } from "../store";

/**
 * 固定ボード共通のグローバルフィルター。レイヤーごとに要素を 1 つ以上選ぶと、
 * どの固定ボードでも、選んだ要素につながる要素だけを出す (レイヤーの中は OR、レイヤーどうしは AND)
 */
export function GlobalFilterBar() {
  const model = useUntieStore((s) => s.model);
  const filter = useUntieStore((s) => s.ui.globalFilter);
  const setGlobalFilter = useUntieStore((s) => s.setGlobalFilter);
  const resetGlobalFilter = useUntieStore((s) => s.resetGlobalFilter);
  const [open, setOpen] = useState(false);
  const count = globalFilterCount(model, filter);

  const byLayer = useMemo(() => {
    const map = new Map<FixedLayer, Element[]>();
    for (const e of model.elements) {
      if (e.kind === "buc" && e.isDefault) continue;
      const layer = fixedLayerOf(e.kind);
      if (layer) map.set(layer, [...(map.get(layer) ?? []), e]);
    }
    return map;
  }, [model]);
  const byId = useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);

  const chips = FIXED_LAYERS.flatMap((layer) =>
    (filter?.[layer] ?? []).filter((id) => byId.has(id)).map((id) => ({ layer, element: byId.get(id)! })),
  );
  const remove = (layer: FixedLayer, id: string) => setGlobalFilter(layer, (filter?.[layer] ?? []).filter((x) => x !== id));

  return (
    <section className={`global-filter${count > 0 ? " is-active" : ""}`} aria-label="グローバルフィルター">
      <div className="global-filter-head">
        <button type="button" className="global-filter-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} グローバルフィルター{count > 0 ? ` (${count})` : ""}
        </button>
        {chips.length === 0 ? (
          <span className="hint">すべての固定ボードに共通です。要素を選ぶと、それにつながる要素だけを出します。</span>
        ) : (
          <span className="global-filter-chips">
            {chips.map(({ layer, element }) => (
              <span key={`${layer}-${element.id}`} className={`global-filter-chip kind-${element.kind}`}>
                <span className="global-filter-chip-layer">{FIXED_LAYER_LABELS[layer]}</span>
                {element.name || "(名前なし)"}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`フィルターから「${element.name}」を外す`}
                  onClick={() => remove(layer, element.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
        {count > 0 && (
          <button type="button" className="global-filter-reset" onClick={resetGlobalFilter}>
            リセット
          </button>
        )}
      </div>
      {open && (
        <div className="global-filter-body">
          {FIXED_LAYERS.map((layer) => {
            const options = (byLayer.get(layer) ?? []).filter((e) => !(filter?.[layer] ?? []).includes(e.id));
            return (
              <label key={layer} className="global-filter-field">
                <span className="field-label">{FIXED_LAYER_LABELS[layer]}</span>
                <select
                  aria-label={`グローバルフィルターに${FIXED_LAYER_LABELS[layer]}を足す`}
                  value=""
                  disabled={options.length === 0}
                  onChange={(e) => {
                    if (e.target.value) setGlobalFilter(layer, [...(filter?.[layer] ?? []), e.target.value]);
                  }}
                >
                  <option value="">{options.length === 0 ? "(選べる要素なし)" : "選んで足す…"}</option>
                  {options.map((e) => (
                    <option key={e.id} value={e.id}>
                      {layer === "actor" ? `${ELEMENT_KIND_LABELS[e.kind]}: ` : ""}
                      {e.name || "(名前なし)"}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
