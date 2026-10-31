// 他の人の選択を、カード・枠に色付きの縁と名前のラベルで出す (設計書 8.1。awareness から来た peers を読む)。
import type { CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useUntieStore, type Peer } from "../store";

const NONE: Peer[] = [];

/**
 * この要素を選んでいる他の人。同じボードにいる人だけ (peer.boardId === 開いているボード)。
 * 自分は peers に入っていない。要素が無い (undefined) ときは空
 */
export function usePeersSelecting(elementId: string | null | undefined): Peer[] {
  // その要素についての結果だけを返し、浅く比べる: 自分が選ぶたびや、ほかの要素を選んだ人の変化で、このカードを描き直さない
  return useUntieStore(
    useShallow((s) => {
      if (!elementId || s.peers.length === 0) return NONE;
      const boardId = s.ui.currentBoardId;
      const hit = s.peers.filter((p) => p.boardId === boardId && p.selection?.type === "element" && p.selection.id === elementId);
      return hit.length === 0 ? NONE : hit;
    }),
  );
}

/**
 * 縁の box-shadow。1 人目は 2px、2 人目以降は外側に 2px ずつ足す。
 * カードの既定の影を消さないよう、CSS 変数 --peer-ring で渡す (app.css が既定の影と重ねる)
 */
export function peerStyle(peers: Peer[]): CSSProperties | undefined {
  if (peers.length === 0) return undefined;
  return { "--peer-ring": peers.map((p, i) => `0 0 0 ${2 * (i + 1)}px ${p.color}`).join(", ") } as CSSProperties;
}

/** 右上の小さな名前のラベル。2 人以上のときは先頭の名前と人数 */
export function PeerLabel({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  const first = peers[0]!;
  return (
    <span
      className="peer-label"
      style={{ background: first.color }}
      title={peers.map((p) => p.name).join("、")}
      data-testid="peer-label"
    >
      {first.name}
      {peers.length > 1 ? ` +${peers.length - 1}` : ""}
    </span>
  );
}
