import type { NodeProps } from "@xyflow/react";
import { ELEMENT_KIND_LABELS } from "@untie/core/model/types";
import { IssueBadge } from "../IssueBadge";
import { PeerLabel, peerStyle, usePeersSelecting } from "../PeerMarks";
import { ActorChips } from "./ActorChips";
import { NodeHandles } from "./NodeHandles";
import type { CardFlowNode } from "./toFlow";

const BADGE_KINDS = new Set(["activity", "usecase"]);

export function CardNode({ data, selected }: NodeProps<CardFlowNode>) {
  // 他の人が選んでいる要素は、その人の色の縁と名前で示す
  const peers = usePeersSelecting(data.elementId);
  return (
    <div
      className={`card-node kind-${data.kind}${selected ? " is-selected" : ""}`}
      style={peerStyle(peers)}
      data-testid={`node-${data.elementId}`}
    >
      <NodeHandles />
      <PeerLabel peers={peers} />
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
