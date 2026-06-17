import PropTypes from 'prop-types'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

const navItems = [
  { label: 'Hospital', path: '/hospital/dashboard' },
  { label: 'Admin', path: '/admin' },
  { label: 'Ambulance', path: '/ambulance-quick-access' },
  { label: 'Chat', path: '/chat' },
]

function Sidebar({ role }) {
  const { user, logout } = useAuth()

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <p className="sidebar-title">PulsePath Console</p>
        <span className="role-tag">{role}</span>
      </div>
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'active' : ''}`.trim()
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <p>{user?.email || 'Not signed in'}</p>
        <button className="ghost" onClick={logout}>
          Logout
        </button>
      </div>
    </aside>
  )
}

Sidebar.propTypes = {
  role: PropTypes.string.isRequired,
}

export default Sidebar
