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
      <div className="brand">CF Hello World</div>
      <div className="header-spacer" />
      <span className="header-status">{statusText}</span>
    </header>
  );
}
