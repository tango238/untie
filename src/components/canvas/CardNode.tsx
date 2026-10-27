import type { NodeProps } from "@xyflow/react";
import { ELEMENT_KIND_LABELS } from "../../model/types";
import { IssueBadge } from "../IssueBadge";
import { ActorChips } from "./ActorChips";
import { NodeHandles } from "./NodeHandles";
import type { CardFlowNode } from "./toFlow";

const BADGE_KINDS = new Set(["activity", "usecase"]);

export function CardNode({ data, selected }: NodeProps<CardFlowNode>) {
  return (
    <div className={`card-node kind-${data.kind}${selected ? " is-selected" : ""}`} data-testid={`node-${data.elementId}`}>
      <NodeHandles />
      <div className="card-kind">{ELEMENT_KIND_LABELS[data.kind]}</div>
      {BADGE_KINDS.has(data.kind) && data.issueCount > 0 && (
        <IssueBadge count={data.issueCount} maxSeverity={data.maxSeverity} className="card-badge" />
      )}
      <div className="card-name">{data.name || "(名前なし)"}</div>
      {data.label && <div className="card-owner">{data.label}</div>}
      {data.actors && <ActorChips actors={data.actors} />}
    </div>
  );
}
