import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MenuIcon } from './components/Icons'
import { Sidebar } from './components/Sidebar'
import { Home } from './pages/Home'
import { Providers } from './pages/Providers'
import { Settings } from './pages/Settings'
import { Tunnels } from './pages/Tunnels'

function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    if (!mobileOpen) return

    const previousOverflow = document.body.style.overflow
    const mediaQuery = window.matchMedia('(max-width: 900px)')

    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false)
    }

    function handleViewportChange() {
      if (!mediaQuery.matches) setMobileOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    mediaQuery.addEventListener('change', handleViewportChange)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      mediaQuery.removeEventListener('change', handleViewportChange)
    }
  }, [mobileOpen])

  return (
    <BrowserRouter>
      <div className={`app${collapsed ? ' sidebar-collapsed' : ''}`}>
        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          onCloseMobile={() => setMobileOpen(false)}
        />

        {mobileOpen ? (
          <button
            type="button"
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
        ) : null}

        <main className="main">
          <div className="mobile-topbar">
            <button
              type="button"
              className="icon-button mobile-menu-button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              aria-controls="sidebar"
              aria-expanded={mobileOpen}
            >
              <MenuIcon size={20} />
            </button>
            <span className="mobile-topbar-title">KS Tunnel</span>
          </div>

          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/tunnels" element={<Tunnels />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
