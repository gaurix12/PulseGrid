import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import * as api from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function getSeverityTone(severity) {
  switch (String(severity || '').toUpperCase()) {
    case 'P0':
      return 'bg-rose-100 text-rose-800 border-rose-200'
    case 'P1':
      return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'P2':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    default:
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  }
}

function normalizeLocation(latitude, longitude) {
  const lat = String(latitude || '').trim()
  const lon = String(longitude || '').trim()
  return lat && lon ? `${lat},${lon}` : ''
}

function EmergencyDispatchModal({ onClose, onSuccess }) {
  const pushToast = useUiStore((state) => state.pushToast)
  const [name, setName] = useState('')
  const [symptoms, setSymptoms] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [age, setAge] = useState('')
  const [medicalHistory, setMedicalHistory] = useState('')
  const [priorityOverride, setPriorityOverride] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [prefillStatus, setPrefillStatus] = useState('')

  const location = useMemo(() => normalizeLocation(latitude, longitude), [latitude, longitude])
  const requiredReady = symptoms.trim() && latitude.trim() && longitude.trim()

  useEffect(() => {
    let mounted = true

    if (!navigator?.geolocation) {
      setPrefillStatus('GPS unavailable in this browser.')
      return () => {
        mounted = false
      }
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mounted) return
        setLatitude(String(position.coords.latitude.toFixed(6)))
        setLongitude(String(position.coords.longitude.toFixed(6)))
        setPrefillStatus('Prefilled from current location.')
      },
      () => {
        if (!mounted) return
        setPrefillStatus('Current location could not be determined.')
      },
      { enableHighAccuracy: true, timeout: 5000 },
    )

    return () => {
      mounted = false
    }
  }, [])

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!requiredReady) {
      setError('Symptoms, latitude, and longitude are required.')
      return
    }

    setLoading(true)
    setError('')

    const prompt = [
      `Patient: ${name.trim() || 'Unknown patient'}`,
      `Symptoms/Condition: ${symptoms.trim()}`,
      age ? `Age: ${age}` : null,
      medicalHistory.trim() ? `Medical history: ${medicalHistory.trim()}` : null,
      priorityOverride ? 'Priority override requested' : null,
    ]
      .filter(Boolean)
      .join(' | ')

    try {
      const response = await api.dispatchEmergency({
        message: prompt,
        location,
        patient_name: name.trim() || undefined,
        metadata: {
          patient_age: age ? Number(age) : null,
          medical_history: medicalHistory.trim() || null,
          priority_override: priorityOverride,
          source: 'admin_modal',
        },
      })

      const responseData = response?.data || response
      if (response?.success === false || responseData?.error_message || responseData?.success === false) {
        throw new Error(response?.message || responseData?.error_message || 'Dispatch failed')
      }

      const caseId = responseData?.case_id ?? responseData?.data?.case_id ?? responseData?.data?.id ?? '—'
      const severity = responseData?.data?.severity || responseData?.severity || (priorityOverride ? 'P0' : '—')
      const ambulanceId = responseData?.data?.ambulance_id ?? responseData?.ambulance_id ?? 'Pending'
      const hospitalId = responseData?.data?.hospital_id ?? responseData?.hospital_id ?? 'Pending'
      const hospitalName = responseData?.data?.hospital_name ?? responseData?.hospital_name ?? null

      const summary = {
        caseId,
        severity,
        ambulanceId,
        hospitalId: hospitalName ? `${hospitalName}` : hospitalId,
        caseStatus: responseData?.case_status || responseData?.data?.case_status || responseData?.workflow_status || 'created',
      }

      setResult(summary)
      onSuccess?.(responseData)
      pushToast({
        title: 'Case dispatched',
        description: `Case #${caseId} created successfully.`,
        tone: 'success',
      })
    } catch (dispatchError) {
      setError(dispatchError.message || 'Dispatch failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm" role="presentation" onClick={onClose}>
      <div className="w-full max-w-4xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-soft" role="dialog" aria-modal="true" aria-labelledby="admin-dispatch-title" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Emergency Dispatch</p>
            <h2 id="admin-dispatch-title" className="mt-2 text-2xl font-black tracking-tight text-slate-900">
              Create emergency case
            </h2>
            <p className="mt-1 text-sm text-slate-500">Dispatch a new case from the admin dashboard.</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-lg font-bold text-slate-500 hover:bg-slate-50 hover:text-slate-900" aria-label="Close dispatch modal">
            ×
          </button>
        </div>

        {result ? (
          <div className="p-6">
            <div className="rounded-[1.75rem] border border-emerald-200 bg-emerald-50 p-6">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-700">Dispatch successful</p>
              <h3 className="mt-2 text-2xl font-black text-slate-900">Case #{safeString(result.caseId)}</h3>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <ResultCard label="Severity" value={safeString(result.severity)} tone={getSeverityTone(result.severity)} />
                <ResultCard label="Assigned Ambulance" value={safeString(result.ambulanceId)} />
                <ResultCard label="Assigned Hospital" value={safeString(result.hospitalId)} />
                <ResultCard label="Status" value={safeString(result.caseStatus)} />
              </div>

              <div className="mt-5 rounded-3xl border border-emerald-200 bg-white p-4 text-sm text-slate-700">
                <p><span className="font-semibold text-slate-900">Patient:</span> {name.trim() || 'Unknown patient'}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Condition:</span> {symptoms.trim()}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Location:</span> {location}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Priority Override:</span> {priorityOverride ? 'Enabled' : 'Disabled'}</p>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" className="btn-primary" onClick={onClose}>
                  Close
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setResult(null)
                    setError('')
                    setSymptoms('')
                    setAge('')
                    setMedicalHistory('')
                    setPriorityOverride(false)
                  }}
                >
                  Create another
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form className="max-h-[80vh] overflow-auto p-6" onSubmit={handleSubmit}>
            <div className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Patient Information</p>
                  <h3 className="mt-1 text-xl font-black text-slate-900">Patient details</h3>
                </div>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-700">Name</span>
                  <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Patient name" disabled={loading} />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-700">Symptoms / Condition <span className="text-rose-600">*</span></span>
                  <textarea
                    className="field min-h-[140px]"
                    value={symptoms}
                    onChange={(event) => setSymptoms(event.target.value)}
                    placeholder='Examples: "chest pain", "severe bleeding", "difficulty breathing"'
                    required
                    disabled={loading}
                  />
                </label>
              </section>

              <section className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Location</p>
                  <h3 className="mt-1 text-xl font-black text-slate-900">Case location</h3>
                </div>

                <p className="text-sm text-slate-500">Use GPS coordinates or address search.</p>
                <p className="text-xs font-semibold text-slate-400">{prefillStatus}</p>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-sm font-semibold text-slate-700">Latitude <span className="text-rose-600">*</span></span>
                    <input className="field" type="number" step="0.000001" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="13.0827" disabled={loading} required />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-semibold text-slate-700">Longitude <span className="text-rose-600">*</span></span>
                    <input className="field" type="number" step="0.000001" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="80.2707" disabled={loading} required />
                  </label>
                </div>

                <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Additional Info</p>

                  <label className="space-y-2">
                    <span className="text-sm font-semibold text-slate-700">Patient Age</span>
                    <input className="field" type="number" min="0" step="1" value={age} onChange={(event) => setAge(event.target.value)} placeholder="Optional" disabled={loading} />
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-semibold text-slate-700">Medical History</span>
                    <textarea className="field min-h-[104px]" value={medicalHistory} onChange={(event) => setMedicalHistory(event.target.value)} placeholder="Optional" disabled={loading} />
                  </label>

                  <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <input className="mt-1 h-4 w-4 accent-sky-600" type="checkbox" checked={priorityOverride} onChange={(event) => setPriorityOverride(event.target.checked)} disabled={loading} />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">Priority Override</span>
                      <span className="block text-sm text-slate-500">Marks the case as P0 regardless of classification.</span>
                    </span>
                  </label>
                </div>
              </section>
            </div>

            {error ? <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

            <div className="mt-5 flex items-center justify-end gap-3 border-t border-slate-200 pt-5">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>
                Close
              </button>
              <button type="submit" className="btn-primary disabled:opacity-60" disabled={!requiredReady || loading}>
                {loading ? 'Dispatching...' : 'Dispatch'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function ResultCard({ label, value, tone = 'bg-slate-50 text-slate-900 border-slate-200' }) {
  return (
    <div className={`rounded-3xl border px-4 py-3 ${tone}`}>
      <p className="text-xs font-bold uppercase tracking-[0.25em] opacity-70">{label}</p>
      <p className="mt-2 text-lg font-black">{value}</p>
    </div>
  )
}

EmergencyDispatchModal.propTypes = {
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
}

ResultCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number, PropTypes.node]).isRequired,
  tone: PropTypes.string,
}

export default EmergencyDispatchModal