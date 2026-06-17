import axios from 'axios'
import { AUTH_STORAGE_KEY, useAuthStore } from '../store/authStore.js'
import { useUiStore } from '../store/uiStore.js'

const baseURL = import.meta.env.VITE_API_URL || ''

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 10000,   // P5.2: 10-second timeout so loading spinners never hang forever
  headers: {
    'Content-Type': 'application/json',
  },
})

// ── Auth token injection ─────────────────────────────────────────────────────
apiClient.interceptors.request.use((config) => {
  let token = useAuthStore.getState().token

  if (!token && typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        token = parsed?.token || null
      }
    } catch {
      token = null
    }
  }
  

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

// ── Global error handler ─────────────────────────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    let message =
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.response?.data?.error_message ||
      error.message ||
      'Request failed'

    // P5.2: Surface timeout and network-down errors clearly
    if (error.code === 'ECONNABORTED') {
      message = 'Request timed out. Backend may be unreachable.'
    } else if (!error.response) {
      message = 'Cannot reach backend. Check if the server is running.'
    }

    // Handle session/token expiry or unauthorized access
    if (error.response && error.response.status === 401) {
      useAuthStore.getState().clearSession()
    }

    useUiStore.getState().pushToast({
      title: 'API error',
      description: message,
      tone: 'error',
    })

    return Promise.reject(error)
  },
)

function unwrap(response) {
  return response.data
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function loginUser(payload) {
  return unwrap(await apiClient.post('/auth/login', payload))
}

export async function registerUser(payload) {
  return unwrap(await apiClient.post('/auth/register', payload))
}

export async function logoutUser() {
  return unwrap(await apiClient.post('/auth/logout'))
}

// ── Cases ────────────────────────────────────────────────────────────────────
export async function getAllCases() {
  return unwrap(await apiClient.get('/admin/get-all-cases'))
}

export async function getHospitalCases(hospitalId) {
  return unwrap(await apiClient.get(`/hospitals/get-cases/${hospitalId}`))
}

// P1.3 FIX: Correct endpoint — POST /cases/:id/status, not /emergency/dispatch
export async function updateCaseStatus(caseId, status) {
  return unwrap(await apiClient.post(`/cases/${caseId}/status`, { status }))
}

export async function updateHospitalCaseStatus(caseId, status) {
  return unwrap(await apiClient.post(`/hospitals/cases/${caseId}/status`, { status }))
}

// ── Hospital resources ───────────────────────────────────────────────────────
export async function getHospitalResources(hospitalId) {
  return unwrap(await apiClient.get(`/hospitals/resources/${hospitalId}`))
}

export async function updateHospitalResources(hospitalId, resourceType, quantityChange) {
  const legacyPayload = typeof resourceType === 'object' && resourceType !== null
  const payload = legacyPayload
    ? resourceType
    : {
        resource_type: resourceType,
        quantity_change: Number.parseInt(quantityChange, 10),
      }

  return unwrap(await apiClient.put(`/hospitals/resources/${hospitalId}`, payload))
}

export async function updateHospitalResourceStatus(hospitalId, payload) {
  return unwrap(await apiClient.post(`/hospitals/resources/${hospitalId}`, payload))
}

// ── Ambulances ───────────────────────────────────────────────────────────────
export async function getAmbulance(ambulanceId) {
  return unwrap(await apiClient.get(`/ambulances/${ambulanceId}`))
}

export async function getAssignedCases(ambulanceId) {
  return unwrap(await apiClient.get(`/ambulances/get-assigned-cases/${ambulanceId}`))
}

export async function updateAmbulanceStatus(ambulanceId, status) {
  return unwrap(await apiClient.post(`/ambulances/update-status/${ambulanceId}`, { status }))
}

export async function updateAmbulanceLocation(ambulanceId, currentLatitude, currentLongitude) {
  return unwrap(
    await apiClient.post(`/ambulances/update-location/${ambulanceId}`, {
      current_latitude: currentLatitude,
      current_longitude: currentLongitude,
    }),
  )
}

// ── Admin reassignment ───────────────────────────────────────────────────────
export async function changeHospital(caseId, hospitalId) {
  return unwrap(await apiClient.post(`/admin/change-hosp/${caseId}`, { hospital_id: hospitalId }))
}

export async function changeAmbulance(caseId, ambulanceId) {
  return unwrap(await apiClient.post(`/admin/change-ambulance/${caseId}`, { ambulance_id: ambulanceId }))
}

// ── Emergency dispatch ───────────────────────────────────────────────────────
export async function dispatchEmergency(payload) {
  return unwrap(await apiClient.post('/emergency/dispatch', payload, { timeout: 60000 }))
}

// ── Chat ─────────────────────────────────────────────────────────────────────
// P1.1 FIX: Standardized response shape.
// Backend contract: { success: bool, response: string, data: { tool_used, tool_args, results } }
export async function sendChatMessage(payload) {
  const raw = unwrap(await apiClient.post('/chat', payload, { timeout: 60000 }))
  // Normalise to a single predictable shape regardless of backend variance
  return {
    success: raw?.success ?? true,
    message: raw?.response ?? raw?.message ?? raw?.reply ?? raw?.data?.message ?? '',
    toolUsed: raw?.data?.tool_used ?? raw?.tool_used ?? null,
    toolArgs: raw?.data?.tool_args ?? raw?.tool_args ?? null,
    results: raw?.data?.results ?? raw?.results ?? null,
    reasoning: raw?.data?.reasoning ?? raw?.reasoning ?? null,
    // Keep the raw data blob for structured rendering in ChatAssistant
    data: raw?.data ?? null,
    raw,
  }
}

// ── Hospital & ambulance lists ───────────────────────────────────────────────
// P1.4 FIX: Try real backend endpoints first; fall back to deriving from cases.

function deriveHospitalsFromCases(cases) {
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

function deriveAmbulancesFromCases(cases) {
  const seen = new Map()
  for (const item of cases) {
    if (item.ambulance_id == null) continue
    const key = String(item.ambulance_id)
    if (!seen.has(key)) {
      seen.set(key, {
        id: item.ambulance_id,
        driver_name: `Ambulance ${item.ambulance_id}`,
        status: item.status || 'active',
      })
    }
  }
  return Array.from(seen.values())
}

export async function getHospitals() {
  try {
    // Try the real endpoint first
    const raw = unwrap(await apiClient.get('/hospitals'))
    const list = raw?.data ?? raw
    if (Array.isArray(list) && list.length > 0) return list
  } catch {
    // Endpoint not yet available — fall through to derivation
  }
  // Fallback: derive from cases
  const cases = await getAllCases().catch(() => [])
  return deriveHospitalsFromCases(Array.isArray(cases) ? cases : [])
}

export async function getAmbulances() {
  try {
    const raw = unwrap(await apiClient.get('/ambulances'))
    const list = raw?.data ?? raw
    if (Array.isArray(list) && list.length > 0) return list
  } catch {
    // Endpoint not yet available — fall through to derivation
  }
  const cases = await getAllCases().catch(() => [])
  return deriveAmbulancesFromCases(Array.isArray(cases) ? cases : [])
}

export default apiClient
