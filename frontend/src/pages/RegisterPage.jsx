import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import authService from '../services/authService.js'
import { useUiStore } from '../store/uiStore.js'

function RegisterPage() {
  const navigate = useNavigate()
  const pushToast = useUiStore((state) => state.pushToast)
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'hospital',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      await authService.register({
        username: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
      })

      pushToast({
        title: 'Registration complete',
        description: form.role === 'admin'
          ? 'Admin account created. You can now log in.'
          : `Account created. You'll set up your ${form.role} profile after logging in.`,
        tone: 'success',
      })
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Unable to create account.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Create account</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Register a workspace user</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Choose your role — you'll set up your profile after your first login.</p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="grid gap-5 md:grid-cols-2">
          <label className="block space-y-2 text-sm font-semibold text-slate-700">
            <span>Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              placeholder="Jane Doe"
              required
            />
          </label>

          <label className="block space-y-2 text-sm font-semibold text-slate-700">
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              placeholder="name@pulsepath.com"
              required
            />
          </label>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <label className="block space-y-2 text-sm font-semibold text-slate-700">
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              placeholder="Create a password"
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
              <option value="ambulance">Ambulance</option>
              <option value="admin">Admin (first user only)</option>
            </select>
          </label>
        </div>

        {form.role === 'hospital' && (
          <p className="rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-700">
            🏥 After registration, you'll set up your hospital profile — name, resources, specialties, and location.
          </p>
        )}
        {form.role === 'ambulance' && (
          <p className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            🚑 After registration, you'll register your ambulance unit — driver name and starting location.
          </p>
        )}
        {form.role === 'admin' && (
          <p className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⚠️ Only the first user in the system can register as admin. If an admin already exists, this will fail.
          </p>
        )}

        {error ? <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</p> : null}

        <button
          type="submit"
          className="inline-flex w-full items-center justify-center rounded-2xl bg-sky-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Creating account...' : 'Create account'}
        </button>

        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Already have an account?</span>
          <Link to="/login" className="font-semibold text-sky-700 hover:text-sky-800">
            Back to login
          </Link>
        </div>
      </form>
    </>
  )
}

export default RegisterPage