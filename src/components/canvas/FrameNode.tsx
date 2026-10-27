import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useUntieStore } from "../../store";
import { IssueBadge } from "../IssueBadge";
import { ActorChips } from "./ActorChips";
import { NodeHandles } from "./NodeHandles";
import type { FrameFlowNode } from "./toFlow";

export function FrameNode({ data, selected }: NodeProps<FrameFlowNode>) {
  const isBuc = data.kind === "buc";
  return (
    <div className={`frame-node kind-${data.kind}${selected ? " is-selected" : ""}`} data-testid={`node-${data.elementId}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={isBuc ? 160 : 240}
        minHeight={isBuc ? 120 : 160}
        onResizeEnd={() => useUntieStore.getState().commitDrag()}
      />
      <NodeHandles />
      <div className="frame-title">
        <span className="frame-kind">{isBuc ? "活動" : "業務"}</span>
        <span className="frame-name">{data.name || "(名前なし)"}</span>
        {data.label && <span className="frame-owner">{data.label}</span>}
        {data.actors && <ActorChips actors={data.actors} />}
        {!isBuc && data.issueCount > 0 && (
          <IssueBadge count={data.issueCount} maxSeverity={data.maxSeverity} className="frame-badge" />
        )}
      </div>
    </div>
  );
}
