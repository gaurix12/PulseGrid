import { useEffect, useMemo, useState } from 'react'
import { changeAmbulance, changeHospital, getAllCases, getHospitals } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { h3GridDistance, parseCaseCoordinates, sortCasesByPriority } from '../../utils/incidentInsights.js'

const STATUS_OPTIONS = ['All', 'triaged', 'dispatched', 'en-route', 'arrived', 'discharged', 'failed']
const SEVERITY_OPTIONS = ['All', 'P0', 'P1', 'P2', 'P3']
const SORT_OPTIONS = [
  { label: 'Date Created', value: 'created_at' },
  { label: 'Severity', value: 'severity' },
  { label: 'ETA', value: 'eta' },
]
const PAGE_SIZE = 20

function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function normalizeSeverity(value) {
  const severity = safeString(value).toUpperCase()
  return ['P0', 'P1', 'P2', 'P3'].includes(severity) ? severity : 'P3'
}

function normalizeStatus(value) {
  return safeString(value).toLowerCase()
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return safeString(value)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatEta(value) {
  if (value == null || value === '') return '—'
  const eta = Number(value)
  if (Number.isFinite(eta)) return `${eta} min`
  return safeString(value)
}

function severityTone(severity) {
  switch (normalizeSeverity(severity)) {
    case 'P0':
      return 'border-rose-200 bg-rose-100 text-rose-800'
    case 'P1':
      return 'border-orange-200 bg-orange-100 text-orange-800'
    case 'P2':
      return 'border-amber-200 bg-amber-100 text-amber-800'
    default:
      return 'border-emerald-200 bg-emerald-100 text-emerald-800'
  }
}

function statusTone(status) {
  switch (normalizeStatus(status)) {
    case 'discharged':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'border-rose-200 bg-rose-50 text-rose-700'
    case 'arrived':
      return 'border-sky-200 bg-sky-50 text-sky-700'
    case 'en-route':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700'
    case 'dispatched':
      return 'border-violet-200 bg-violet-50 text-violet-700'
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700'
  }
}

function getCaseId(item) {
  return item?.id ?? item?.case_id ?? item?.caseId ?? item?._id ?? ''
}

function getPatientName(item) {
  return item?.patient_name || item?.patientName || item?.name || item?.full_name || `Patient ${getCaseId(item) || ''}`.trim()
}

function getHospitalLabel(item, hospitalsById) {
  const hospitalId = item?.hospital_id ?? item?.hospitalId
  if (hospitalId == null) return 'Unassigned'
  return hospitalsById.get(String(hospitalId))?.name || `Hospital ${hospitalId}`
}

function buildHospitalMap(hospitals, cases) {
  const map = new Map()

  for (const hospital of hospitals || []) {
    map.set(String(hospital.id), {
      ...hospital,
      id: hospital.id,
      name: hospital.name || `Hospital ${hospital.id}`,
      location: hospital.location || 'Unknown location',
      latitude: hospital.latitude ?? hospital.lat ?? null,
      longitude: hospital.longitude ?? hospital.lon ?? null,
    })
  }

  for (const item of cases || []) {
    if (item.hospital_id == null) continue
    const key = String(item.hospital_id)
    if (!map.has(key)) {
      map.set(key, {
        id: item.hospital_id,
        name: `Hospital ${item.hospital_id}`,
        location: item.location || 'Assigned from case data',
      })
    }
  }

  return map
}

function buildAmbulanceMap(cases) {
  const map = new Map()

  for (const item of cases || []) {
    const ambulanceId = item?.ambulance_id ?? item?.ambulanceId
    if (ambulanceId == null) continue
    const key = String(ambulanceId)
    const ambulance = item?.ambulance || item?.assigned_ambulance || item?.assignedAmbulance || {}
    const currentCaseId = getCaseId(item)
    const currentLocation = parseCaseCoordinates(item)
    const existing = map.get(key) || {
      id: ambulanceId,
      driver_name: ambulance?.driver_name || ambulance?.driverName || `Ambulance ${ambulanceId}`,
      status: ambulance?.status || item?.ambulance_status || item?.ambulanceStatus || 'idle',
      current_latitude: ambulance?.current_latitude ?? item?.current_latitude ?? null,
      current_longitude: ambulance?.current_longitude ?? item?.current_longitude ?? null,
      activeCaseCount: 0,
      assignedCases: [],
    }

    if (currentLocation && existing.current_latitude == null && existing.current_longitude == null) {
      existing.current_latitude = currentLocation.latitude
      existing.current_longitude = currentLocation.longitude
    }

    existing.assignedCases = [...existing.assignedCases, currentCaseId].filter(Boolean)
    existing.activeCaseCount = existing.assignedCases.length
    map.set(key, existing)
  }

  return map
}

function getAmbulanceLocation(ambulance) {
  const latitude = Number(ambulance?.current_latitude ?? ambulance?.latitude ?? ambulance?.lat)
  const longitude = Number(ambulance?.current_longitude ?? ambulance?.longitude ?? ambulance?.lon)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

function recommendAmbulance(caseItem, ambulances) {
  const caseLocation = parseCaseCoordinates(caseItem)
  const sorted = [...ambulances]
    .map((ambulance) => {
      const location = getAmbulanceLocation(ambulance)
      const gridDistance = caseLocation && location ? h3GridDistance(caseLocation, location) : null
      const idleScore = normalizeStatus(ambulance.status) === 'idle' ? 0 : 1
      const loadScore = Number(ambulance.activeCaseCount || 0)

      return {
        ...ambulance,
        gridDistance,
        idleScore,
        loadScore,
      }
    })
    .sort((left, right) => {
      if (left.idleScore !== right.idleScore) return left.idleScore - right.idleScore
      if ((left.gridDistance ?? Number.POSITIVE_INFINITY) !== (right.gridDistance ?? Number.POSITIVE_INFINITY)) {
        return (left.gridDistance ?? Number.POSITIVE_INFINITY) - (right.gridDistance ?? Number.POSITIVE_INFINITY)
      }
      if (left.loadScore !== right.loadScore) return left.loadScore - right.loadScore
      return Number(left.id) - Number(right.id)
    })

  return sorted[0] || null
}

function CaseManagementPage() {
  const pushToast = useUiStore((state) => state.pushToast)
  const [cases, setCases] = useState([])
  const [hospitals, setHospitals] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activePage, setActivePage] = useState(1)
  const [selectedCase, setSelectedCase] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [appliedFilters, setAppliedFilters] = useState({ status: 'All', severity: 'All', hospitalId: 'All', sortBy: 'created_at' })
  const [draftFilters, setDraftFilters] = useState({ status: 'All', severity: 'All', hospitalId: 'All', sortBy: 'created_at' })
  const [reason, setReason] = useState('Resource shortage')
  const [targetHospitalId, setTargetHospitalId] = useState('')
  const [targetAmbulanceId, setTargetAmbulanceId] = useState('')

  const loadData = async () => {
    setLoading(true)
    try {
      const [allCases, hospitalList] = await Promise.all([getAllCases(), getHospitals().catch(() => [])])
      setCases(Array.isArray(allCases) ? allCases : [])
      setHospitals(Array.isArray(hospitalList) ? hospitalList : [])
    } catch (error) {
      pushToast({ title: 'Unable to load cases', description: error.message, tone: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    setActivePage(1)
  }, [appliedFilters])

  const hospitalsById = useMemo(() => buildHospitalMap(hospitals, cases), [cases, hospitals])
  const ambulancesById = useMemo(() => buildAmbulanceMap(cases), [cases])

  const ambulanceOptions = useMemo(() => {
    const list = Array.from(ambulancesById.values())
      .map((ambulance) => {
        const currentLocation = getAmbulanceLocation(ambulance)
        const activeCaseCount = Number(ambulance.activeCaseCount || 0)
        return {
          ...ambulance,
          currentLocation,
          activeCaseCount,
          loadLabel: `${activeCaseCount} active case${activeCaseCount === 1 ? '' : 's'}`,
        }
      })
      .filter((ambulance) => normalizeStatus(ambulance.status) === 'idle' || ambulance.activeCaseCount === 0)

    return list
  }, [ambulancesById])

  const enrichedCases = useMemo(() => {
    return cases.map((item) => {
      const caseLocation = parseCaseCoordinates(item)
      const recommendation = recommendAmbulance(item, ambulanceOptions)
      return {
        ...item,
        recommendation,
        caseLocation,
      }
    })
  }, [ambulanceOptions, cases])

  const filteredCases = useMemo(() => {
    const sortBy = appliedFilters.sortBy

    const filtered = enrichedCases.filter((item) => {
      if (appliedFilters.status !== 'All' && normalizeStatus(item.status) !== appliedFilters.status) return false
      if (appliedFilters.severity !== 'All' && normalizeSeverity(item.severity) !== appliedFilters.severity) return false
      if (appliedFilters.hospitalId !== 'All' && String(item.hospital_id ?? '') !== appliedFilters.hospitalId) return false
      return true
    })

    if (sortBy === 'severity') {
      return sortCasesByPriority(filtered)
    }

    return [...filtered].sort((left, right) => {
      if (sortBy === 'eta') {
        const leftEta = Number(left.eta)
        const rightEta = Number(right.eta)
        if (Number.isFinite(leftEta) && Number.isFinite(rightEta) && leftEta !== rightEta) return leftEta - rightEta
        if (Number.isFinite(leftEta)) return -1
        if (Number.isFinite(rightEta)) return 1
      }

      const leftCreated = left.created_at ? new Date(left.created_at).getTime() : 0
      const rightCreated = right.created_at ? new Date(right.created_at).getTime() : 0
      return rightCreated - leftCreated
    })
  }, [appliedFilters, enrichedCases])

  const totalPages = Math.max(1, Math.ceil(filteredCases.length / PAGE_SIZE))
  const pageCases = filteredCases.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE)

  const openModal = (caseItem) => {
    setSelectedCase(caseItem)
    setTargetHospitalId(String(caseItem?.hospital_id ?? ''))
    setTargetAmbulanceId(String(caseItem?.recommendation?.id ?? caseItem?.ambulance_id ?? ''))
    setReason('Resource shortage')
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setSelectedCase(null)
  }

  const handleConfirmReassignment = async () => {
    if (!selectedCase) return

    const caseId = getCaseId(selectedCase)
    const nextHospitalId = targetHospitalId ? Number(targetHospitalId) : null
    const nextAmbulanceId = targetAmbulanceId ? Number(targetAmbulanceId) : null

    if (!nextHospitalId && !nextAmbulanceId) return

    setSaving(true)
    try {
      const tasks = []
      if (nextHospitalId && String(nextHospitalId) !== String(selectedCase.hospital_id ?? '')) {
        tasks.push(changeHospital(caseId, nextHospitalId))
      }
      if (nextAmbulanceId && String(nextAmbulanceId) !== String(selectedCase.ambulance_id ?? '')) {
        tasks.push(changeAmbulance(caseId, nextAmbulanceId))
      }

      if (tasks.length === 0) {
        pushToast({ title: 'No changes to apply', description: 'The reassignment matches the current values.', tone: 'info' })
        return
      }

      await Promise.all(tasks)
      pushToast({
        title: 'Case reassigned',
        description: `Case ${caseId} updated with reason: ${reason}.`,
        tone: 'success',
      })
      await loadData()
      closeModal()
    } catch (error) {
      pushToast({ title: 'Reassignment failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Case Management</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Admin cases</h1>
            <p className="mt-1 text-sm text-slate-500">Filter, review, and reassign cases from a single operations view.</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => loadData()} disabled={loading || saving}>
            {loading ? 'Loading...' : 'Refresh cases'}
          </button>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-4">
          <FilterSelect label="Status" value={draftFilters.status} onChange={(value) => setDraftFilters((current) => ({ ...current, status: value }))} options={STATUS_OPTIONS} />
          <FilterSelect label="Severity" value={draftFilters.severity} onChange={(value) => setDraftFilters((current) => ({ ...current, severity: value }))} options={SEVERITY_OPTIONS} />
          <FilterSelect
            label="Hospital"
            value={draftFilters.hospitalId}
            onChange={(value) => setDraftFilters((current) => ({ ...current, hospitalId: value }))}
            options={['All', ...Array.from(hospitalsById.values()).map((hospital) => ({ label: hospital.name || `Hospital ${hospital.id}`, value: String(hospital.id) }))]}
          />
          <FilterSelect
            label="Sort by"
            value={draftFilters.sortBy}
            onChange={(value) => setDraftFilters((current) => ({ ...current, sortBy: value }))}
            options={SORT_OPTIONS}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">Showing {filteredCases.length} case{filteredCases.length === 1 ? '' : 's'}.</p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setAppliedFilters(draftFilters)
              setActivePage(1)
            }}
          >
            Apply
          </button>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Cases Table</p>
            <h2 className="mt-1 text-2xl font-black text-slate-900">Filterable case list</h2>
          </div>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-slate-600">
            20 per page
          </span>
        </div>

        <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200">
          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Hospital</th>
                  <th className="px-4 py-3">Ambulance</th>
                  <th className="px-4 py-3">ETA</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr>
                    <td colSpan="8" className="px-4 py-10 text-center text-slate-500">
                      Loading cases...
                    </td>
                  </tr>
                ) : pageCases.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="px-4 py-10 text-center text-slate-500">
                      No cases match the current filters.
                    </td>
                  </tr>
                ) : (
                  pageCases.map((item) => (
                    <tr
                      key={getCaseId(item)}
                      className="cursor-context-menu hover:bg-slate-50"
                      onContextMenu={(event) => {
                        event.preventDefault()
                        openModal(item)
                      }}
                    >
                      <td className="px-4 py-4 font-semibold text-slate-900">#{getCaseId(item)}</td>
                      <td className="px-4 py-4 text-slate-700">{getPatientName(item)}</td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${severityTone(item.severity)}`}>
                          {normalizeSeverity(item.severity)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${statusTone(item.status)}`}>
                          {safeString(item.status || 'triaged')}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-700">{getHospitalLabel(item, hospitalsById)}</td>
                      <td className="px-4 py-4 text-slate-700">{safeString(item.ambulance_id ?? item.ambulanceId)}</td>
                      <td className="px-4 py-4 text-slate-700">{formatEta(item.eta)}</td>
                      <td className="px-4 py-4">
                        <button type="button" className="btn-secondary" onClick={() => openModal(item)}>
                          Reassign
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">
            Page {activePage} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={activePage <= 1}
              onClick={() => setActivePage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={activePage >= totalPages}
              onClick={() => setActivePage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {modalOpen && selectedCase ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="presentation" onClick={closeModal}>
          <div
            className="w-full max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-soft"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reassignment-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Case Reassignment Modal</p>
                <h2 id="reassignment-title" className="mt-2 text-2xl font-black tracking-tight text-slate-900">
                  Case #{getCaseId(selectedCase)}
                </h2>
                <p className="mt-1 text-sm text-slate-500">Current hospital and ambulance assignment with reason tracking.</p>
              </div>
              <button type="button" onClick={closeModal} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-lg font-bold text-slate-500 hover:bg-slate-50 hover:text-slate-900">
                ×
              </button>
            </div>

            <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="p-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <InfoCard label="Patient" value={getPatientName(selectedCase)} />
                  <InfoCard label="Severity" value={<span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${severityTone(selectedCase.severity)}`}>{normalizeSeverity(selectedCase.severity)}</span>} />
                  <InfoCard label="Current Status" value={<span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${statusTone(selectedCase.status)}`}>{safeString(selectedCase.status || 'triaged')}</span>} />
                  <InfoCard label="ETA" value={formatEta(selectedCase.eta)} />
                  <InfoCard label="Current Hospital" value={getHospitalLabel(selectedCase, hospitalsById)} />
                  <InfoCard label="Current Ambulance" value={safeString(selectedCase.ambulance_id ?? selectedCase.ambulanceId)} />
                </div>

                <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Smart Recommendation</p>
                  <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
                    <p className="text-sm text-slate-500">Recommended Ambulance</p>
                    <p className="mt-1 text-lg font-black text-slate-900">
                      {selectedCase.recommendation ? `Ambulance ${selectedCase.recommendation.id}` : 'No free ambulances found'}
                    </p>
                    <p className="mt-2 text-sm text-slate-600">
                      {selectedCase.recommendation
                        ? [
                            selectedCase.recommendation.gridDistance != null ? `${selectedCase.recommendation.gridDistance} H3 cells away` : 'Distance unavailable',
                            selectedCase.recommendation.loadLabel,
                            `Status ${safeString(selectedCase.recommendation.status)}`,
                          ].join(' · ')
                        : 'The dropdown falls back to any available ambulance if the free fleet is empty.'}
                    </p>
                  </div>
                </div>
              </div>

              <aside className="border-t border-slate-200 bg-slate-50 p-6 lg:border-l lg:border-t-0">
                <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Change Hospital</label>
                    <select className="field mt-2" value={targetHospitalId} onChange={(event) => setTargetHospitalId(event.target.value)} disabled={saving}>
                      <option value="">Keep current</option>
                      {Array.from(hospitalsById.values()).map((hospital) => (
                        <option key={hospital.id} value={hospital.id}>
                          {hospital.name || `Hospital ${hospital.id}`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Change Ambulance</label>
                    <select className="field mt-2" value={targetAmbulanceId} onChange={(event) => setTargetAmbulanceId(event.target.value)} disabled={saving}>
                      <option value="">Keep current</option>
                      {ambulanceOptions.length > 0 ? (
                        ambulanceOptions.map((ambulance) => (
                          <option key={ambulance.id} value={ambulance.id}>
                            {String(ambulance.id) === String(selectedCase?.recommendation?.id) ? 'Recommended: ' : ''}Ambulance {ambulance.id} · {ambulance.loadLabel}
                          </option>
                        ))
                      ) : (
                        <option value="" disabled>
                          No free ambulances available
                        </option>
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Reason</label>
                    <select className="field mt-2" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving}>
                      {['Resource shortage', 'Better ETA', 'Specialty needed', 'Manual override'].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button type="button" className="btn-primary w-full" onClick={handleConfirmReassignment} disabled={saving}>
                    {saving ? 'Applying changes...' : 'Confirm reassignment'}
                  </button>
                </div>

                <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Audit note</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Reason selected: <span className="font-semibold text-slate-900">{reason}</span>. The current hospital and ambulance assignments are shown above for comparison.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="space-y-2">
      <span className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">{label}</span>
      <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          if (typeof option === 'string') {
            return (
              <option key={option} value={option}>
                {option}
              </option>
            )
          }
          return (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          )
        })}
      </select>
    </label>
  )
}

function InfoCard({ label, value }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">{label}</p>
      <div className="mt-2 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  )
}

export default CaseManagementPage