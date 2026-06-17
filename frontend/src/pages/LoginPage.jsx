import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import authService from '../services/authService.js'
import { useAuth } from '../context/AuthContext.jsx'
import { roleHomeRoute } from '../config/navigation.js'
import { useUiStore } from '../store/uiStore.js'

function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuth()
  const pushToast = useUiStore((state) => state.pushToast)
  const [form, setForm] = useState({ email: '', password: '', role: 'hospital' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await authService.login({
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
      })
      const user = response?.user

      if (!user) {
        throw new Error('Login failed. No user returned from the server.')
      }

      login(user)

      // Redirect to onboarding if the user hasn't set up their profile yet
      if (user.needs_onboarding) {
        if (user.role === 'hospital') {
          navigate('/hospital/onboarding', { replace: true })
        } else if (user.role === 'ambulance') {
          navigate('/ambulance/onboarding', { replace: true })
        } else {
          navigate(roleHomeRoute[user.role] || '/login', { replace: true })
        }
      } else {
        navigate(location.state?.from || roleHomeRoute[user.role] || '/login', { replace: true })
      }
    } catch (err) {
      setError(err.message || 'Unable to sign in.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Welcome back</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Sign in to dispatch</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Use your email, password, and role to enter the correct workspace.</p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit}>
        <label className="block space-y-2 text-sm font-semibold text-slate-700">
          <span>Email</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
            className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
            placeholder="name@hospital.com"
            required
          />
        </label>

        <label className="block space-y-2 text-sm font-semibold text-slate-700">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
            placeholder="Enter password"
            required
          />
        </label>

        <label className="block space-y-2 text-sm font-semibold text-slate-700">
          <span>Role</span>
          <select
            value={form.role}
            onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value }))}
            className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
          >
            <option value="hospital">Hospital</option>
            <option value="admin">Admin</option>
            <option value="ambulance">Ambulance</option>
          </select>
        </label>

        {error ? <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</p> : null}

        <button
          type="submit"
          className="inline-flex w-full items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>

        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>No account yet?</span>
          <Link to="/register" className="font-semibold text-sky-700 hover:text-sky-800">
            Create one
          </Link>
        </div>
      </form>
    </>
  )
}

export default LoginPage