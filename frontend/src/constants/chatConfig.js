/**
 * P2.1 – Role-specific chat configuration.
 * Drives titles, accent colours, suggestion prompts, and system context sent
 * to the backend with every chat message.
 */
export const CHAT_CONFIG = {
  hospital: {
    title: 'Hospital Operations Assistant',
    subtitle: 'Query cases, check capacity, update resources',
    accent: 'from-sky-600 to-cyan-600',
    dot: 'bg-sky-400',
    examples: [
      { label: 'Bed availability', text: 'How many beds are available?' },
      { label: 'ICU status', text: 'How many ICU beds available?' },
      { label: 'Critical cases', text: 'Show me all P0 cases' },
      { label: 'Update beds', text: 'Update beds by +5' },
    ],
    systemContext: `You are a hospital operations assistant.
You have access to:
  - Incoming emergency cases assigned to this hospital
  - Resource counts (beds, ICU, ventilators)
  - Ambulance ETAs for in-bound patients
You can answer queries and request resource updates. Be concise and clinical.`,
  },

  admin: {
    title: 'City Dispatch Command',
    subtitle: 'Monitor all hospitals, ambulances, and cases',
    accent: 'from-violet-600 to-indigo-600',
    dot: 'bg-violet-400',
    examples: [
      { label: 'Active ambulances', text: 'How many ambulances are active?' },
      { label: 'Overloaded hospitals', text: 'Which hospitals are overloaded?' },
      { label: 'Reassign case', text: 'Reassign case 1 to ambulance 2' },
      { label: 'P0 cases', text: 'Show all P0 cases right now' },
    ],
    systemContext: `You are an emergency dispatch commander.
You have access to:
  - All active cases city-wide (real-time)
  - Hospital capacity across the full network
  - Ambulance fleet status and locations
  - Case assignment and reassignment tools
You can query any data and trigger reassignments. Respond concisely.`,
  },

  ambulance: {
    title: 'Ambulance Dispatch Assistant',
    subtitle: 'Your assigned case, nearby emergencies, route info',
    accent: 'from-rose-600 to-orange-500',
    dot: 'bg-rose-400',
    examples: [
      { label: 'My case', text: "What's my current case?" },
      { label: 'Nearby cases', text: 'Show nearby emergencies' },
      { label: 'Hospital address', text: "What's the hospital address?" },
      { label: 'ETA', text: 'What is my estimated arrival time?' },
    ],
    systemContext: `You are an ambulance driver assistant.
You have access to:
  - Your currently assigned case (if any)
  - Nearby unassigned emergency cases
  - Case details and destination hospital info
  - Your current GPS coordinates
You can only view and query — you cannot reassign cases to other units.`,
  },

  guest: {
    title: 'Dispatch Assistant',
    subtitle: 'Emergency dispatch support',
    accent: 'from-slate-600 to-slate-700',
    dot: 'bg-slate-400',
    examples: [
      { label: 'Help', text: 'What can you help me with?' },
    ],
    systemContext: 'You are an emergency dispatch assistant.',
  },
}
