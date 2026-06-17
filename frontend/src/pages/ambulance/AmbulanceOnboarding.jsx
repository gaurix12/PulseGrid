import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import { apiClient } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

function AmbulanceOnboarding() {
  const navigate = useNavigate()
  const { currentUser, login } = useAuth()
  const pushToast = useUiStore((s) => s.pushToast)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    driver_name: currentUser?.username || '',
    current_latitude: '',
    current_longitude: '',
  })

  const setField = (key, value) => setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const payload = {
        driver_name: form.driver_name.trim(),
        current_latitude: form.current_latitude ? parseFloat(form.current_latitude) : null,
        current_longitude: form.current_longitude ? parseFloat(form.current_longitude) : null,
      }

      const res = await apiClient.post('/ambulances/profile', payload)
      const updatedUser = res.data?.user

      if (updatedUser) {
        login(updatedUser)
      }

      pushToast({ title: 'Ambulance registered', description: `Unit for ${payload.driver_name} is now active.`, tone: 'success' })
      navigate('/ambulance/dashboard', { replace: true })
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Failed to create ambulance profile')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50 to-teal-50 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600 text-2xl text-white shadow-lg shadow-emerald-200">
            🚑
          </div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-600">Ambulance Setup</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Register your ambulance</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Enter your details so the dispatch system can assign cases to your unit.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 rounded-3xl border border-slate-200/60 bg-white/80 p-8 shadow-xl shadow-slate-200/50 backdrop-blur">
          <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
            <span>Driver / Operator Name *</span>
            <input type="text" required value={form.driver_name} onChange={(e) => setField('driver_name', e.target.value)}
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
              placeholder="John Smith" />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>Current Latitude</span>
              <input type="number" step="any" value={form.current_latitude} onChange={(e) => setField('current_latitude', e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                placeholder="12.9716" />
            </label>
            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>Current Longitude</span>
              <input type="number" step="any" value={form.current_longitude} onChange={(e) => setField('current_longitude', e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                placeholder="77.5946" />
            </label>
          </div>

          {error && <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</p>}

          <button type="submit" disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-2xl bg-emerald-600 px-4 py-3.5 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 shadow-lg shadow-emerald-200">
            {loading ? 'Registering ambulance...' : 'Register Ambulance'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default AmbulanceOnboarding
