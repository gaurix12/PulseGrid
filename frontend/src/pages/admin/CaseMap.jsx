import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { changeAmbulance, changeHospital, getAllCases, getHospitals } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { h3GridDistance, parseCaseCoordinates, sortCasesByPriority } from '../../utils/incidentInsights.js'

const CHENNAI_CENTER = [13.0827, 80.2707]
const REFRESH_MS = 3000
const ACTIVE_STATUSES = new Set(['created', 'triaged', 'dispatched', 'en-route', 'arrived'])
const TERMINAL_STATUSES = new Set(['resolved', 'discharged', 'failed', 'failed_escalation'])
const SEVERITIES = ['P0', 'P1', 'P2', 'P3']
const REASSIGN_REASONS = ['Resource shortage', 'Better ETA', 'Specialty needed', 'Manual override']

function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function normalizeSeverity(value) {
  const severity = safeString(value).toUpperCase()
  return SEVERITIES.includes(severity) ? severity : 'P3'
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

function formatLocation(point) {
  if (!point) return 'Unavailable'
  return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`
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
    case 'failed_escalation':
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

function getCaseStatus(item) {
  return safeString(item?.status || item?.case_status || 'triaged')
}

function getAssignedHospital(item, hospitalsById) {
  const hospitalId = item?.hospital_id ?? item?.hospitalId
  if (hospitalId == null) return 'Unassigned'
  return hospitalsById.get(String(hospitalId))?.name || `Hospital ${hospitalId}`
}

function getCaseCoordinates(item) {
  const direct = parseCaseCoordinates(item)
  if (direct) return direct

  const latitude = Number(item?.latitude ?? item?.lat)
  const longitude = Number(item?.longitude ?? item?.lon)
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { latitude, longitude }
  }

  return null
}

function getStatusRadius(status, severity) {
  const base = { P0: 14, P1: 12, P2: 10, P3: 8 }[normalizeSeverity(severity)] ?? 8
  switch (normalizeStatus(status)) {
    case 'arrived':
      return base + 2
    case 'dispatched':
    case 'en-route':
      return base + 1
    default:
      return base
  }
}

function getCaseColor(severity) {
  switch (normalizeSeverity(severity)) {
    case 'P0':
      return '#ef4444'
    case 'P1':
      return '#f97316'
    case 'P2':
      return '#eab308'
    default:
      return '#22c55e'
  }
}

function getAmbulanceStateFromCases(groupedCases) {
  const sorted = [...groupedCases].sort((left, right) => {
    const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0
    const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0
    return rightTime - leftTime
  })

  const activeCases = groupedCases.filter((item) => ACTIVE_STATUSES.has(normalizeStatus(item.status)))
  const latestActiveCase = activeCases[0] || null
  const latestCase = sorted[0] || null
  const sourceCase = latestActiveCase || latestCase

  return {
    id: sourceCase?.ambulance_id,
    driverName: sourceCase?.ambulance?.driver_name || sourceCase?.ambulance_driver_name || sourceCase?.ambulance?.driverName || `Ambulance ${sourceCase?.ambulance_id}`,
    activeCaseCount: activeCases.length,
    latestCase,
    location: getCaseCoordinates(sourceCase),
    status:
      activeCases.length === 0
        ? 'idle'
        : normalizeSeverity(sourceCase?.severity) === 'P0' || normalizeSeverity(sourceCase?.severity) === 'P1'
          ? 'critical'
          : normalizeStatus(sourceCase?.status),
  }
}

function buildHospitalsById(hospitals, cases) {
  const map = new Map()

  for (const hospital of hospitals || []) {
    map.set(String(hospital.id), {
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

function buildAmbulanceInventory(cases) {
  const grouped = new Map()

  for (const item of cases || []) {
    if (item.ambulance_id == null) continue
    const key = String(item.ambulance_id)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(item)
  }

  return Array.from(grouped.entries()).map(([key, groupedCases]) => {
    const ambulance = getAmbulanceStateFromCases(groupedCases)
    const latest = ambulance.latestCase || groupedCases[0]
    return {
      id: key,
      ...ambulance,
      loadCount: ambulance.activeCaseCount,
      latestSeverity: latest?.severity || 'P3',
      distanceScore: null,
    }
  })
}

function recommendAmbulance(caseItem, ambulances) {
  const caseLocation = getCaseCoordinates(caseItem)
  const scored = ambulances.map((ambulance) => {
    const location = ambulance.location
    const gridDistance = caseLocation && location ? h3GridDistance(caseLocation, location) : null
    const idleScore = ambulance.status === 'idle' ? 0 : 1
    const loadScore = Number(ambulance.loadCount || 0)

    return {
      ...ambulance,
      gridDistance,
      idleScore,
      loadScore,
    }
  })

  scored.sort((left, right) => {
    if (left.idleScore !== right.idleScore) return left.idleScore - right.idleScore
    if ((left.gridDistance ?? Number.POSITIVE_INFINITY) !== (right.gridDistance ?? Number.POSITIVE_INFINITY)) {
      return (left.gridDistance ?? Number.POSITIVE_INFINITY) - (right.gridDistance ?? Number.POSITIVE_INFINITY)
    }
    if (left.loadScore !== right.loadScore) return left.loadScore - right.loadScore
    return Number(left.id) - Number(right.id)
  })

  return scored[0] || null
}

function createAmbulanceIcon(state) {
  const color = state === 'idle' ? '#22c55e' : state === 'critical' ? '#ef4444' : '#2563eb'
  return L.divIcon({
    className: 'admin-map-ambulance-icon',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
    html: `
      <div style="
        width:28px;height:28px;display:grid;place-items:center;
        transform: translateZ(0);
        filter: drop-shadow(0 10px 16px rgba(15,23,42,.2));
        transition: transform .2s ease, filter .2s ease;
      ">
        <div style="
          width:0;height:0;
          border-left:11px solid transparent;
          border-right:11px solid transparent;
          border-bottom:20px solid ${color};
          position:relative;
        ">
          <div style="
            position:absolute;left:-4px;top:7px;width:8px;height:8px;border-radius:999px;
            background:rgba(255,255,255,.95);
          "></div>
        </div>
      </div>
    `,
  })
}

function CaseMap() {
  const pushToast = useUiStore((state) => state.pushToast)
  const [cases, setCases] = useState([])
  const [hospitals, setHospitals] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [visibleSeverities, setVisibleSeverities] = useState(() => new Set(SEVERITIES))
  const [showAmbulances, setShowAmbulances] = useState(true)
  const [selectedCase, setSelectedCase] = useState(null)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hospitalId, setHospitalId] = useState('')
  const [ambulanceId, setAmbulanceId] = useState('')
  const [reason, setReason] = useState(REASSIGN_REASONS[0])

  const loadData = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const [allCases, hospitalList] = await Promise.all([getAllCases(), getHospitals().catch(() => [])])
      const normalizedCases = Array.isArray(allCases) ? allCases : []
      setCases(normalizedCases)
      setHospitals(Array.isArray(hospitalList) ? hospitalList : [])
    } catch (error) {
      pushToast({ title: 'Unable to load map', description: error.message, tone: 'error' })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
    const intervalId = window.setInterval(() => {
      loadData({ silent: true })
    }, REFRESH_MS)

    return () => window.clearInterval(intervalId)
  }, [])

  const hospitalsById = useMemo(() => buildHospitalsById(hospitals, cases), [cases, hospitals])

  const activeCases = useMemo(() => {
    return cases.filter((item) => !TERMINAL_STATUSES.has(normalizeStatus(item.status)))
  }, [cases])

  const visibleCases = useMemo(() => {
    return sortCasesByPriority(activeCases).filter((item) => visibleSeverities.has(normalizeSeverity(item.severity)))
  }, [activeCases, visibleSeverities])

  const ambulanceMarkers = useMemo(() => {
    const inventory = buildAmbulanceInventory(cases)
    return inventory.map((ambulance) => {
      const recommendationColor = ambulance.status === 'idle' ? 'idle' : ambulance.status === 'critical' ? 'critical' : 'transit'
      const loadLabel = ambulance.loadCount > 0 ? `${ambulance.loadCount} active case${ambulance.loadCount === 1 ? '' : 's'}` : 'Idle'
      const displayLocation = ambulance.location || getCaseCoordinates(ambulance.latestCase)
      const referenceCase = ambulance.latestCase || null
      const caseDistance = referenceCase && displayLocation ? h3GridDistance(getCaseCoordinates(referenceCase), displayLocation) : null

      return {
        ...ambulance,
        recommendationColor,
        loadLabel,
        displayLocation,
        caseDistance,
        recommended: false,
      }
    })
  }, [cases])

  const freeAmbulanceOptions = useMemo(() => ambulanceMarkers.filter((item) => item.status === 'idle'), [ambulanceMarkers])
  const ambulanceDropdownOptions = freeAmbulanceOptions.length > 0 ? freeAmbulanceOptions : ambulanceMarkers

  const recommendedAmbulanceByCaseId = useMemo(() => {
    const inventory = ambulanceMarkers
    const result = new Map()
    for (const item of visibleCases) {
      const recommended = recommendAmbulance(item, inventory.filter((ambulance) => ambulance.status === 'idle')) || recommendAmbulance(item, inventory)
      if (recommended) result.set(String(getCaseId(item)), recommended)
    }
    return result
  }, [ambulanceMarkers, visibleCases])

  const ambulanceLookup = useMemo(() => {
    const map = new Map()
    for (const ambulance of ambulanceMarkers) {
      map.set(String(ambulance.id), ambulance)
    }
    return map
  }, [ambulanceMarkers])

  const activeCaseCount = visibleCases.length

  const severitySummary = useMemo(() => {
    return SEVERITIES.reduce((accumulator, severity) => {
      accumulator[severity] = activeCases.filter((item) => normalizeSeverity(item.severity) === severity).length
      return accumulator
    }, {})
  }, [activeCases])

  const openReassign = (caseItem) => {
    setSelectedCase(caseItem)
    setHospitalId(String(caseItem?.hospital_id ?? ''))
    const recommendation = recommendedAmbulanceByCaseId.get(String(getCaseId(caseItem)))
    setAmbulanceId(String(recommendation?.id ?? caseItem?.ambulance_id ?? ''))
    setReason(REASSIGN_REASONS[0])
    setReassignOpen(true)
  }

  const closeReassign = () => {
    setReassignOpen(false)
    setSelectedCase(null)
  }

  const handleConfirmReassign = async () => {
    if (!selectedCase) return
    const caseId = getCaseId(selectedCase)
    const nextHospitalId = hospitalId ? Number(hospitalId) : null
    const nextAmbulanceId = ambulanceId ? Number(ambulanceId) : null
    const tasks = []

    if (nextHospitalId && String(nextHospitalId) !== String(selectedCase.hospital_id ?? '')) {
      tasks.push(changeHospital(caseId, nextHospitalId))
    }
    if (nextAmbulanceId && String(nextAmbulanceId) !== String(selectedCase.ambulance_id ?? '')) {
      tasks.push(changeAmbulance(caseId, nextAmbulanceId))
    }

    if (tasks.length === 0) {
      pushToast({ title: 'No changes selected', description: 'The reassignment matches the current case assignment.', tone: 'info' })
      return
    }

    setSaving(true)
    try {
      await Promise.all(tasks)
      pushToast({ title: 'Case reassigned', description: `Case ${caseId} updated for ${reason}.`, tone: 'success' })
      await loadData()
      closeReassign()
    } catch (error) {
      pushToast({ title: 'Reassignment failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Admin Map</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-900">Real-time case map</h1>
            <p className="mt-1 text-sm text-slate-500">Active cases only. Live refresh every 3 seconds.</p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            {activeCaseCount} cases
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {SEVERITIES.map((severity) => {
            const active = visibleSeverities.has(severity)
            return (
              <button
                key={severity}
                type="button"
                className={`rounded-full border px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] transition ${active ? severityTone(severity) : 'border-slate-200 bg-white text-slate-500'}`}
                onClick={() => {
                  setVisibleSeverities((current) => {
                    const next = new Set(current)
                    if (next.has(severity)) next.delete(severity)
                    else next.add(severity)
                    return next
                  })
                }}
              >
                {severity}
              </button>
            )
          })}

          <button
            type="button"
            className="btn-secondary"
            onClick={() => setVisibleSeverities(new Set(SEVERITIES))}
          >
            Reset filters
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowAmbulances((current) => !current)}
          >
            {showAmbulances ? 'Hide ambulances' : 'Show ambulances'}
          </button>

          <button type="button" className="btn-secondary" onClick={() => loadData()} disabled={loading || refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </section>

      <section className="relative overflow-hidden rounded-[2rem] border border-slate-200 bg-slate-950 shadow-soft">
        <div className="absolute left-4 right-4 top-4 z-[500] flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-white/10 bg-slate-950/75 px-4 py-3 text-white backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-200">
            <span className="rounded-full border border-white/10 px-3 py-1">P0 red</span>
            <span className="rounded-full border border-white/10 px-3 py-1">P1 orange</span>
            <span className="rounded-full border border-white/10 px-3 py-1">P2 yellow</span>
            <span className="rounded-full border border-white/10 px-3 py-1">P3 green</span>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> Idle
            <span className="h-2.5 w-2.5 rounded-full bg-sky-400" /> In transit
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" /> Critical
          </div>
        </div>

        <div className="h-[calc(100vh-11rem)] min-h-[680px] w-full">
          <MapContainer center={CHENNAI_CENTER} zoom={12} scrollWheelZoom className="h-full w-full">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {visibleCases.map((item) => {
              const coordinates = getCaseCoordinates(item) || { latitude: CHENNAI_CENTER[0], longitude: CHENNAI_CENTER[1] }
              const severity = normalizeSeverity(item.severity)
              const status = getCaseStatus(item)
              const radius = getStatusRadius(status, severity)
              const ambulance = item.ambulance_id != null ? ambulanceLookup.get(String(item.ambulance_id)) : null

              return (
                <CircleMarker
                  key={getCaseId(item)}
                  center={[coordinates.latitude, coordinates.longitude]}
                  radius={radius}
                  className="admin-map-case-marker"
                  pathOptions={{
                    color: getCaseColor(severity),
                    fillColor: getCaseColor(severity),
                    fillOpacity: 0.9,
                    weight: 2,
                  }}
                  eventHandlers={{
                    click: () => {
                      setSelectedCase(item)
                    },
                    contextmenu: (event) => {
                      event.originalEvent.preventDefault()
                      openReassign(item)
                    },
                  }}
                >
                  <Popup className="case-map-popup" maxWidth={320}>
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-400">Case ID</p>
                          <h3 className="mt-1 text-lg font-black text-slate-900">#{getCaseId(item)}</h3>
                        </div>
                        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${severityTone(severity)}`}>
                          {severity}
                        </span>
                      </div>

                      <div className="space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-900">Patient:</span> {getPatientName(item)}</p>
                        <p><span className="font-semibold text-slate-900">Condition:</span> {safeString(item.condition)}</p>
                        <p><span className="font-semibold text-slate-900">Status:</span> {safeString(status)}</p>
                        <p><span className="font-semibold text-slate-900">Assigned Hospital:</span> {getAssignedHospital(item, hospitalsById)}</p>
                        <p><span className="font-semibold text-slate-900">ETA:</span> {safeString(item.eta)} min</p>
                        <p><span className="font-semibold text-slate-900">Location:</span> {formatLocation(coordinates)}</p>
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Assigned Ambulance</p>
                        {ambulance ? (
                          <div className="mt-2 space-y-1 text-slate-700">
                            <p className="font-semibold text-slate-900">{ambulance.driverName}</p>
                            <p>Status: {safeString(ambulance.status)}</p>
                            <p>Current location: {formatLocation(ambulance.location)}</p>
                          </div>
                        ) : (
                          <p className="mt-2 text-slate-500">Pending</p>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="btn-primary" onClick={() => openReassign(item)}>
                          Reassign Case
                        </button>
                        <span className={`inline-flex items-center rounded-full border px-3 py-2 text-xs font-bold ${statusTone(status)}`}>
                          {safeString(status)}
                        </span>
                      </div>

                      <p className="border-t border-slate-200 pt-2 text-xs text-slate-400">Updated {formatDateTime(item.updated_at || item.created_at)}</p>
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}

            {showAmbulances
              ? ambulanceMarkers.map((ambulance) => {
                  if (!ambulance.location) return null
                  return (
                    <Marker
                      key={`ambulance-${ambulance.id}`}
                      position={[ambulance.location.latitude, ambulance.location.longitude]}
                      icon={createAmbulanceIcon(ambulance.recommendationColor)}
                    >
                      <Tooltip direction="top" offset={[0, -12]} opacity={1} permanent={false}>
                        <div className="space-y-1 text-xs font-semibold text-slate-900">
                          <div>{ambulance.driverName}</div>
                          <div className="font-normal text-slate-600">{safeString(ambulance.status)}</div>
                        </div>
                      </Tooltip>
                    </Marker>
                  )
                })
              : null}
          </MapContainer>
        </div>

        <div className="absolute bottom-4 left-4 z-[500] w-[min(420px,calc(100%-2rem))] rounded-3xl border border-white/10 bg-slate-950/80 p-4 text-white backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-200">
            <span className="rounded-full border border-white/10 px-3 py-1">Interactive map</span>
            <span className="rounded-full border border-white/10 px-3 py-1">OSM tiles</span>
            <span className="rounded-full border border-white/10 px-3 py-1">Chennai center</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Markers update every 3 seconds. Use the severity toggles to focus on critical incidents and right-click a case marker to open reassignment.
          </p>
        </div>
      </section>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-500 shadow-soft">Loading live map...</div>
      ) : null}

      {reassignOpen && selectedCase ? (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="presentation" onClick={closeReassign}>
          <div className="w-full max-w-4xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-soft" role="dialog" aria-modal="true" aria-labelledby="case-map-reassign-title" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Case Reassignment Modal</p>
                <h2 id="case-map-reassign-title" className="mt-2 text-2xl font-black tracking-tight text-slate-900">
                  Case #{getCaseId(selectedCase)}
                </h2>
                <p className="mt-1 text-sm text-slate-500">Change the hospital or ambulance from the live map.</p>
              </div>
              <button type="button" onClick={closeReassign} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-lg font-bold text-slate-500 hover:bg-slate-50 hover:text-slate-900">
                ×
              </button>
            </div>

            <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="p-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <InfoCard label="Patient" value={getPatientName(selectedCase)} />
                  <InfoCard label="Severity" value={<span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${severityTone(selectedCase.severity)}`}>{normalizeSeverity(selectedCase.severity)}</span>} />
                  <InfoCard label="Current Status" value={<span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${statusTone(selectedCase.status)}`}>{safeString(selectedCase.status || 'triaged')}</span>} />
                  <InfoCard label="ETA" value={safeString(selectedCase.eta)} />
                  <InfoCard label="Assigned Hospital" value={getAssignedHospital(selectedCase, hospitalsById)} />
                  <InfoCard label="Assigned Ambulance" value={safeString(selectedCase.ambulance_id ?? selectedCase.ambulanceId)} />
                </div>

                <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Smart Recommendation</p>
                  <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
                    <p className="text-sm text-slate-500">Recommended Ambulance</p>
                    <p className="mt-1 text-lg font-black text-slate-900">
                      {recommendedAmbulanceByCaseId.get(String(getCaseId(selectedCase))) ? `Ambulance ${recommendedAmbulanceByCaseId.get(String(getCaseId(selectedCase))).id}` : 'No recommendation available'}
                    </p>
                    <p className="mt-2 text-sm text-slate-600">
                      Closest available idle ambulance, then lowest load, then latest matching location.
                    </p>
                  </div>
                </div>
              </div>

              <aside className="border-t border-slate-200 bg-slate-50 p-6 lg:border-l lg:border-t-0">
                <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Change Hospital</label>
                    <select className="field mt-2" value={hospitalId} onChange={(event) => setHospitalId(event.target.value)} disabled={saving}>
                      <option value="">Keep current</option>
                      {Array.from(hospitalsById.values()).map((hospital) => (
                        <option key={hospital.id} value={hospital.id}>
                          {hospital.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Change Ambulance</label>
                    <select className="field mt-2" value={ambulanceId} onChange={(event) => setAmbulanceId(event.target.value)} disabled={saving}>
                      <option value="">Keep current</option>
                      {ambulanceDropdownOptions.map((ambulance) => (
                        <option key={ambulance.id} value={ambulance.id}>
                          {String(ambulance.id) === String(recommendedAmbulanceByCaseId.get(String(getCaseId(selectedCase)))?.id) ? 'Recommended: ' : ''}
                          Ambulance {ambulance.id} · {ambulance.loadLabel}
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-xs text-slate-500">
                      {freeAmbulanceOptions.length > 0
                        ? 'Free ambulances only.'
                        : 'No idle ambulances are available, so the list falls back to all tracked ambulances.'}
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Reason</label>
                    <select className="field mt-2" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving}>
                      {REASSIGN_REASONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button type="button" className="btn-primary w-full" onClick={handleConfirmReassign} disabled={saving}>
                    {saving ? 'Applying changes...' : 'Confirm reassignment'}
                  </button>
                </div>

                <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Audit note</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Reason selected: <span className="font-semibold text-slate-900">{reason}</span>. The assignment updates are written through the admin reassignment endpoints.
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

function InfoCard({ label, value }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">{label}</p>
      <div className="mt-2 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  )
}

export default CaseMap