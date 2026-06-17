import { useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { navigationByRole } from '../config/navigation.js'
import { useAuth } from '../context/AuthContext.jsx'

function MainLayout() {
  const { currentUser, role, logout, homeRoute } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  const navItems = useMemo(() => navigationByRole[role] || navigationByRole.admin, [role])

  const isLinkActive = (href) => {
    const [path, hash] = href.split('#')
    const expectedHash = hash ? `#${hash}` : ''
    
    if (location.pathname !== path) {
      return false
    }
    
    if (expectedHash) {
      return location.hash === expectedHash
    }
    
    return !location.hash
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <aside className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-200 bg-white/95 px-5 py-6 shadow-soft transition-transform lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
          <div className="flex items-center justify-between">
            <Link to={homeRoute} className="text-lg font-extrabold tracking-tight text-slate-900">
              PulsePath
            </Link>
            <button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-sm lg:hidden" onClick={() => setMobileOpen(false)}>
              Close
            </button>
          </div>

          <div className="mt-6 rounded-2xl bg-slate-950 px-4 py-4 text-white">
            <p className="text-xs uppercase tracking-[0.3em] text-sky-300">Signed in</p>
            <p className="mt-2 text-sm font-semibold">{currentUser?.username || currentUser?.email || 'Operator'}</p>
            <p className="text-sm text-slate-300">Role: {role}</p>
          </div>

          <nav className="mt-6 space-y-2">
            {navItems.map((item) => (
              <NavLink
                key={item.label}
                to={item.href}
                className={
                  `flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-semibold transition ${isLinkActive(item.href) ? 'bg-sky-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
                }
              >
                <span>{item.label}</span>
                {item.label === 'Dashboard' ? <span className="text-xs uppercase tracking-[0.25em]">Home</span> : null}
              </NavLink>
            ))}
          </nav>

          <button
            type="button"
            onClick={logout}
            className="mt-6 w-full rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
          >
            Logout
          </button>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
            <div className="flex items-center justify-between px-4 py-4 lg:px-8">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-600">Emergency Dispatch</p>
                <h2 className="text-xl font-bold text-slate-900">{role === 'admin' ? 'Admin Console' : role === 'hospital' ? 'Hospital Operations' : 'Ambulance Control'}</h2>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold lg:hidden" onClick={() => setMobileOpen((value) => !value)}>
                  Menu
                </button>
                <span className="rounded-full bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700">{currentUser?.email || 'session'}</span>
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}

export default MainLayout