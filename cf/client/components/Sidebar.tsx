export type NavKey = "home" | "tunnels" | "hosts" | "providers" | "settings";

interface SidebarProps {
  active: NavKey;
  open: boolean;
  onNavigate: (key: NavKey) => void;
}

const ITEMS: Array<{ key: NavKey; label: string; desc: string; icon: string }> = [
  { key: "home", label: "Home", desc: "Overview", icon: "home" },
  { key: "tunnels", label: "Tunnels", desc: "Public URLs", icon: "tunnels" },
  { key: "hosts", label: "Hosts", desc: "Agents", icon: "hosts" },
  { key: "providers", label: "Providers", desc: "Destinations", icon: "providers" },
  { key: "settings", label: "Settings", desc: "Preferences", icon: "settings" },
];

function NavSvg({ kind }: { kind: string }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true } as const;
  switch (kind) {
    case "home":
      return <svg {...common}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5z" /></svg>;
    case "tunnels":
      return <svg {...common}><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
    case "hosts":
      return <svg {...common}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
    case "providers":
      return <svg {...common}><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 0 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0 0-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 13 9.6a1.65 1.65 0 0 0 1 0 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 14c0 .34 0 .68 0 1z" /></svg>;
    default:
      return null;
  }
}

export function Sidebar({ active, open, onNavigate }: SidebarProps) {
  return (
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Main navigation">
      <div className="sidebar-label">Menu</div>
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`nav-item${active === item.key ? " active" : ""}`}
          aria-current={active === item.key ? "page" : undefined}
          onClick={() => onNavigate(item.key)}
        >
          <span className="nav-icon"><NavSvg kind={item.icon} /></span>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontWeight: 600 }}>{item.label}</span>
            <span style={{ fontSize: 11.5, opacity: active === item.key ? 0.86 : 0.68, fontWeight: 500 }}>{item.desc}</span>
          </span>
        </button>
      ))}
      <div style={{ marginTop: 10, padding: 12, background: "linear-gradient(135deg, rgba(16,185,129,0.10) 0%, rgba(52,211,153,0.08) 100%)", border: "1px solid rgba(16,185,129,0.12)", borderRadius: 14, display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, background: "white", border: "1px solid rgba(16,185,129,0.16)", display: "grid", placeItems: "center", color: "#0f9d58", flex: "0 0 36px", boxShadow: "0 2px 8px rgba(16,185,129,0.10)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-4z" /><path d="M9 12l2 2 4-4" /></svg>
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#0f1b2d" }}>Secure tunnel</span>
          <span style={{ display: "block", fontSize: 11.5, color: "#5a6b84", lineHeight: 1.3 }}>End-to-end via Workers</span>
        </span>
      </div>
    </nav>
  );
}
