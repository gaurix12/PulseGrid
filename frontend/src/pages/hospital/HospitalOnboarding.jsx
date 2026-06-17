import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import { apiClient } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

const RESOURCE_FIELDS = [
  { key: 'beds_available', label: 'Beds Available', placeholder: '50' },
  { key: 'beds_total', label: 'Beds Total', placeholder: '100' },
  { key: 'icu_available', label: 'ICU Available', placeholder: '10' },
  { key: 'icu_total', label: 'ICU Total', placeholder: '20' },
  { key: 'ventilators_available', label: 'Ventilators Available', placeholder: '5' },
  { key: 'ventilators_total', label: 'Ventilators Total', placeholder: '10' },
  { key: 'capacity', label: 'Total Capacity (patients)', placeholder: '200' },
  { key: 'current_patients', label: 'Current Patients', placeholder: '0' },
]

function HospitalOnboarding() {
  const navigate = useNavigate()
  const { currentUser, login } = useAuth()
  const pushToast = useUiStore((s) => s.pushToast)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    name: '',
    location: '',
    latitude: '',
    longitude: '',
    phone_number: '',
    contact_email: currentUser?.email || '',
    beds_available: '',
    beds_total: '',
    icu_available: '',
    icu_total: '',
    ventilators_available: '',
    ventilators_total: '',
    capacity: '',
    current_patients: '0',
    has_cardiology: false,
    has_trauma_care: false,
  })

  const setField = (key, value) => setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const payload = {
        name: form.name.trim(),
        location: form.location.trim(),
        latitude: form.latitude ? parseFloat(form.latitude) : null,
        longitude: form.longitude ? parseFloat(form.longitude) : null,
        phone_number: form.phone_number.trim() || null,
        contact_email: form.contact_email.trim() || null,
        beds_available: parseInt(form.beds_available) || 0,
        beds_total: parseInt(form.beds_total) || 0,
        icu_available: parseInt(form.icu_available) || 0,
        icu_total: parseInt(form.icu_total) || 0,
        ventilators_available: parseInt(form.ventilators_available) || 0,
        ventilators_total: parseInt(form.ventilators_total) || 0,
        capacity: parseInt(form.capacity) || 0,
        current_patients: parseInt(form.current_patients) || 0,
        has_cardiology: form.has_cardiology,
        has_trauma_care: form.has_trauma_care,
      }

      const res = await apiClient.post('/hospitals/profile', payload)
      const updatedUser = res.data?.user

      if (updatedUser) {
        login(updatedUser)
      }

      pushToast({ title: 'Hospital created', description: `${payload.name} is now set up.`, tone: 'success' })
      navigate('/hospital/dashboard', { replace: true })
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Failed to create hospital profile')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-sky-50 to-indigo-50 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-600 text-2xl text-white shadow-lg shadow-sky-200">
            🏥
          </div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Hospital Setup</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Set up your hospital profile</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Fill in your hospital details and resources so the dispatch system can route cases to you.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 rounded-3xl border border-slate-200/60 bg-white/80 p-8 shadow-xl shadow-slate-200/50 backdrop-blur">
          {/* Hospital Info */}
          <fieldset className="space-y-4">
            <legend className="text-lg font-bold text-slate-800">Hospital Information</legend>

            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>Hospital Name *</span>
              <input type="text" required value={form.name} onChange={(e) => setField('name', e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                placeholder="City General Hospital" />
            </label>

            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>Address / Location *</span>
              <input type="text" required value={form.location} onChange={(e) => setField('location', e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                placeholder="123 Medical Dr, City, State" />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
                <span>Latitude</span>
                <input type="number" step="any" value={form.latitude} onChange={(e) => setField('latitude', e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                  placeholder="12.9716" />
              </label>
              <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
                <span>Longitude</span>
                <input type="number" step="any" value={form.longitude} onChange={(e) => setField('longitude', e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                  placeholder="77.5946" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
                <span>Phone Number</span>
                <input type="tel" value={form.phone_number} onChange={(e) => setField('phone_number', e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                  placeholder="+91 98765 43210" />
              </label>
              <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
                <span>Contact Email</span>
                <input type="email" value={form.contact_email} onChange={(e) => setField('contact_email', e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                  placeholder="admin@hospital.com" />
              </label>
            </div>
          </fieldset>

          {/* Resources */}
          <fieldset className="space-y-4">
            <legend className="text-lg font-bold text-slate-800">Resources</legend>
            <div className="grid gap-4 md:grid-cols-2">
              {RESOURCE_FIELDS.map((f) => (
                <label key={f.key} className="block space-y-1.5 text-sm font-semibold text-slate-700">
                  <span>{f.label} *</span>
                  <input type="number" min="0" required value={form[f.key]} onChange={(e) => setField(f.key, e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                    placeholder={f.placeholder} />
                </label>
              ))}
            </div>
          </fieldset>

          {/* Specialties */}
          <fieldset className="space-y-4">
            <legend className="text-lg font-bold text-slate-800">Specialties</legend>
            <div className="flex gap-8">
              <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.has_cardiology} onChange={(e) => setField('has_cardiology', e.target.checked)}
                  className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
                <span>Cardiology</span>
              </label>
              <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.has_trauma_care} onChange={(e) => setField('has_trauma_care', e.target.checked)}
                  className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
                <span>Trauma Care</span>
              </label>
            </div>
          </fieldset>

          {error && <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</p>}

          <button type="submit" disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-2xl bg-sky-600 px-4 py-3.5 text-sm font-bold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60 shadow-lg shadow-sky-200">
            {loading ? 'Creating hospital...' : 'Create Hospital Profile'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default HospitalOnboarding
