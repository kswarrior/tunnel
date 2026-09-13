import type { ReactNode } from "react";

/**
 * Shared entity card layout used by all pages (Tunnels / Hosts / Providers):
 *
 *   Row 1: [ICON svg] NAME + SUB ................ LABEL (status tag, right)
 *                └ SUB = small gray line below the name (e.g. target url)
 *   Row 2: NOTES ................................ ACTIONS (icon-only buttons, right)
 */

export interface EntityAction {
  key: string;
  /** Tooltip + screen-reader label. */
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface EntityCardProps {
  icon: ReactNode;
  name: ReactNode;
  /** Small gray line rendered below the name (e.g. target url). */
  sub?: ReactNode;
  /** Right-side status tag (e.g. Connected / Running / Active). */
  label: ReactNode;
  /** Bottom-left muted line (target, kind, tunnel link, ...). */
  notes: ReactNode;
  /** Bottom-right icon-only buttons (toggle, edit, delete, ...). */
  actions: EntityAction[];
}

export function EntityCard({ icon, name, sub, label, notes, actions }: EntityCardProps) {
  return (
    <article className="item-card">
      <div className="entity-top">
        <span className="entity-icon" aria-hidden="true">
          {icon}
        </span>
        <strong className="entity-name">
          <span className="entity-name-row">{name}</span>
          {sub ? <span className="entity-sub">{sub}</span> : null}
        </strong>
        <span className="entity-label">{label}</span>
      </div>
      <div className="entity-bottom">
        <div className="entity-notes">{notes}</div>
        <div className="entity-actions">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`icon-only-btn${a.danger ? " danger" : ""}`}
              title={a.label}
              aria-label={a.label}
              onClick={a.onClick}
            >
              {a.icon}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

function Svg({
  children,
  size = 18,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ---------- Entity-type icons (left ICON slot) ---------- */

export function GlobeIcon() {
  return (
    <Svg size={20}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Svg>
  );
}

export function TunnelIcon() {
  return (
    <Svg size={20}>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </Svg>
  );
}

export function CloudIcon() {
  return (
    <Svg size={20}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </Svg>
  );
}

/* ---------- Action icons (right icon-only buttons) ---------- */

export function PencilIcon() {
  return (
    <Svg>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Svg>
  );
}

export function TrashIcon() {
  return (
    <Svg>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Svg>
  );
}

export function PlayIcon() {
  return (
    <Svg>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  );
}

export function StopIcon() {
  return (
    <Svg>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </Svg>
  );
}

export function PowerIcon() {
  return (
    <Svg>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </Svg>
  );
}

export function OpenIcon() {
  return (
    <Svg>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Svg>
  );
}

export function CopyIcon() {
  return (
    <Svg>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}
