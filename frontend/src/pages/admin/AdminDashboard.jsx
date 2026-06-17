import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CaseDetailsModal from '../../components/hospital/CaseDetailsModal.jsx'
import { getAllCases, getHospitalResources, getHospitals } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { sortCasesByPriority } from '../../utils/dispatchHelpers.js'
import EmergencyDispatchModal from '../../components/admin/EmergencyDispatchModal.jsx'
import ChatAssistant from '../../components/shared/ChatAssistant.jsx'
import { POLLING } from '../../constants/polling.js'

// P4.1 – Use centralised polling constant (was 5000 hardcoded)
const REFRESH_MS = POLLING.ADMIN_CASES


function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function normalizeSeverity(value) {
  const severity = safeString(value).toUpperCase()
  return ['P0', 'P1', 'P2', 'P3'].includes(severity) ? severity : 'P3'
}

function severityTone(severity) {
  switch (normalizeSeverity(severity)) {
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

function getCaseId(item) {
  return item?.id ?? item?.case_id ?? item?.caseId ?? item?._id ?? ''
}

function getPatientName(item) {
  return item?.patient_name || item?.patientName || item?.name || item?.full_name || `Patient ${getCaseId(item) || ''}`.trim()
}

function getCaseStatus(item) {
  return safeString(item?.status || item?.case_status || 'triaged')
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return safeString(value)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function deriveHospitalIds(cases) {
  return Array.from(
    new Map(
      cases
        .filter((item) => item.hospital_id != null)
        .map((item) => [String(item.hospital_id), item.hospital_id]),
    ).values(),
  )
}

function summarizeHospitalResources(resources) {
  const bedsAvailable = Number(resources?.beds_available ?? 0)
  const bedsTotal = Number(resources?.beds_total ?? 0)
  const icuAvailable = Number(resources?.icu_available ?? 0)
  const icuTotal = Number(resources?.icu_total ?? 0)
  const ventilatorsAvailable = Number(resources?.ventilators_available ?? 0)
  const ventilatorsTotal = Number(resources?.ventilators_total ?? 0)

  const bedUtilization = bedsTotal ? Math.round(((bedsTotal - bedsAvailable) / bedsTotal) * 100) : 0
  const icuUtilization = icuTotal ? Math.round(((icuTotal - icuAvailable) / icuTotal) * 100) : 0
  const ventilatorUtilization = ventilatorsTotal ? Math.round(((ventilatorsTotal - ventilatorsAvailable) / ventilatorsTotal) * 100) : 0
  const averageUtilization = Math.round((bedUtilization + icuUtilization + ventilatorUtilization) / 3 || 0)

  return {
    bedsAvailable,
    bedsTotal,
    icuAvailable,
    icuTotal,
    ventilatorsAvailable,
    ventilatorsTotal,
    bedUtilization,
    icuUtilization,
    ventilatorUtilization,
    averageUtilization,
  }
}

function getHospitalStatus(utilization) {
  if (utilization >= 80) return { label: 'critical', tone: 'bg-rose-500' }
  if (utilization >= 55) return { label: 'strained', tone: 'bg-amber-500' }
  return { label: 'healthy', tone: 'bg-emerald-500' }
}

function AdminDashboard() {
  const navigate = useNavigate()
  const pushToast = useUiStore((state) => state.pushToast)
  const [cases, setCases] = useState([])
  const [hospitalSnapshots, setHospitalSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCase, setSelectedCase] = useState(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const autoRefreshRef = useRef(null)

  const loadData = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const allCases = await getAllCases()
      const safeCases = Array.isArray(allCases) ? allCases : []
      
      const activeHospitalsList = await getHospitals().catch(() => [])
      const hospitalIds = Array.isArray(activeHospitalsList) ? activeHospitalsList.map((h) => h.id) : []

      const snapshots = await Promise.all(
        hospitalIds.map(async (hospitalId) => {
          try {
            const resources = await getHospitalResources(hospitalId)
            return { hospitalId, resources }
          } catch (error) {
            return { hospitalId, resources: null }
          }
        }),
      )

      setCases(safeCases)
      setHospitalSnapshots(snapshots.filter((s) => s.resources !== null))
    } catch (error) {
      pushToast({ title: 'Unable to load admin dashboard', description: error.message, tone: 'error' })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()

    autoRefreshRef.current = window.setInterval(() => {
      loadData({ silent: true })
    }, REFRESH_MS)

    return () => {
      if (autoRefreshRef.current) {
        window.clearInterval(autoRefreshRef.current)
      }
    }
  }, [])

  const sortedCases = useMemo(() => sortCasesByPriority(cases).slice(0, 10), [cases])

  const severityCounts = useMemo(() => {
    return ['P0', 'P1', 'P2', 'P3'].reduce((accumulator, severity) => {
      accumulator[severity] = cases.filter((item) => normalizeSeverity(item.severity) === severity).length
      return accumulator
    }, {})
  }, [cases])

  const activeAmbulances = useMemo(() => {
    const ids = new Set(cases.filter((item) => item.ambulance_id != null).map((item) => String(item.ambulance_id)))
    return ids.size
  }, [cases])

  const averageResponseTime = useMemo(() => {
    const responseMinutes = cases
      .map((item) => {
        if (item.response_time != null) return Number(item.response_time)
        const created = item.created_at ? new Date(item.created_at).getTime() : null
        const updated = item.updated_at ? new Date(item.updated_at).getTime() : null
        if (!created || !updated || updated < created) return null
        return Math.round((updated - created) / 60000)
      })
      .filter((value) => Number.isFinite(value))

    if (responseMinutes.length === 0) return null
    return Math.round(responseMinutes.reduce((sum, value) => sum + value, 0) / responseMinutes.length)
  }, [cases])

  const hospitals = useMemo(() => {
    return hospitalSnapshots.map(({ hospitalId, resources }) => {
      const summary = summarizeHospitalResources(resources)
      const activeCases = cases.filter((item) => String(item.hospital_id) === String(hospitalId) && !['discharged', 'failed'].includes(getCaseStatus(item).toLowerCase())).length
      const overallUtilization = summary.averageUtilization
      return {
        id: hospitalId,
        name: resources?.hospital_name || resources?.name || `Hospital ${hospitalId}`,
        ...summary,
        activeCases,
        status: getHospitalStatus(overallUtilization),
        overallUtilization,
      }
    })
  }, [cases, hospitalSnapshots])

  const totalCapacityUtilization = hospitals.length > 0 ? Math.round(hospitals.reduce((sum, item) => sum + item.overallUtilization, 0) / hospitals.length) : 0

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">System Stats Banner</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Admin overview</h1>
            <p className="mt-1 text-sm text-slate-500">Real-time system-wide metrics and hospital status.</p>
          </div>
          <button type="button" onClick={() => loadData()} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            {refreshing ? 'Refreshing...' : 'Refresh now'}
          </button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <StatTile label="Total Cases" value={cases.length} tone="slate" />
          <StatTile label="P0" value={severityCounts.P0} tone="rose" />
          <StatTile label="P1" value={severityCounts.P1} tone="orange" />
          <StatTile label="P2" value={severityCounts.P2} tone="amber" />
          <StatTile label="P3" value={severityCounts.P3} tone="emerald" />
          <StatTile label="Ambulances Active" value={activeAmbulances} tone="sky" />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <BannerStat label="Hospitals Capacity" value={`${totalCapacityUtilization}% utilization`} />
          <BannerStat label="Average Response Time" value={averageResponseTime != null ? `${averageResponseTime} min` : '—'} />
          <BannerStat label="Hospitals Monitored" value={hospitals.length} />
          <BannerStat label="Live Refresh" value="5s polling" />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Hospital Cards Grid</p>
              <h2 className="mt-1 text-2xl font-black text-slate-900">Hospital status</h2>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {loading && hospitals.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:col-span-2 xl:col-span-3">
                Loading hospitals...
              </div>
            ) : hospitals.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:col-span-2 xl:col-span-3">
                No hospitals are currently linked to cases.
              </div>
            ) : (
              hospitals.map((hospital) => (
                <button
                  type="button"
                  key={hospital.id}
                  onClick={() => navigate(`/admin/hospitals/${hospital.id}`)}
                  className="text-left"
                >
                  <article className="h-full rounded-3xl border border-slate-200 bg-white p-5 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lg">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-black text-slate-900">{hospital.name}</p>
                        <p className="mt-1 text-sm text-slate-500">Hospital ID {hospital.id}</p>
                      </div>
                      <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold text-white ${hospital.status.tone}`}>
                        <span className="h-2 w-2 rounded-full bg-white/90" />
                        {hospital.status.label}
                      </span>
                    </div>

                    <div className="mt-4 space-y-3 text-sm">
                      <UtilRow label="Bed utilization" percent={hospital.bedUtilization} />
                      <UtilRow label="ICU utilization" percent={hospital.icuUtilization} />
                      <UtilRow label="Ventilator utilization" percent={hospital.ventilatorUtilization} />
                    </div>

                    <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                      Active cases: <span className="font-black text-slate-900">{hospital.activeCases}</span>
                    </div>
                  </article>
                </button>
              ))
            )}
          </div>
        </article>

        <aside className="space-y-6">
          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Quick Action Buttons</p>
                <h2 className="mt-1 text-xl font-black text-slate-900">Operations</h2>
              </div>
            </div>
            <div className="mt-4 grid gap-3">
              <button type="button" onClick={() => setDispatchOpen(true)} className="btn-primary">
                Dispatch Emergency
              </button>
              <button type="button" onClick={() => navigate('/admin/map')} className="btn-secondary">
                View Case Map
              </button>
              <button type="button" onClick={() => navigate('/admin/analytics')} className="btn-secondary">
                View Analytics
              </button>
            </div>
          </article>

          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Active Cases Quick View</p>
                <h2 className="mt-1 text-xl font-black text-slate-900">Last 10 by urgency</h2>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200">
              <div className="max-h-[520px] overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Severity</th>
                      <th className="px-4 py-3">Hospital</th>
                      <th className="px-4 py-3">Ambulance</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {sortedCases.map((item) => {
                      const hospital = hospitals.find((entry) => String(entry.id) === String(item.hospital_id))
                      return (
                        <tr
                          key={getCaseId(item)}
                          role="button"
                          tabIndex={0}
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() => setSelectedCase(item)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setSelectedCase(item)
                            }
                          }}
                        >
                          <td className="px-4 py-4 font-semibold text-slate-900">{getPatientName(item)}</td>
                          <td className="px-4 py-4">
                            <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${severityTone(item.severity)}`}>
                              {normalizeSeverity(item.severity)}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-slate-700">{hospital?.name || item.hospital_name || item.hospital_id || '—'}</td>
                          <td className="px-4 py-4 text-slate-700">{safeString(item.ambulance_id || item.ambulanceId)}</td>
                          <td className="px-4 py-4 text-slate-700">{getCaseStatus(item)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </article>
        </aside>
      </section>

      {selectedCase ? (
        <CaseDetailsModal
          caseData={selectedCase}
          hospitalLabel={selectedCase?.hospital_name || selectedCase?.hospital_id || 'Assigned hospital'}
          allowStatusUpdate={false}
          onClose={() => {
            setSelectedCase(null)
            navigate('/admin/dashboard')
          }}
        />
      ) : null}

      {dispatchOpen ? (
        <EmergencyDispatchModal
          onClose={() => setDispatchOpen(false)}
          onSuccess={() => {
            loadData({ silent: true })
          }}
        />
      ) : null}

      <ChatAssistant caseId={selectedCase ? Number(getCaseId(selectedCase)) : undefined} />
    </div>
  )
}

function StatTile({ label, value, tone }) {
  const tones = {
    slate: 'bg-slate-900 text-white',
    rose: 'bg-rose-600 text-white',
    orange: 'bg-orange-500 text-white',
    amber: 'bg-amber-500 text-slate-950',
    emerald: 'bg-emerald-600 text-white',
    sky: 'bg-sky-600 text-white',
  }

  return (
    <div className={`rounded-2xl px-4 py-3 ${tones[tone] || tones.slate}`}>
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.25em] opacity-80">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  )
}

function BannerStat({ label, value }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-black text-slate-900">{value}</p>
    </div>
  )
}

function UtilRow({ label, percent }) {
  const tone = percent >= 80 ? 'bg-rose-500' : percent >= 55 ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-slate-700">{label}</p>
        <p className="text-sm font-black text-slate-900">{percent}%</p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
    </div>
  )
}

export default AdminDashboard