import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { usePagination } from '../../hooks/usePagination.js'
import CaseDetailsModal from '../../components/hospital/CaseDetailsModal.jsx'

const SEVERITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']

function safeString(value) {
  if (value == null) return '—'
  return String(value)
}

function normalizeSeverity(value) {
  const normalized = safeString(value).toUpperCase()
  return SEVERITY_OPTIONS.includes(normalized) ? normalized : 'P3'
}

function severityRank(value) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[normalizeSeverity(value)] ?? 3
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
  return item?.status || item?.case_status || 'discharged'
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

function HospitalHistory() {
  const { currentUser } = useAuth()
  const pushToast = useUiStore((state) => state.pushToast)
  const [cases, setCases] = useState([])
  const [selectedCase, setSelectedCase] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filters, setFilters] = useState({ severity: '', search: '' })

  const hospitalId = currentUser?.hospital_id ?? currentUser?.hospitalId ?? currentUser?.hospitalID ?? currentUser?.id

  const normalizeCaseList = (payload) => {
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload?.cases)) return payload.cases
    if (Array.isArray(payload?.data)) return payload.data
    return []
  }

  const loadData = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const caseResponse = hospitalId ? await api.getHospitalCases(hospitalId) : []
      const allHospitalCases = normalizeCaseList(caseResponse)
      
      // Filter strictly for discharged cases
      const dischargedCases = allHospitalCases.filter((item) => getStatus(item).toLowerCase() === 'discharged')
      setCases(dischargedCases)
    } catch (error) {
      if (!silent) {
        pushToast({ title: 'Unable to load case history', description: error.message, tone: 'error' })
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [hospitalId])

  const severityCounts = useMemo(() => {
    return SEVERITY_OPTIONS.reduce((accumulator, severity) => {
      accumulator[severity] = cases.filter((item) => normalizeSeverity(item.severity) === severity).length
      return accumulator
    }, {})
  }, [cases])

  const filteredCases = useMemo(() => {
    return [...cases]
      .filter((item) => (filters.severity ? normalizeSeverity(item.severity) === filters.severity : true))
      .filter((item) => {
        if (!filters.search) return true
        const query = filters.search.toLowerCase()
        return (
          getPatientName(item).toLowerCase().includes(query) ||
          getCondition(item).toLowerCase().includes(query) ||
          String(getCaseId(item)).includes(query)
        )
      })
      .sort((left, right) => {
        const severityDelta = severityRank(left.severity) - severityRank(right.severity)
        if (severityDelta !== 0) return severityDelta
        const leftTime = new Date(getUpdatedAt(left) || 0).getTime()
        const rightTime = new Date(getUpdatedAt(right) || 0).getTime()
        return rightTime - leftTime
      })
  }, [cases, filters])

  const casePagination = usePagination(filteredCases, 20)

  return (
    <div className="space-y-6 pb-24 lg:pb-8">
      <section className="sticky top-4 z-20 rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-soft backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-emerald-600">Discharged Cases Archive</p>
            <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-900">Cases Attended History</h1>
          </div>
          <button
            type="button"
            onClick={() => loadData({ silent: true })}
            className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
            disabled={loading || refreshing}
          >
            {refreshing ? 'Refreshing...' : 'Refresh Archive'}
          </button>
        </div>

        <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatPill label="Total Discharged" value={cases.length} tone="emerald" />
          <StatPill label="P0 cases" value={severityCounts.P0} tone="rose" />
          <StatPill label="P1 cases" value={severityCounts.P1} tone="orange" />
          <StatPill label="P2 cases" value={severityCounts.P2} tone="amber" />
          <StatPill label="P3 cases" value={severityCounts.P3} tone="teal" />
        </div>
      </section>

      <section className="space-y-6">
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Search Filter</p>
              <h2 className="mt-1 text-xl font-black text-slate-900">Archived Records</h2>
            </div>

            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="Search patient, condition, case ID..."
                className="field min-w-[240px]"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
              <select
                className="field min-w-[140px]"
                value={filters.severity}
                onChange={(event) => setFilters((current) => ({ ...current, severity: event.target.value }))}
              >
                <option value="">All severity</option>
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200">
            <div className="max-h-[640px] overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Patient Name</th>
                    <th className="px-4 py-3">Severity</th>
                    <th className="px-4 py-3">Condition</th>
                    <th className="px-4 py-3">Case ID</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Ambulance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {loading ? (
                    <tr>
                      <td colSpan="6" className="px-4 py-10 text-center text-slate-500 animate-pulse">
                        Loading archived cases...
                      </td>
                    </tr>
                  ) : filteredCases.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="px-4 py-10 text-center text-slate-500">
                        No archived cases found.
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
                          className="cursor-pointer hover:bg-slate-50 transition"
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
                          <td className="px-4 py-4 text-slate-500">#{caseId}</td>
                          <td className="px-4 py-4">
                            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 capitalize">
                              {getStatus(item)}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-slate-700">{safeString(item.ambulance_id || item.ambulanceId)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {casePagination.totalPages > 1 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 p-4 border-t border-slate-100 bg-slate-50">
                <p className="text-xs text-slate-500">
                  Page {casePagination.page} of {casePagination.totalPages} — {filteredCases.length} case{filteredCases.length === 1 ? '' : 's'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={!casePagination.hasPrev}
                    onClick={casePagination.prev}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
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

      {selectedCase ? (
        <CaseDetailsModal caseData={selectedCase} hospitalId={hospitalId} onClose={() => setSelectedCase(null)} onUpdated={() => loadData({ silent: true })} />
      ) : null}
    </div>
  )
}

function StatPill({ label, value, tone }) {
  const tones = {
    emerald: 'bg-emerald-600 text-white',
    rose: 'bg-rose-600 text-white',
    orange: 'bg-orange-500 text-white',
    amber: 'bg-amber-500 text-slate-950',
    teal: 'bg-teal-600 text-white',
  }

  return (
    <div className={`rounded-2xl px-4 py-3 ${tones[tone] || tones.emerald}`}>
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.25em] opacity-80">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  )
}

export default HospitalHistory
