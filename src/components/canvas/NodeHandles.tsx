import { Handle, Position } from "@xyflow/react";
import { EDGE_SIDES, type EdgeSide } from "../../model/types";
import { sourceHandleId, targetHandleId } from "./toFlow";

const POSITION: Record<EdgeSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** 4 辺に始点用・終点用のハンドルを置く。線はつなげないので見せない (CSS で隠す) */
export function NodeHandles() {
  return (
    <>
      {EDGE_SIDES.map((side) => (
        <Handle key={`s-${side}`} id={sourceHandleId(side)} type="source" position={POSITION[side]} />
      ))}
      {EDGE_SIDES.map((side) => (
        <Handle key={`t-${side}`} id={targetHandleId(side)} type="target" position={POSITION[side]} />
      ))}
    </>
  );
}
