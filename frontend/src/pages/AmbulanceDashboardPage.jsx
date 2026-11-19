export { default } from './ambulance/AmbulanceDashboard.jsx'import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import * as api from '../services/api.js'
import { deriveAmbulancesFromCases, formatRelativeTime, sortCasesByPriority, severityScore } from '../utils/dispatchHelpers.js'
import { useUiStore } from '../store/uiStore.js'
import { h3GridDistance } from '../utils/incidentInsights.js'

function calculateH3DistanceScore(caseItem, ambulanceLocation) {
  if (!ambulanceLocation?.lat || !ambulanceLocation?.lon) return 0
  const location = String(caseItem.location || '')
  const numericMatch = location.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/)
  if (!numericMatch) return 0
  const lat = Number(numericMatch[1])
  const lon = Number(numericMatch[2])
  if (Number.isNaN(lat) || Number.isNaN(lon)) return 0
  const distance = h3GridDistance(
    { latitude: ambulanceLocation.lat, longitude: ambulanceLocation.lon },
    { latitude: lat, longitude: lon },
  )
  return distance != null ? Math.max(0, 100 - distance) : 0
}

function AmbulanceDashboardPage() {
  const { currentUser } = useAuth()
  const pushToast = useUiStore((state) => state.pushToast)
  const [assignedCases, setAssignedCases] = useState([])
  const [allCases, setAllCases] = useState([])
  const [status, setStatus] = useState('idle')
  const [location, setLocation] = useState({ latitude: '', longitude: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const ambulanceLocation = useMemo(() => ({
    lat: Number(location.latitude),
    lon: Number(location.longitude),
  }), [location])

  const loadData = async () => {
    setLoading(true)
    try {
      const [assignedResponse, allCasesResponse] = await Promise.all([
        currentUser?.ambulance_id ? api.getAssignedCases(currentUser.ambulance_id) : Promise.resolve([]),
        api.getAllCases(),
      ])
      setAssignedCases(Array.isArray(assignedResponse) ? assignedResponse : [])
      setAllCases(Array.isArray(allCasesResponse) ? allCasesResponse : [])
    } catch (error) {
      pushToast({ title: 'Ambulance data unavailable', description: error.message, tone: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [currentUser?.ambulance_id])

  const queue = useMemo(() => {
    return sortCasesByPriority(allCases)
      .map((item) => ({
        ...item,
        distanceScore: calculateH3DistanceScore(item, ambulanceLocation),
      }))
      .sort((left, right) => {
        const severityDelta = severityScore(left.severity) - severityScore(right.severity)
        if (severityDelta !== 0) return severityDelta
        return right.distanceScore - left.distanceScore
      })
      .slice(0, 8)
  }, [ambulanceLocation, allCases])

  const currentCase = assignedCases[0] || queue[0] || null
  const currentStatus = currentCase ? currentCase.status || status : status

  const updateStatus = async (nextStatus) => {
    if (!currentUser?.ambulance_id) return
    setSaving(true)
    try {
      await api.updateAmbulanceStatus(currentUser.ambulance_id, nextStatus)
      setStatus(nextStatus)
      pushToast({ title: 'Status updated', description: `Ambulance status set to ${nextStatus}.`, tone: 'success' })
      await loadData()
    } catch (error) {
      pushToast({ title: 'Status update failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const updateLocation = async () => {
    if (!currentUser?.ambulance_id) return
    if (!Number.isFinite(ambulanceLocation.lat) || !Number.isFinite(ambulanceLocation.lon)) return
    setSaving(true)
    try {
      await api.updateAmbulanceLocation(currentUser.ambulance_id, ambulanceLocation.lat, ambulanceLocation.lon)
      pushToast({ title: 'Location synced', description: 'Live coordinates updated.', tone: 'success' })
    } catch (error) {
      pushToast({ title: 'Location sync failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const acceptCase = async (caseItem) => {
    if (!caseItem) return
    await updateStatus('en_route')
    pushToast({ title: 'Case accepted', description: `Heading to case ${caseItem.id}.`, tone: 'info' })
  }

  const displayQueue = useMemo(() => queue.filter((item) => String(item.id) !== String(currentCase?.id)), [currentCase?.id, queue])

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-4">
        {[
          ['Assigned case', currentCase ? `#${currentCase.id}` : '—'],
          ['Current status', currentStatus],
          ['Nearby queue', displayQueue.length],
          ['Fleet view', deriveAmbulancesFromCases(allCases).length],
        ].map(([label, value]) => (
          <article key={label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-400">{label}</p>
            <p className="mt-3 text-3xl font-black text-slate-900">{value}</p>
          </article>
        ))}
      </section>

      <section id="queue" className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Case priority queue</p>
              <h3 className="mt-2 text-2xl font-black text-slate-900">Geo-based case recommendation</h3>
            </div>
            <button type="button" onClick={loadData} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
              Refresh
            </button>
          </div>

          <div className="mt-6 overflow-hidden rounded-3xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Case</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr><td colSpan="5" className="px-4 py-10 text-center text-slate-500">Loading queue...</td></tr>
                ) : displayQueue.length === 0 ? (
                  <tr><td colSpan="5" className="px-4 py-10 text-center text-slate-500">No nearby cases.</td></tr>
                ) : (
                  displayQueue.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-4 font-semibold text-slate-900">#{item.id}</td>
                      <td className="px-4 py-4 text-slate-700">{item.severity || 'P2'}</td>
                      <td className="px-4 py-4 text-slate-700">{item.location || 'Unknown'}</td>
                      <td className="px-4 py-4 text-slate-700">{Math.round(item.distanceScore || 0)}</td>
                      <td className="px-4 py-4">
                        <button type="button" onClick={() => acceptCase(item)} className="rounded-xl bg-sky-600 px-3 py-2 text-xs font-bold text-white">
                          Accept
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>

        <aside id="navigation" className="space-y-6">
          <article className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 to-slate-800 p-6 text-white shadow-soft">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-300">Navigation</p>
            <h3 className="mt-2 text-2xl font-black">Estimated travel time</h3>
            <p className="mt-2 text-sm leading-6 text-slate-300">Track the ambulance position and keep dispatch updated with live location sync.</p>

            <div className="mt-5 grid gap-3">
              <label className="space-y-2 text-sm font-semibold text-slate-200">
                <span>Latitude</span>
                <input value={location.latitude} onChange={(event) => setLocation((prev) => ({ ...prev, latitude: event.target.value }))} type="number" step="0.0001" className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-white outline-none" />
              </label>
              <label className="space-y-2 text-sm font-semibold text-slate-200">
                <span>Longitude</span>
                <input value={location.longitude} onChange={(event) => setLocation((prev) => ({ ...prev, longitude: event.target.value }))} type="number" step="0.0001" className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-white outline-none" />
              </label>
            </div>

            <button type="button" onClick={updateLocation} className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm font-bold text-slate-950">
              Sync location
            </button>
          </article>

          <article id="status" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-rose-600">Status history</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {['idle', 'en_route', 'at_hospital', 'delayed'].map((item) => (
                <button key={item} type="button" disabled={saving} onClick={() => updateStatus(item)} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                  {item}
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-500">Your status updates and location changes are written to the backend and reflected in dispatch views.</p>
          </article>
        </aside>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Active case</p>
          <h3 className="mt-2 text-2xl font-black text-slate-900">Case acceptance flow</h3>
          {currentCase ? (
            <div className="mt-5 rounded-3xl bg-slate-50 p-5">
              <p className="text-lg font-bold text-slate-900">Case #{currentCase.id}</p>
              <p className="mt-2 text-sm text-slate-500">{currentCase.condition || 'No condition'} · {currentCase.location || 'No location'}</p>
              <p className="mt-2 text-sm text-slate-500">Last updated {formatRelativeTime(currentCase.created_at)}</p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No assigned case. Accept a case from the queue to begin navigation.</p>
          )}
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-600">Fleet activity</p>
          <h3 className="mt-2 text-2xl font-black text-slate-900">Status changes and assignments</h3>
          <div className="mt-5 space-y-3">
            {deriveAmbulancesFromCases(allCases).slice(0, 5).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-4">
                <div>
                  <p className="font-semibold text-slate-900">Ambulance {item.id}</p>
                  <p className="text-sm text-slate-500">{item.status || 'idle'}</p>
                </div>
                <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-sky-700">Live</span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  )
}

export default AmbulanceDashboardPage