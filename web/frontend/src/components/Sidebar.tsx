import { NavLink } from 'react-router-dom'
import {
  AgentIcon,
  CloudIcon,
  HomeIcon,
  PanelLeftIcon,
  SettingsIcon,
  TunnelIcon,
  XIcon,
} from './Icons'

const navItems = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/tunnels', label: 'Tunnels', icon: TunnelIcon, end: false },
  { to: '/agents', label: 'Agents', icon: AgentIcon, end: false },
  { to: '/providers', label: 'Providers', icon: CloudIcon, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
]

type SidebarProps = {
  collapsed: boolean
  mobileOpen: boolean
  onToggleCollapsed: () => void
  onCloseMobile: () => void
}

function BrandMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#ffffff" />
      <path
        d="M8 23v-6.5a8 8 0 0 1 16 0V23"
        stroke="#0a0a0a"
        strokeWidth="2.3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M13 23v-3.5a3 3 0 0 1 6 0V23"
        stroke="#0a0a0a"
        strokeWidth="2.3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 23h20"
        stroke="#0a0a0a"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  return (
    <aside
      id="sidebar"
      className={`sidebar${collapsed ? ' collapsed' : ''}${
        mobileOpen ? ' mobile-open' : ''
      }`}
    >
      <div className="brand">
        <span className="brand-mark">
          <BrandMark />
        </span>
        <div className="brand-text">
          <span className="brand-name">KS Tunnel</span>
          <span className="brand-subtitle">KS Warrior</span>
        </div>
        <button
          type="button"
          className="icon-button sidebar-close"
          onClick={onCloseMobile}
          aria-label="Close navigation"
        >
          <XIcon size={17} />
        </button>
      </div>

      <nav className="nav" aria-label="Main navigation">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `nav-link${isActive ? ' active' : ''}`
            }
            aria-label={label}
            title={collapsed ? label : undefined}
            onClick={onCloseMobile}
          >
            <span className="nav-icon">
              <Icon size={19} />
            </span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="sidebar"
          title={collapsed ? 'Expand sidebar' : undefined}
        >
          <span className="sidebar-toggle-icon">
            <PanelLeftIcon size={18} />
          </span>
          <span className="sidebar-toggle-label">
            {collapsed ? 'Expand' : 'Collapse'}
          </span>
        </button>
      </div>
    </aside>
  )
}
