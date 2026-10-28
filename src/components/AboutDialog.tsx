import { useEffect, useRef } from "react";
import { openExternalUrl } from "../io/file";

export const REPOSITORY_URL = "https://github.com/tango238/untie";
export const DEVELOPER = { name: "Go Tanaka", url: "https://x.com/tan_go238" };

/** 左上の「Untie」から開く、アプリの説明とバージョン */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog about-dialog" role="dialog" aria-modal="true" aria-label="Untie について">
        <div className="about-head">
          <img className="about-icon" src="/icon.png" alt="" width={96} height={96} />
          <div>
            <h2>Untie</h2>
            <p className="about-version">バージョン {__APP_VERSION__}</p>
          </div>
        </div>
        <p>
          Untie は、業務整理を行いながら、現場が感じている困りごとが業務のどこに潜んでいるかを突き止めるためのツールです。
        </p>
        <p className="hint">
          開発者: {DEVELOPER.name} ·{" "}
          <button type="button" className="link" onClick={() => void openExternalUrl(DEVELOPER.url)}>
            {DEVELOPER.url.replace("https://", "")}
          </button>
        </p>
        <p className="hint">
          MIT ライセンス ·{" "}
          <button type="button" className="link" onClick={() => void openExternalUrl(REPOSITORY_URL)}>
            {REPOSITORY_URL.replace("https://", "")}
          </button>
        </p>
        <div className="dialog-actions">
          <button type="button" ref={closeRef} onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
