import { useUntieStore } from "../store";
import { ElementList } from "./ElementList";

/** 自由ボードの左のペイン。要素一覧を開閉できる (閉じると細い帯だけ残す) */
export function LeftPane() {
  const open = useUntieStore((s) => s.ui.elementListOpen ?? true);
  const setOpen = useUntieStore((s) => s.setElementListOpen);
  return (
    <div className="left-pane">
      <button
        type="button"
        className="pane-toggle"
        aria-expanded={open}
        aria-label={open ? "要素一覧を閉じる" : "要素一覧を開く"}
        title={open ? "要素一覧を閉じる" : "要素一覧を開く"}
        onClick={() => setOpen(!open)}
      >
        {open ? "‹" : "›"}
      </button>
      {open ? (
        <ElementList />
      ) : (
        // 閉じているときは細い帯だけ残し、縦書きで「要素一覧」と出す
        <button type="button" className="pane-strip" onClick={() => setOpen(true)}>
          要素一覧
        </button>
      )}
    </div>
  );
}
