interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  pill?: boolean;
  label?: string;
}

/**
 * Single shimmer bar. Inline-block so it works inside text rows
 * (badges, presence pills) without disturbing layout.
 */
export function Skeleton({ width = "100%", height = 12, pill = false, label }: SkeletonProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`skeleton skeleton-inline${pill ? " skeleton-pill" : ""}`}
      style={{ width, height }}
    />
  );
}

/**
 * Placeholder for the Agent/Tunnel presence row while live status loads.
 * Fixed widths keep cards from jumping when real text resolves.
 */
export function CheckingPills({ label = "Checking live status…" }: { label?: string }) {
  return (
    <span className="presence-row" aria-label={label}>
      <span className="presence">
        <Skeleton width={118} height={14} pill />
      </span>
      <span className="presence">
        <Skeleton width={134} height={14} pill />
      </span>
    </span>
  );
}
