import { createContext, useContext, useEffect, useMemo } from 'react'
import { navigationByRole, roleHomeRoute } from '../config/navigation.js'
import authService from '../services/authService.js'
import { useAuthStore } from '../store/authStore.js'

const AuthContext = createContext(null)

function permissionsFromNavigation(role) {
  return (navigationByRole[role] || []).map((item) => item.label.toLowerCase().replace(/\s+/g, '_'))
}

export function AuthProvider({ children }) {
  const currentUser = useAuthStore((state) => state.currentUser)
  const token = useAuthStore((state) => state.token)
  const role = useAuthStore((state) => state.role)
  const permissions = useAuthStore((state) => state.permissions)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const hydrate = useAuthStore((state) => state.hydrate)
  const setSession = useAuthStore((state) => state.setSession)
  const clearSession = useAuthStore((state) => state.clearSession)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const value = useMemo(() => {
    const login = (user, nextToken) => setSession(user, nextToken)

    const logout = async () => {
      try {
        await authService.logout()
      } catch {
        // local logout still succeeds if the backend is unavailable
      } finally {
        clearSession()
      }
    }

    return {
      currentUser,
      token,
      role,
      permissions: permissions.length > 0 ? permissions : permissionsFromNavigation(role),
      isAuthenticated,
      homeRoute: roleHomeRoute[role] || '/login',
      login,
      logout,
    }
  }, [clearSession, currentUser, isAuthenticated, permissions, role, setSession, token])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export default AuthContext
