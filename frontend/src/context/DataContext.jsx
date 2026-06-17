/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import * as api from '../services/api.js'
import { POLLING } from '../constants/polling.js'
import { useAuthStore } from '../store/authStore.js'

const DataContext = createContext()

export function DataProvider({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [cases, setCases] = useState([])
  const [hospitals, setHospitals] = useState([])
  const [ambulances, setAmbulances] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Initial full fetch — only when authenticated ──────────────────────────
  useEffect(() => {
    if (!isAuthenticated) return

    fetchAllData()

    // P4.2: Selective refresh — only cases change frequently at the global level.
    const interval = setInterval(() => {
      refreshCases()
    }, POLLING.GLOBAL)

    return () => clearInterval(interval)
  }, [isAuthenticated])

  async function fetchAllData() {
    setLoading(true)
    setError(null)
    try {
      const [casesData, hospitalsData, ambulancesData] = await Promise.all([
        api.getAllCases().catch(() => []),
        api.getHospitals().catch(() => []),
        api.getAmbulances().catch(() => []),
      ])
      setCases(Array.isArray(casesData) ? casesData : [])
      setHospitals(Array.isArray(hospitalsData) ? hospitalsData : [])
      setAmbulances(Array.isArray(ambulancesData) ? ambulancesData : [])
    } catch (err) {
      setError(err.message)
      console.error('Failed to load initial data:', err)
    } finally {
      setLoading(false)
    }
  }

  // ── P4.2: Selective refresh functions ────────────────────────────────────
  async function refreshCases() {
    try {
      const data = await api.getAllCases()
      if (Array.isArray(data)) {
        setCases(data)
        setError(null)
      }
    } catch (err) {
      console.error('Failed to refresh cases:', err)
    }
  }

  async function refreshHospitals() {
    try {
      const data = await api.getHospitals()
      if (Array.isArray(data)) {
        setHospitals(data)
        setError(null)
      }
    } catch (err) {
      console.error('Failed to refresh hospitals:', err)
    }
  }

  async function refreshAmbulances() {
    try {
      const data = await api.getAmbulances()
      if (Array.isArray(data)) {
        setAmbulances(data)
        setError(null)
      }
    } catch (err) {
      console.error('Failed to refresh ambulances:', err)
    }
  }

  // ── Derived fallbacks if real endpoints haven't returned data yet ─────────
  const derivedHospitals = useMemo(() => {
    if (hospitals.length > 0) return hospitals
    const map = new Map()
    cases.forEach((item) => {
      if (!item.hospital_id) return
      const key = String(item.hospital_id)
      if (!map.has(key)) {
        map.set(key, {
          id: item.hospital_id,
          name: `Hospital ${item.hospital_id}`,
          location: item.location || 'Unknown location',
        })
      }
    })
    return Array.from(map.values())
  }, [cases, hospitals])

  const derivedAmbulances = useMemo(() => {
    if (ambulances.length > 0) return ambulances
    const map = new Map()
    cases.forEach((item) => {
      if (!item.ambulance_id) return
      const key = String(item.ambulance_id)
      if (!map.has(key)) {
        map.set(key, {
          id: item.ambulance_id,
          status: item.status || 'active',
        })
      }
    })
    return Array.from(map.values())
  }, [cases, ambulances])

  const value = {
    cases,
    hospitals: derivedHospitals,
    ambulances: derivedAmbulances,
    loading,
    error,
    fetchAllData,
    refreshCases,
    refreshHospitals,
    refreshAmbulances,
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const context = useContext(DataContext)
  if (!context) {
    throw new Error('useData must be used within DataProvider')
  }
  return context
}

export default DataContext
