import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { roleHomeRoute } from '../config/navigation.js'
import { useAuth } from '../context/AuthContext.jsx'

function ProtectedRoute({ allowedRoles = [] }) {
  const { isAuthenticated, role } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    return <Navigate to={roleHomeRoute[role] || '/login'} replace />
  }

  return <Outlet />
}

export default ProtectedRoute
