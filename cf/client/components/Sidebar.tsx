export type NavKey = "home" | "backend" | "health";

interface SidebarProps {
  active: NavKey;
  open: boolean;
  onNavigate: (key: NavKey) => void;
}

const ITEMS: Array<{ key: NavKey; label: string }> = [
  { key: "home", label: "Home" },
  { key: "backend", label: "Backend" },
  { key: "health", label: "Health" },
];

export function Sidebar({ active, open, onNavigate }: SidebarProps) {
  return (
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Main navigation">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`nav-item${active === item.key ? " active" : ""}`}
          aria-current={active === item.key ? "page" : undefined}
          onClick={() => onNavigate(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
