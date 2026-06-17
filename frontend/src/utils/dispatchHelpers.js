export function deriveHospitalsFromCases(cases) {
  const seen = new Map()

  for (const item of cases) {
    if (item.hospital_id == null) continue
    const key = String(item.hospital_id)
    if (!seen.has(key)) {
      seen.set(key, {
        id: item.hospital_id,
        name: `Hospital ${item.hospital_id}`,
        location: item.location || 'Assigned from active case',
      })
    }
  }

  return Array.from(seen.values())
}

export function deriveAmbulancesFromCases(cases) {
  const seen = new Map()

  for (const item of cases) {
    if (item.ambulance_id == null) continue
    const key = String(item.ambulance_id)
    if (!seen.has(key)) {
      seen.set(key, {
        id: item.ambulance_id,
        driver_name: `Ambulance ${item.ambulance_id}`,
        status: item.status || 'idle',
      })
    }
  }

  return Array.from(seen.values())
}

export function severityScore(severity) {
  const ranking = { P0: 0, P1: 1, P2: 2, P3: 3 }
  return ranking[String(severity || 'P3').toUpperCase()] ?? 3
}

export function sortCasesByPriority(cases) {
  return [...cases].sort((left, right) => {
    const severityDelta = severityScore(left.severity) - severityScore(right.severity)
    if (severityDelta !== 0) return severityDelta

    const leftCreated = left.created_at ? new Date(left.created_at).getTime() : 0
    const rightCreated = right.created_at ? new Date(right.created_at).getTime() : 0
    return rightCreated - leftCreated
  })
}

export function formatRelativeTime(value) {
  if (!value) return 'Now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Now'
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}