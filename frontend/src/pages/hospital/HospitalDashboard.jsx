import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { usePagination } from '../../hooks/usePagination.js'
import { POLLING } from '../../constants/polling.js'
import CaseDetailsModal from '../../components/hospital/CaseDetailsModal.jsx'
import ResourcesPanel from '../../components/hospital/ResourcesPanel.jsx'
import ChatAssistant from '../../components/shared/ChatAssistant.jsx'

const STATUS_OPTIONS = [
  { value: 'alerts_sent', label: 'Active / Incoming' },
  { value: 'failed_escalation', label: 'Transferred' },
]

const STATUS_LABELS = {
  created: 'Created',
  triaged: 'Triaged',
  dispatched: 'Dispatched',
  arrived: 'Arrived',
  resolved: 'Resolved',
  alerts_sent: 'Active / Incoming',
  discharged: 'Discharged',
  failed_escalation: 'Transferred',
}

const SEVERITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']

function safeString(value) {
  if (value == null) return '—'
  return String(value)
}

function toLower(value) {
  return safeString(value).toLowerCase()
}

function normalizeSeverity(value) {
  const normalized = safeString(value).toUpperCase()
  return SEVERITY_OPTIONS.includes(normalized) ? normalized : 'P3'
}

function severityRank(value) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[normalizeSeverity(value)] ?? 3
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return safeString(value)
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatRelativeTime(value) {
  if (!value) return 'Now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Now'
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function getCaseId(item) {
  return item?.id ?? item?.case_id ?? item?.caseId ?? item?._id ?? ''
}

function getPatientName(item) {
  return item?.patient_name || item?.patientName || item?.name || item?.full_name || `Patient ${getCaseId(item) || ''}`.trim()
}

function getCondition(item) {
  return item?.condition || item?.medical_condition || item?.description || item?.notes || '—'
}

function getStatus(item) {
  return item?.status || item?.case_status || 'triaged'
}

function getEta(item) {
  return item?.eta || item?.estimated_arrival || item?.estimated_time || '—'
}

function getUpdatedAt(item) {
  return item?.updated_at || item?.created_at || item?.assigned_at || null
}

function getSeverityColor(severity) {
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

function getStatusTone(status) {
  switch (toLower(status)) {
    case 'discharged':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'failed':
      return 'bg-rose-50 text-rose-700 border-rose-200'
    case 'arrived':
      return 'bg-sky-50 text-sky-700 border-sky-200'
    case 'en-route':
    case 'en route':
      return 'bg-indigo-50 text-indigo-700 border-indigo-200'
    case 'dispatched':
      return 'bg-violet-50 text-violet-700 border-violet-200'
    default:
      return 'bg-slate-50 text-slate-700 border-slate-200'
  }
}

function cloneMessage(message) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...message,
  }
}

function HospitalDashboard() {
  const { currentUser } = useAuth()
  const location = useLocation()
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (location.hash) {
      const element = document.getElementById(location.hash.slice(1))
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      }
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [location])
  const [cases, setCases] = useState([])
  const [resources, setResources] = useState(null)
  const [selectedCase, setSelectedCase] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ status: '', severity: '' })
  const [chatOpen, setChatOpen] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([
    cloneMessage({ role: 'assistant', text: 'Ask questions or update resources. Try: How many beds are available?' }),
  ])
  const [caseStatusBusyId, setCaseStatusBusyId] = useState(null)
  const [activeAlertIds, setActiveAlertIds] = useState([])
  const previousCaseIdsRef = useRef(new Set())
  const autoRefreshRef = useRef(null)

  const hospitalId = currentUser?.hospital_id ?? currentUser?.hospitalId ?? currentUser?.hospitalID ?? currentUser?.id
  const userId = currentUser?.user_id ?? currentUser?.userId ?? currentUser?.id ?? hospitalId

  const normalizeCaseList = (payload) => {
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload?.cases)) return payload.cases
    if (Array.isArray(payload?.data)) return payload.data
    return []
  }

  const normalizeResource = (payload) => {
    if (payload?.data && typeof payload.data === 'object') return payload.data
    if (typeof payload === 'object' && payload !== null) return payload
    return null
  }

  const loadData = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)

    try {
      const [caseResponse, resourceResponse] = await Promise.all([
        hospitalId ? api.getHospitalCases(hospitalId) : Promise.resolve([]),
        hospitalId ? api.getHospitalResources(hospitalId) : Promise.resolve(null),
      ])

      const rawCases = normalizeCaseList(caseResponse)
      const nextCases = rawCases.filter((item) => toLower(getStatus(item)) !== 'discharged')
      const nextResources = normalizeResource(resourceResponse)

      setCases(nextCases)
      setResources(nextResources)

      const nextIds = new Set(nextCases.map((item) => String(getCaseId(item))))
      const newCases = nextCases.filter((item) => {
        const id = String(getCaseId(item))
        return id && !previousCaseIdsRef.current.has(id)
      })

      if (newCases.length > 0) {
        newCases.slice(0, 3).forEach((item) => {
          const severity = normalizeSeverity(item.severity)
          const message = `New case assigned: ${getPatientName(item)}, Severity ${severity}`
          pushToast({ title: 'New case assigned', description: message, tone: 'info' })
          setActiveAlertIds((current) => [String(getCaseId(item)), ...current].slice(0, 5))
        })
      }

      previousCaseIdsRef.current = nextIds
    } catch (error) {
      if (!silent) {
        pushToast({ title: 'Unable to load hospital dashboard', description: error.message, tone: 'error' })
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadData()

    autoRefreshRef.current = window.setInterval(() => {
      loadData({ silent: true })
    }, POLLING.HOSPITAL_CASES)

    return () => {
      if (autoRefreshRef.current) {
        window.clearInterval(autoRefreshRef.current)
      }
    }
  }, [hospitalId])

  const totals = useMemo(() => {
    const bedAvailable = Number(resources?.beds_available ?? resources?.general_beds_available ?? 0)
    const bedTotal = Number(resources?.beds_total ?? resources?.general_beds_total ?? 0)
    const icuAvailable = Number(resources?.icu_available ?? 0)
    const icuTotal = Number(resources?.icu_total ?? 0)
    const ventilatorAvailable = Number(resources?.ventilators_available ?? resources?.ventilator_available ?? 0)
    const ventilatorTotal = Number(resources?.ventilators_total ?? resources?.ventilator_total ?? 0)

    return {
      beds: { available: bedAvailable, total: bedTotal, percent: bedTotal ? Math.round((bedAvailable / bedTotal) * 100) : 0 },
      icu: { available: icuAvailable, total: icuTotal, percent: icuTotal ? Math.round((icuAvailable / icuTotal) * 100) : 0 },
      ventilators: {
        available: ventilatorAvailable,
        total: ventilatorTotal,
        percent: ventilatorTotal ? Math.round((ventilatorAvailable / ventilatorTotal) * 100) : 0,
      },
    }
  }, [resources])

  const severityCounts = useMemo(() => {
    return SEVERITY_OPTIONS.reduce((accumulator, severity) => {
      accumulator[severity] = cases.filter((item) => normalizeSeverity(item.severity) === severity).length
      return accumulator
    }, {})
  }, [cases])

  const filteredCases = useMemo(() => {
    return [...cases]
      .filter((item) => (filters.status ? toLower(getStatus(item)) === filters.status : true))
      .filter((item) => (filters.severity ? normalizeSeverity(item.severity) === filters.severity : true))
      .sort((left, right) => {
        const severityDelta = severityRank(left.severity) - severityRank(right.severity)
        if (severityDelta !== 0) return severityDelta
        const leftTime = new Date(getUpdatedAt(left) || 0).getTime()
        const rightTime = new Date(getUpdatedAt(right) || 0).getTime()
        return rightTime - leftTime
      })
  }, [cases, filters])

  // P3.1 – Pagination for the cases table
  const casePagination = usePagination(filteredCases, 20)

  const sendChatMessage = async (event) => {
    event.preventDefault()
    const message = chatInput.trim()
    if (!message) return

    const outgoing = cloneMessage({ role: 'user', text: message })
    setChatMessages((current) => [...current, outgoing])
    setChatInput('')

    try {
      const response = await api.sendChatMessage({
        message,
        user_id: userId,
        hospital_user_id: hospitalId,
      })

      const assistantText = response?.message || 'Updated.'
      setChatMessages((current) => [...current, cloneMessage({ role: 'assistant', text: assistantText })])

      const match = message.match(/update\s+(beds?|icu|ventilators?)\s+by\s+(-?\d+)/i)
      if (match) {
        // Chat agent applies the resource update server-side; just refresh the display
        await loadData({ silent: true })
      }
    } catch (error) {
      setChatMessages((current) => [...current, cloneMessage({ role: 'assistant', text: error.message || 'I could not process that request.' })])
    }
  }

  const updateCaseStatus = async (caseId, status) => {
    if (!caseId || !status) return
    setCaseStatusBusyId(caseId)
    try {
      await api.updateHospitalCaseStatus(caseId, status)
      pushToast({ title: 'Case updated', description: `Case ${caseId} moved to ${status}.`, tone: 'success' })
      await loadData({ silent: true })
    } catch (error) {
      pushToast({ title: 'Unable to update case status', description: error.message, tone: 'error' })
    } finally {
      setCaseStatusBusyId(null)
    }
  }

  const alertChips = activeAlertIds.slice(0, 5)

  return (
    <div className="space-y-6 pb-24 lg:pb-8">
      <section className="sticky top-4 z-20 rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-soft backdrop-blur">
        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Hospital Dashboard</p>
                <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-900">Incoming emergency cases</h1>
              </div>
              <button type="button" onClick={() => loadData()} className="ml-auto rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                Refresh now
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatPill label="Incoming" value={cases.length} tone="slate" />
              <StatPill label="P0" value={severityCounts.P0} tone="rose" />
              <StatPill label="P1" value={severityCounts.P1} tone="orange" />
              <StatPill label="P2" value={severityCounts.P2} tone="amber" />
              <StatPill label="P3" value={severityCounts.P3} tone="emerald" />
              <StatPill label="Alerts" value={alertChips.length} tone="sky" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <ResourceSummary label="Beds" value={totals.beds.percent} suffix="%" tone="sky" />
            <ResourceSummary label="ICU" value={totals.icu.percent} suffix="%" tone="rose" />
            <ResourceSummary label="Ventilators" value={totals.ventilators.percent} suffix="%" tone="amber" />
          </div>
        </div>
      </section>

      {alertChips.length > 0 ? (
        <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {alertChips.map((id) => {
            const item = cases.find((entry) => String(getCaseId(entry)) === String(id))
            if (!item) return null
            return (
              <div key={id} className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 shadow-sm">
                New case assigned: {getPatientName(item)}, Severity {normalizeSeverity(item.severity)}
                <button
                  type="button"
                  className="ml-3 font-semibold text-sky-700 underline-offset-2 hover:underline"
                  onClick={() => setActiveAlertIds((current) => current.filter((currentId) => currentId !== String(id)))}
                >
                  Dismiss
                </button>
              </div>
            )
          })}
        </section>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.2fr]">
        <aside className="space-y-6" id="resources">
          <ResourcesPanel hospitalId={hospitalId} />

          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft bg-gradient-to-br from-slate-900 to-indigo-950 text-white">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-400">Operations Assistant</p>
                <h2 className="mt-1 text-xl font-black">AI Copilot</h2>
              </div>
            </div>
            <p className="mt-3 text-sm text-slate-300">
              Query cases, dispatch details, and request resource updates using the floating Assistant bubble in the bottom right.
            </p>
          </article>
        </aside>

        <section className="space-y-6">
          <article id="cases" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Cases List</p>
                <h2 className="mt-1 text-xl font-black text-slate-900">Detailed incoming cases</h2>
              </div>

              <div className="flex flex-wrap gap-3">
                <select className="field min-w-[180px]" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
                  <option value="">All statuses</option>
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select className="field min-w-[140px]" value={filters.severity} onChange={(event) => setFilters((current) => ({ ...current, severity: event.target.value }))}>
                  <option value="">All severity</option>
                  {SEVERITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div id="workflow" className="mt-4 overflow-hidden rounded-3xl border border-slate-200">
              <div className="max-h-[640px] overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Patient Name</th>
                      <th className="px-4 py-3">Severity</th>
                      <th className="px-4 py-3">Condition</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Ambulance ID</th>
                      <th className="px-4 py-3">ETA</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {loading ? (
                      <tr>
                        <td colSpan="7" className="px-4 py-10 text-center text-slate-500">
                          Loading cases...
                        </td>
                      </tr>
                    ) : filteredCases.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="px-4 py-10 text-center text-slate-500">
                          No cases match the current filters.
                        </td>
                      </tr>
                    ) : (
                      casePagination.pageItems.map((item) => {
                        const caseId = getCaseId(item)
                        return (
                          <tr
                            key={caseId}
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
                              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${getSeverityColor(item.severity)}`}>
                                {normalizeSeverity(item.severity)}
                              </span>
                            </td>
                            <td className="px-4 py-4 text-slate-700">{getCondition(item)}</td>
                            <td className="px-4 py-4">
                              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold capitalize ${getStatusTone(getStatus(item))}`}>
                                {STATUS_LABELS[getStatus(item)] || getStatus(item)}
                              </span>
                            </td>
                            <td className="px-4 py-4 text-slate-700">{safeString(item.ambulance_id || item.ambulanceId)}</td>
                            <td className="px-4 py-4 text-slate-700">{getEta(item)}</td>
                            <td className="px-4 py-4">
                              <div className="flex flex-col gap-2">
                                <select
                                  className="field py-2 text-xs"
                                  value=""
                                  disabled={caseStatusBusyId === caseId}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => {
                                    event.stopPropagation()
                                    const nextStatus = event.target.value
                                    if (nextStatus) updateCaseStatus(caseId, nextStatus)
                                    event.target.value = ''
                                  }}
                                >
                                  <option value="">Choose Action</option>
                                  <option value="discharged">Discharge Patient</option>
                                  <option value="failed_escalation">Transfer to Another Hospital</option>
                                </select>
                                {caseStatusBusyId === caseId ? <span className="text-xs text-slate-500">Updating...</span> : null}
                              </div>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* P3.1 – Pagination controls */}
              {casePagination.totalPages > 1 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">
                    Page {casePagination.page} of {casePagination.totalPages} — {filteredCases.length} case{filteredCases.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!casePagination.hasPrev}
                      onClick={casePagination.prev}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!casePagination.hasNext}
                      onClick={casePagination.next}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          </article>
        </section>
      </section>

      {selectedCase ? (
        <CaseDetailsModal caseData={selectedCase} hospitalId={hospitalId} onClose={() => setSelectedCase(null)} onUpdated={() => loadData({ silent: true })} />
      ) : null}

      <ChatAssistant caseId={selectedCase ? Number(getCaseId(selectedCase)) : undefined} />
    </div>
  )
}

function StatPill({ label, value, tone }) {
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

function ResourceSummary({ label, value, suffix, tone }) {
  const tones = {
    sky: 'from-sky-50 to-sky-100 text-sky-700',
    rose: 'from-rose-50 to-rose-100 text-rose-700',
    amber: 'from-amber-50 to-amber-100 text-amber-700',
  }

  return (
    <div className={`rounded-3xl bg-gradient-to-br ${tones[tone] || tones.sky} p-4`}>
      <p className="text-xs font-bold uppercase tracking-[0.25em] opacity-80">{label}</p>
      <p className="mt-2 text-3xl font-black">
        {value}
        <span className="ml-1 text-base font-semibold">{suffix}</span>
      </p>
    </div>
  )
}

export default HospitalDashboard