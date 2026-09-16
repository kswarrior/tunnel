interface HeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function Header({ sidebarOpen, onToggleSidebar }: HeaderProps) {
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>
      <div className="brand">
        <svg
          className="brand-icon"
          width="36"
          height="36"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0f9d58" />
              <stop offset="55%" stopColor="#10b981" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
            <filter id="brandShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#10b981" floodOpacity="0.25" />
            </filter>
          </defs>
          <rect x="1" y="1" width="34" height="34" rx="10" fill="white" stroke="rgba(16,185,129,0.16)" strokeWidth="1.2" />
          <rect x="1" y="1" width="34" height="34" rx="10" fill="url(#brandGrad)" opacity="0.09" />
          {/* tunnel arrows */}
          <g filter="url(#brandShadow)">
            <path
              d="M10 13.5h13M19.2 10.2l3.3 3.3-3.3 3.3"
              fill="none"
              stroke="url(#brandGrad)"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M26 22.5H13M16.8 19.2l-3.3 3.3 3.3 3.3"
              fill="none"
              stroke="#0f9d58"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.95"
            />
          </g>
        </svg>
        <span>KS Tunnel</span>
      </div>
      <div className="header-spacer" />
    </header>
  );
}
