interface HeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  statusText: string;
}

export function Header({ sidebarOpen, onToggleSidebar, statusText }: HeaderProps) {
  return (
    <header className="header">
      <button
        type="button"
        className="icon-btn hamburger"
        aria-label={sidebarOpen ? "Close menu" : "Open menu"}
        aria-expanded={sidebarOpen}
        onClick={onToggleSidebar}
      >
        {sidebarOpen ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>
      <div className="brand">
        <svg
          className="brand-icon"
          width="28"
          height="28"
          viewBox="0 0 32 32"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="30" height="30" rx="8" fill="#f0fdf4" stroke="#16a34a" strokeWidth="2" />
          <path
            d="M9 12.5h11.5M17.7 9.7l2.8 2.8-2.8 2.8"
            fill="none"
            stroke="#16a34a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M23 19.5H11.5M14.3 16.7l-2.8 2.8 2.8 2.8"
            fill="none"
            stroke="#15803d"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        </svg>
        <span>KS Tunnel</span>
      </div>
      <div className="header-spacer" />
      <span className="header-status">{statusText}</span>
    </header>
  );
}
