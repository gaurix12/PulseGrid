import { gridDistance, latLngToCell } from 'h3-js'

const SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
}

const STATUS_BUCKETS = ['created', 'triaged', 'dispatched', 'arrived', 'resolved', 'alerts_sent', 'discharged', 'failed_escalation']

export function normalizeCaseList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.cases)) return payload.cases
  return []
}

export function safeNumber(value, fallback = 0) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

export function parseCaseCoordinates(caseItem) {
  const rawLocation = String(caseItem?.location || '').trim()
  if (!rawLocation) return null

  const directLat = safeNumber(caseItem?.latitude, Number.NaN)
  const directLon = safeNumber(caseItem?.longitude, Number.NaN)
  if (Number.isFinite(directLat) && Number.isFinite(directLon)) {
    return { latitude: directLat, longitude: directLon }
  }

  const compact = rawLocation.replace(/\s+/g, '')
  const pairMatch = compact.match(/^([-+]?\d+(?:\.\d+)?)[,;|]([-+]?\d+(?:\.\d+)?)$/)
  if (pairMatch) {
    return {
      latitude: Number(pairMatch[1]),
      longitude: Number(pairMatch[2]),
    }
  }

  const latMatch = rawLocation.match(/lat(?:itude)?\s*[:=]?\s*([-+]?\d+(?:\.\d+)?)/i)
  const lonMatch = rawLocation.match(/lon(?:gitude)?\s*[:=]?\s*([-+]?\d+(?:\.\d+)?)/i)
  if (latMatch && lonMatch) {
    return {
      latitude: Number(latMatch[1]),
      longitude: Number(lonMatch[1]),
    }
  }

  return null
}

export function h3GridDistance(from, to) {
  if (!from || !to) return null

  const lat1 = safeNumber(from.latitude, Number.NaN)
  const lon1 = safeNumber(from.longitude, Number.NaN)
  const lat2 = safeNumber(to.latitude, Number.NaN)
  const lon2 = safeNumber(to.longitude, Number.NaN)
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null

  try {
    return gridDistance(latLngToCell(lat1, lon1, 9), latLngToCell(lat2, lon2, 9))
  } catch {
    return null
  }
}

export function formatTimeAgo(value) {
  if (!value) return 'No timestamp'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)

  const diffMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
  if (diffMinutes < 1) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  return date.toLocaleDateString()
}

export function getCaseAgeMinutes(caseItem) {
  if (!caseItem?.created_at) return null
  const date = new Date(caseItem.created_at)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
}

export function sortCasesByPriority(cases, origin = null) {
  return [...cases].sort((left, right) => {
    const severityDiff = (SEVERITY_RANK[left.severity] ?? 99) - (SEVERITY_RANK[right.severity] ?? 99)
    if (severityDiff !== 0) return severityDiff

    const leftDistance = origin ? h3GridDistance(origin, parseCaseCoordinates(left)) ?? Number.POSITIVE_INFINITY : 0
    const rightDistance = origin ? h3GridDistance(origin, parseCaseCoordinates(right)) ?? Number.POSITIVE_INFINITY : 0
    if (leftDistance !== rightDistance) return leftDistance - rightDistance

    const leftCreated = left.created_at ? new Date(left.created_at).getTime() : 0
    const rightCreated = right.created_at ? new Date(right.created_at).getTime() : 0
    return rightCreated - leftCreated
  })
}

export function groupCasesByStatus(cases) {
  return STATUS_BUCKETS.reduce((acc, status) => {
    acc[status] = cases.filter((item) => String(item.status || 'created') === status)
    return acc
  }, {})
}

export function summarizeCases(cases) {
  const critical = cases.filter((item) => ['P0', 'P1'].includes(item.severity))
  const delayed = cases.filter((item) => item.delay)
  const resolved = cases.filter((item) => ['resolved', 'discharged'].includes(String(item.status || '').toLowerCase()))
  const active = cases.filter((item) => !['discharged', 'failed_escalation'].includes(String(item.status || '').toLowerCase()))

  const etaValues = cases
    .map((item) => safeNumber(item.eta, Number.NaN))
    .filter(Number.isFinite)

  const ageValues = cases
    .map(getCaseAgeMinutes)
    .filter((value) => value !== null)

  const avgEta = etaValues.length
    ? Math.round(etaValues.reduce((sum, value) => sum + value, 0) / etaValues.length)
    : null

  const avgAge = ageValues.length
    ? Math.round(ageValues.reduce((sum, value) => sum + value, 0) / ageValues.length)
    : null

  return {
    total: cases.length,
    critical: critical.length,
    delayed: delayed.length,
    resolved: resolved.length,
    active: active.length,
    avgEta,
    avgAge,
  }
}

export function buildAuditTrail(cases) {
  return sortCasesByPriority(cases)
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      title: `Case ${item.id} ${String(item.status || 'created')}`,
      detail: `${item.severity || 'P2'} · ${item.patient_name || 'Unknown patient'} · ${item.hospital_id ? `Hospital ${item.hospital_id}` : 'Unassigned'}`,
      time: formatTimeAgo(item.created_at),
    }))
}

export function buildCaseQueue(cases, origin = null) {
  return sortCasesByPriority(cases, origin).map((item) => {
    const distance = origin ? h3GridDistance(origin, parseCaseCoordinates(item)) : null
    return {
      ...item,
      h3GridDistance: distance,
      ageMinutes: getCaseAgeMinutes(item),
    }
  })
}
