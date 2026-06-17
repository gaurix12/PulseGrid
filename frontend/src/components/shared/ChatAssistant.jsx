import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useAuth } from '../../context/AuthContext.jsx'
import { useData } from '../../context/DataContext.jsx'
import * as api from '../../services/api.js'
import { executeChatAction, isMutatingTool } from '../../services/chatActions.js'
import { useUiStore } from '../../store/uiStore.js'
import { CHAT_CONFIG } from '../../constants/chatConfig.js'

// Helper to format timestamps
function getTimestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Role-aware suggestion prompts
const SUGGESTIONS_BY_ROLE = {
  hospital: [
    { label: 'General Availability', text: 'How many beds are available?' },
    { label: 'Check ICU Beds', text: 'How many ICU beds available?' },
    { label: 'Show Critical Cases', text: 'Show me all P0 cases' },
    { label: 'Increase Beds by 5', text: 'Update beds by +5' }
  ],
  admin: [
    { label: 'System Check', text: 'Which hospitals are overloaded?' },
    { label: 'Case Lookup', text: 'Show all cases today' },
    { label: 'Dispatch Reassignment', text: 'Reassign case 1 to hospital 2' },
    { label: 'Recommend Ambulance', text: 'Recommend ambulance for case 1' }
  ],
  ambulance: [
    { label: 'Nearest Incident', text: 'What is the nearest case?' },
    { label: 'My Status', text: 'Show case details' },
    { label: 'Arrived on Scene', text: 'Update status to arrived' },
    { label: 'Idle Fleet Check', text: 'Which ambulances are idle?' }
  ]
}

export default function ChatAssistant({ caseId }) {
  const { currentUser, role } = useAuth()
  const { cases, hospitals, ambulances, refreshCases, refreshHospitals, refreshAmbulances } = useData()
  const pushToast = useUiStore((state) => state.pushToast)

  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const feedEndRef = useRef(null)

  const userRole = role || 'guest'
  const config = CHAT_CONFIG[userRole] || CHAT_CONFIG.guest

  // Override suggestion chips from chatConfig
  const suggestions = config.examples || []

  // Retrieve storage key per role/user
  const localStorageKey = `pulsepath-chat-history-${userRole}-${currentUser?.id || 'guest'}`

  // Load chat history from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(localStorageKey)
      if (saved) {
        setMessages(JSON.parse(saved))
      } else {
        // Initial greetings
        const initialText = {
          hospital: 'Welcome to the Hospital Operations AI assistant. You can query cases, check capacity, or request resource changes.',
          admin: 'Welcome to the City Dispatch Command AI. You can query hospital capacity, locate ambulances, and manage dispatches.',
          ambulance: 'Welcome to the Ambulance Dispatch AI. You can check assigned cases, query nearby routes, or update status.'
        }
        setMessages([
          {
            id: 'init',
            role: 'assistant',
            text: initialText[userRole] || 'Hello! How can I assist you with emergency dispatch today?',
            timestamp: getTimestamp()
          }
        ])
      }
    } catch (e) {
      console.error('Failed to load chat history:', e)
    }
  }, [userRole, currentUser?.id])

  // Save chat history to localStorage when messages change
  const saveMessages = (updatedMessages) => {
    setMessages(updatedMessages)
    try {
      localStorage.setItem(localStorageKey, JSON.stringify(updatedMessages.slice(-20)))
    } catch (e) {
      console.error('Failed to save chat history:', e)
    }
  }

  // Auto-scroll to latest message
  useEffect(() => {
    if (isOpen) {
      feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen, isLoading])

  // Keyboard accessibility: Press Esc to close chat
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Send message handler
  const handleSend = async (textToSend) => {
    const text = textToSend || input.trim()
    if (!text) return

    if (!textToSend) setInput('')

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      timestamp: getTimestamp()
    }

    const nextMessages = [...messages, userMsg]
    saveMessages(nextMessages)
    setIsLoading(true)

    try {
      // P2.2 – Rich context payload
      const payload = {
        message: text,
        user_id: currentUser?.id || currentUser?.userId,
        user_role: userRole,
        case_id: caseId || undefined,
        hospital_id: currentUser?.hospital_id || currentUser?.hospitalId,
        ambulance_id: currentUser?.ambulance_id || currentUser?.ambulanceId,
        context: {
          current_hospital_id: currentUser?.hospital_id || currentUser?.hospitalId,
          current_ambulance_id: currentUser?.ambulance_id || currentUser?.ambulanceId,
          available_case_ids: cases.map((c) => c.id),
          available_hospital_ids: hospitals.map((h) => h.id),
          available_ambulance_ids: ambulances.map((a) => a.id),
        },
      }

      // P1.1 – Standardised response shape
      const response = await api.sendChatMessage(payload)

      const assistantMsg = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: response.message || 'Request processed.',
        timestamp: getTimestamp(),
        data: response.toolUsed
          ? { toolUsed: response.toolUsed, results: response.results }
          : null,
        error: response.success === false
          ? (response.raw?.error || 'Execution failed')
          : null
      }

      saveMessages([...nextMessages, assistantMsg])

      // P2.3 – Execute mutating actions
      if (isMutatingTool(response.toolUsed)) {
        try {
          await executeChatAction(response.toolUsed, response.toolArgs, userRole)
          pushToast({ title: 'Action applied', description: `Tool '${response.toolUsed}' executed.`, tone: 'success' })
          refreshCases()
          refreshHospitals()
          refreshAmbulances()
        } catch (actionErr) {
          pushToast({ title: 'Action failed', description: actionErr.message, tone: 'error' })
        }
      }
    } catch (err) {
      const errorMsg = {
        id: `error-${Date.now()}`,
        role: 'system',
        text: 'Failed to communicate with chat server.',
        timestamp: getTimestamp(),
        error: err.message || 'Network error'
      }
      saveMessages([...nextMessages, errorMsg])
    } finally {
      setIsLoading(false)
    }
  }

  // Clear chat history
  const handleClear = () => {
    if (window.confirm('Are you sure you want to reset history?')) {
      const resetMsg = [
        {
          id: `init-${Date.now()}`,
          role: 'assistant',
          text: 'Chat history cleared. How can I help you?',
          timestamp: getTimestamp()
        }
      ]
      saveMessages(resetMsg)
    }
  }

  // Trigger follow up database actions from structured cards
  const executeAction = async (actionType, params) => {
    try {
      setIsLoading(true)
      let responseMessage = ''

      if (actionType === 'assign_hospital') {
        const res = await api.changeHospital(params.caseId, params.hospitalId)
        responseMessage = res.message || `Case #${params.caseId} assigned to hospital ${params.hospitalId} successfully.`
      } else if (actionType === 'assign_ambulance') {
        const res = await api.changeAmbulance(params.caseId, params.ambulanceId)
        responseMessage = res.message || `Case #${params.caseId} assigned to ambulance ${params.ambulanceId} successfully.`
      } else if (actionType === 'update_ambulance_status') {
        const res = await api.updateAmbulanceStatus(params.ambulanceId, params.status)
        responseMessage = res.message || `Ambulance #${params.ambulanceId} status set to ${params.status}.`
      } else if (actionType === 'update_resources') {
        const res = await api.updateHospitalResources(params.hospitalId, params.resourceType, params.quantityChange)
        responseMessage = res.message || `Resources updated: ${params.resourceType} changed by ${params.quantityChange}.`
      }

      pushToast({ title: 'Action complete', description: responseMessage, tone: 'success' })

      // Add a system log inside chat
      const systemMsg = {
        id: `system-${Date.now()}`,
        role: 'system',
        text: `Action successful: ${responseMessage}`,
        timestamp: getTimestamp()
      }
      saveMessages([...messages, systemMsg])
    } catch (err) {
      pushToast({ title: 'Action failed', description: err.message, tone: 'error' })
    } finally {
      setIsLoading(false)
    }
  }

  // Custom data card renderers
  const renderStructuredData = (data) => {
    if (!data) return null
    const { toolUsed, results } = data

    // Check if the results were unsuccessful
    if (results?.success === false || results?.error) {
      return (
        <div className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <strong>Error in tool:</strong> {results?.error || 'Failed to complete execution.'}
        </div>
      )
    }

    const payloadData = results?.data || results

    switch (toolUsed) {
      // 1. HOSPITAL DATA & RESOURCE SNAPSHOTS
      case 'fetch_hospital_data':
      case 'fetch_resource_snapshot': {
        const isArray = Array.isArray(payloadData)
        const items = isArray ? payloadData : [payloadData].filter(Boolean)

        if (items.length === 0) {
          return <p className="mt-2 text-xs italic text-slate-500">No hospitals found.</p>
        }

        return (
          <div className="mt-2 space-y-2.5">
            {items.map((hosp) => {
              const bedsAvail = hosp.beds_available ?? hosp.bedsAvail ?? 0
              const bedsTot = hosp.beds_total ?? hosp.bedsTotal ?? 0
              const icuAvail = hosp.icu_available ?? hosp.icuAvail ?? 0
              const icuTot = hosp.icu_total ?? hosp.icuTotal ?? 0
              const ventAvail = hosp.ventilators_available ?? hosp.ventilatorsAvail ?? 0
              const ventTot = hosp.ventilators_total ?? hosp.ventilatorsTotal ?? 0

              const utilization = hosp.utilization || {
                beds: bedsTot ? Math.round(((bedsTot - bedsAvail) / bedsTot) * 100) : 0,
                icu: icuTot ? Math.round(((icuTot - icuAvail) / icuTot) * 100) : 0,
                ventilators: ventTot ? Math.round(((ventTot - ventAvail) / ventTot) * 100) : 0
              }

              return (
                <div key={hosp.hospital_id || hosp.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm text-xs">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 font-bold text-slate-900">
                    <span>{hosp.hospital || hosp.name || `Hospital #${hosp.id}`}</span>
                    <span className="text-[10px] text-slate-400">ID: {hosp.hospital_id || hosp.id}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div className="text-center">
                      <p className="text-[10px] uppercase font-bold text-slate-500">Beds</p>
                      <p className="font-extrabold text-slate-900">{bedsAvail}/{bedsTot}</p>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-sky-500 rounded-full" style={{ width: `${Math.min(100, utilization.beds || 0)}%` }} />
                      </div>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] uppercase font-bold text-slate-500">ICU</p>
                      <p className="font-extrabold text-slate-900">{icuAvail}/{icuTot}</p>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-rose-500 rounded-full" style={{ width: `${Math.min(100, utilization.icu || 0)}%` }} />
                      </div>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] uppercase font-bold text-slate-500">Vents</p>
                      <p className="font-extrabold text-slate-900">{ventAvail}/{ventTot}</p>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(100, utilization.ventilators || 0)}%` }} />
                      </div>
                    </div>
                  </div>
                  {hosp.location && <p className="mt-2 text-[10px] text-slate-400">📍 {hosp.location}</p>}
                </div>
              )
            })}
          </div>
        )
      }

      // 2. CASES LIST OR CASE DETAILS
      case 'fetch_case_data': {
        const isArray = Array.isArray(payloadData)
        const items = isArray ? payloadData : [payloadData].filter(Boolean)

        if (items.length === 0) {
          return <p className="mt-2 text-xs italic text-slate-500">No cases found.</p>
        }

        return (
          <div className="mt-2 max-h-48 overflow-y-auto border border-slate-200 rounded-2xl bg-white shadow-sm">
            <table className="min-w-full text-[11px] text-left">
              <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-2 py-2">Sev</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Hosp/Amb</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((c) => {
                  const severity = c.severity || 'P3'
                  const sevColor =
                    severity === 'P0' ? 'text-rose-700 bg-rose-50' :
                    severity === 'P1' ? 'text-orange-700 bg-orange-50' :
                    severity === 'P2' ? 'text-amber-700 bg-amber-50' : 'text-emerald-700 bg-emerald-50'

                  return (
                    <tr key={c.id}>
                      <td className="px-3 py-2 font-medium text-slate-900">
                        <div>{c.patient_name || `Case #${c.id}`}</div>
                        <div className="text-[10px] text-slate-400 font-normal">{c.condition || '—'}</div>
                      </td>
                      <td className="px-2 py-2">
                        <span className={`px-1.5 py-0.5 rounded-full font-bold text-[9px] ${sevColor}`}>
                          {severity}
                        </span>
                      </td>
                      <td className="px-2 py-2 capitalize font-semibold text-slate-700">{c.status || 'triaged'}</td>
                      <td className="px-2 py-2 text-slate-500 text-[10px]">
                        H{c.hospital_id || '—'} / A{c.ambulance_id || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      }

      // 3. AMBULANCES LIST
      case 'fetch_ambulance_data': {
        const isArray = Array.isArray(payloadData)
        const items = isArray ? payloadData : [payloadData].filter(Boolean)

        if (items.length === 0) {
          return <p className="mt-2 text-xs italic text-slate-500">No ambulances found.</p>
        }

        return (
          <div className="mt-2 space-y-2">
            {items.map((amb) => {
              const statusColor =
                amb.status === 'idle' ? 'bg-emerald-100 text-emerald-800' :
                amb.status === 'assigned' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-800'

              return (
                <div key={amb.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-3 shadow-sm text-xs">
                  <div>
                    <p className="font-bold text-slate-900">{amb.driver_name || `Ambulance #${amb.id}`}</p>
                    <p className="text-[10px] text-slate-400">ID: {amb.id} {amb.current_case_id ? `· Active Case #${amb.current_case_id}` : ''}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${statusColor}`}>
                    {amb.status || 'idle'}
                  </span>
                </div>
              )
            })}
          </div>
        )
      }

      // 4. RECOMMENDED HOSPITALS FOR INCIDENT
      case 'recommend_hospital_for_case': {
        const recommended = results.recommended || []
        const incidentId = results.case_id

        if (recommended.length === 0) {
          return <p className="mt-2 text-xs italic text-slate-500">No recommendations found.</p>
        }

        return (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Top Hospital Recommendations</p>
            {recommended.map((rec, index) => (
              <div key={rec.hospital_id} className="rounded-2xl border border-sky-100 bg-sky-50/50 p-3 shadow-sm text-xs">
                <div className="flex items-start justify-between font-bold">
                  <span className="text-slate-950">{index + 1}. {rec.hospital}</span>
                  <span className="text-[10px] text-sky-700 bg-sky-100 px-1.5 py-0.5 rounded-full">Score: {rec.score}</span>
                </div>
                <div className="mt-1 text-slate-600 text-[11px]">
                  <strong>Match Criteria:</strong> {rec.reasons?.join(', ')}
                </div>
                {incidentId && (
                  <button
                    onClick={() => executeAction('assign_hospital', { caseId: incidentId, hospitalId: rec.hospital_id })}
                    className="mt-2.5 w-full rounded-xl bg-sky-600 hover:bg-sky-500 py-1.5 text-center font-bold text-white text-[10px] transition-colors"
                  >
                    Assign Hospital {rec.hospital_id}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      }

      // 5. RECOMMENDED AMBULANCES FOR INCIDENT
      case 'recommend_ambulance_for_case': {
        const recommended = results.recommended || []
        const incidentId = results.case_id

        if (recommended.length === 0) {
          return <p className="mt-2 text-xs italic text-slate-500">No recommendations found.</p>
        }

        return (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Top Ambulance Recommendations</p>
            {recommended.map((rec, index) => (
              <div key={rec.ambulance_id} className="rounded-2xl border border-sky-100 bg-sky-50/50 p-3 shadow-sm text-xs">
                <div className="flex items-start justify-between font-bold">
                  <span className="text-slate-950">{index + 1}. {rec.driver_name}</span>
                  <span className="text-[10px] text-sky-700 bg-sky-100 px-1.5 py-0.5 rounded-full">Score: {rec.score}</span>
                </div>
                <div className="mt-1 text-slate-600 text-[11px]">
                  <strong>Match Criteria:</strong> {rec.reasons?.join(', ')}
                </div>
                {incidentId && (
                  <button
                    onClick={() => executeAction('assign_ambulance', { caseId: incidentId, ambulanceId: rec.ambulance_id })}
                    className="mt-2.5 w-full rounded-xl bg-sky-600 hover:bg-sky-500 py-1.5 text-center font-bold text-white text-[10px] transition-colors"
                  >
                    Assign Ambulance {rec.ambulance_id}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      }

      // 6. GENERAL RESOURCE/STATUS UPDATES COMMAND OUTPUT
      case 'update_hospital_resources':
      case 'update_ambulance_status':
      case 'update_ambulance_location':
      case 'assign_ambulance_to_case':
      case 'reserve_resources':
      case 'confirm_reservation':
      case 'release_resources': {
        return (
          <div className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 shadow-sm flex items-start gap-2">
            <span className="text-base">✅</span>
            <div>
              <p className="font-bold">System Updated</p>
              <p className="text-[11px] mt-0.5">{results.message || 'The command completed successfully.'}</p>
            </div>
          </div>
        )
      }

      default:
        return null
    }
  }

  // Suggestion chips now come from chatConfig
  // (variable `suggestions` defined above)

  return (
    <>
      {/* 1. FLOATING CHAT BUTTON */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-soft transition-all duration-200 hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 focus:ring-sky-200"
        title="Open PulsePath Operations Assistant"
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-6 w-6 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        )}
      </button>

      {/* 2. CHAT POPUP WINDOW */}
      <div
        className={`fixed bottom-24 right-6 z-50 flex h-[580px] w-[400px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white/95 backdrop-blur shadow-soft transition-all duration-300 transform origin-bottom-right ${
          isOpen ? 'scale-100 opacity-100 pointer-events-auto' : 'scale-90 opacity-0 pointer-events-none'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between bg-slate-900 px-5 py-4 text-white">
          <div>
            <h3 className="font-extrabold text-sm tracking-tight">PulsePath Assistant</h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              <p className="text-[10px] font-semibold tracking-wider text-slate-300 uppercase">
                {userRole} Mode
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClear}
              className="rounded-lg bg-white/10 px-2 py-1 text-[10px] font-bold text-slate-200 transition hover:bg-white/20 hover:text-white"
              title="Clear chat history"
            >
              Clear
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label="Close panel"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Message Feed */}
        <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50/50 p-4">
          {messages.map((msg) => {
            const isUser = msg.role === 'user'
            const isSystem = msg.role === 'system'

            if (isSystem) {
              return (
                <div key={msg.id} className="mx-auto max-w-[90%] rounded-2xl border border-slate-200 bg-slate-100 p-2.5 text-center text-xs text-slate-600">
                  <p>{msg.text}</p>
                </div>
              )
            }

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                    isUser
                      ? 'bg-sky-600 text-white rounded-tr-none'
                      : 'bg-white text-slate-800 border border-slate-200 rounded-tl-none'
                  }`}
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>

                  {/* Render error if present */}
                  {msg.error && (
                    <p className="mt-1.5 text-xs font-bold text-rose-500">
                      ⚠️ {msg.error}
                    </p>
                  )}

                  {/* Render structured tool data */}
                  {msg.data && renderStructuredData(msg.data)}
                </div>
                <span className="mt-1 px-1 text-[9px] text-slate-400 font-semibold uppercase tracking-wider">
                  {msg.timestamp}
                </span>
              </div>
            )
          })}

          {/* Typing Skeleton Loader */}
          {isLoading && (
            <div className="flex flex-col items-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-none border border-slate-200 bg-white px-4 py-3 shadow-sm w-44">
                <div className="space-y-2">
                  <div className="h-2 w-3/4 rounded bg-slate-200 animate-pulse" />
                  <div className="h-2 rounded bg-slate-200 animate-pulse" />
                  <div className="h-2 w-1/2 rounded bg-slate-200 animate-pulse" />
                </div>
              </div>
              <span className="mt-1 px-1 text-[9px] text-slate-400 font-semibold uppercase tracking-wider">
                Thinking...
              </span>
            </div>
          )}
          <div ref={feedEndRef} />
        </div>

        {/* Suggestion Chips */}
        {suggestions.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto border-t border-slate-100 bg-white px-4 py-2.5 scrollbar-none">
            {suggestions.map((sug) => (
              <button
                key={sug.label}
                onClick={() => handleSend(sug.text)}
                className="shrink-0 rounded-full border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600 transition"
              >
                {sug.label}
              </button>
            ))}
          </div>
        )}

        {/* Input Box */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
          className="border-t border-slate-200 bg-white p-3"
        >
          <div className="relative flex items-center">
            <input
              type="text"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 pl-4 pr-12 py-3 text-sm focus:border-sky-500 focus:bg-white outline-none transition focus:ring-4 focus:ring-sky-100 disabled:opacity-60"
              placeholder="Ask me anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="absolute right-2.5 flex h-8 w-8 items-center justify-center rounded-xl bg-sky-600 hover:bg-sky-500 text-white transition disabled:bg-slate-200 disabled:text-slate-400"
            >
              <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

ChatAssistant.propTypes = {
  caseId: PropTypes.number
}
