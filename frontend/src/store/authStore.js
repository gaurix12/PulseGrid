import { create } from 'zustand'
import { permissionsByRole } from '../config/navigation.js'

const STORAGE_KEY = 'emergency-dispatch-session'

function readSession() {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSession(session) {
  if (typeof window === 'undefined') return

  if (!session) {
    window.localStorage.removeItem(STORAGE_KEY)
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

function buildToken(user) {
  const suffix = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `session_${user?.id || 'guest'}_${suffix}`
}

const initialSession = readSession()

export const useAuthStore = create((set) => ({
  currentUser: initialSession?.user ?? null,
  token: initialSession?.token ?? null,
  role: initialSession?.user?.role ?? null,
  permissions: initialSession?.user?.role ? permissionsByRole[initialSession.user.role] ?? [] : [],
  isAuthenticated: Boolean(initialSession?.user),
  hydrated: true,
  setSession: (user, token) => {
    const nextToken = token || buildToken(user)
    const nextSession = { user, token: nextToken }
    writeSession(nextSession)
    set({
      currentUser: user,
      token: nextToken,
      role: user?.role ?? null,
      permissions: permissionsByRole[user?.role] ?? [],
      isAuthenticated: Boolean(user),
      hydrated: true,
    })
    return nextSession
  },
  clearSession: () => {
    writeSession(null)
    set({
      currentUser: null,
      token: null,
      role: null,
      permissions: [],
      isAuthenticated: false,
      hydrated: true,
    })
  },
  hydrate: () => {
    const session = readSession()
    if (!session?.user) {
      set({ hydrated: true })
      return
    }

    set({
      currentUser: session.user,
      token: session.token,
      role: session.user.role,
      permissions: permissionsByRole[session.user.role] ?? [],
      isAuthenticated: true,
      hydrated: true,
    })
  },
}))

export { STORAGE_KEY as AUTH_STORAGE_KEY }