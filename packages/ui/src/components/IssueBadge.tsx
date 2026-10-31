/** 課題バッジ: 件数と最高重要度 */
export function IssueBadge({
  count,
  maxSeverity,
  className = "",
}: {
  count: number;
  maxSeverity: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={`issue-badge sev-${maxSeverity} ${className}`}
      title={`課題 ${count} 件 (最高の重要度 ${maxSeverity})`}
      aria-label={`課題 ${count} 件、最高の重要度 ${maxSeverity}`}
    >
      ⚑{count}
      <span className="issue-badge-sev">重要度{maxSeverity}</span>
    </span>
  );
}
