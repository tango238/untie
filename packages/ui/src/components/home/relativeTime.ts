const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 「3 分前」のような相対表示。1 分未満は「たった今」、30 日以上前は日付 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  // 時計のずれで未来になったものは「たった今」にする
  if (diff < MINUTE) return "たった今";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 時間前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 日前`;
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
