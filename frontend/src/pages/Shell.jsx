import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from '../components/Sidebar.jsx'
import { useAuth } from '../context/AuthContext.jsx'

const roleByPath = {
  '/admin': 'Admin Console',
  '/hospital': 'Hospital Admin',
  '/hospital/dashboard': 'Hospital Admin',
  '/chat': 'Dispatch Chat',
}

function Shell() {
  const location = useLocation()
  const { user } = useAuth()
  const role = roleByPath[location.pathname] || user?.role || 'Operator'

  return (
    <div className="shell">
      <Sidebar role={role} />
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  )
}

export default Shell
