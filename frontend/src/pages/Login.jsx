import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import * as api from '../services/api.js'
import { getRoleRoute, useAuth } from '../context/AuthContext.jsx'

function Login() {
  const navigate = useNavigate()
  const { user, login } = useAuth()
  const [form, setForm] = useState({ email: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const demoAccounts = {
    'admin@pulsepath.local': { password: 'Admin123!', role: 'admin', username: 'City Admin' },
    'hospital@pulsepath.local': {
      password: 'Hospital123!',
      role: 'hospital',
      username: 'Hospital Admin',
    },
    'ambulance@pulsepath.local': {
      password: 'Ambulance123!',
      role: 'ambulance',
      username: 'Ambulance Driver',
    },
  }

  if (user) {
    return <Navigate to={getRoleRoute(user.role)} replace />
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    const email = form.email.trim().toLowerCase()

    try {
      const response = await api.loginUser({ email, password: form.password })
      const nextUser = response?.user

      if (!nextUser) {
        throw new Error('Login failed')
      }

      login(nextUser)
      navigate(getRoleRoute(nextUser.role), { replace: true })
      return
    } catch (err) {
      const demoAccount = demoAccounts[email]
      if (demoAccount && demoAccount.password === form.password) {
        const nextUser = {
          id: `demo-${demoAccount.role}`,
          email,
          username: demoAccount.username,
          role: demoAccount.role,
          hospital_id: demoAccount.role === 'hospital' ? 1 : undefined,
          ambulance_id: demoAccount.role === 'ambulance' ? 1 : undefined,
        }
        login(nextUser)
        navigate(getRoleRoute(nextUser.role), { replace: true })
        return
      }

      setError(err.message || 'Invalid email or password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-hero">
          <div className="brand">
            <div className="pulse"></div>
            <div>
              <p className="eyebrow">Secure login</p>
              <h1>Dispatch Control</h1>
              <p className="subtitle">Sign in with email and password to enter your role.</p>
            </div>
          </div>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email address
            <input
              type="email"
              placeholder="name@pulsepath.local"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              autoComplete="email"
              disabled={loading}
              autoFocus
            />
          </label>

          <label>
            Password
            <input
              type="password"
              placeholder="Your password"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              autoComplete="current-password"
              disabled={loading}
            />
          </label>

          {error ? <p className="login-error">{error}</p> : null}

          <button type="submit" className="primary full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          <div className="login-notes">
            <p className="muted">Demo accounts:</p>
            <p className="muted">admin@pulsepath.local / Admin123!</p>
            <p className="muted">hospital@pulsepath.local / Hospital123!</p>
            <p className="muted">ambulance@pulsepath.local / Ambulance123!</p>
          </div>
        </form>
      </div>
    </div>
  )
}

export default Login
