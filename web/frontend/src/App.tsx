import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Home } from './pages/Home'
import { Providers } from './pages/Providers'
import { Settings } from './pages/Settings'
import { Tunnels } from './pages/Tunnels'

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Sidebar />
        <main className="main">
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
