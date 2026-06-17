/**
 * P2.3 – Chat action executor.
 *
 * When the backend AI returns a tool_used field that represents a mutating
 * action (not just a read/fetch), this module dispatches the corresponding
 * API call and returns the result so the UI can show feedback.
 *
 * Role-based permission checks are enforced here so a hospital user cannot
 * accidentally trigger an admin-only reassignment.
 */
import * as api from './api.js'

/**
 * @param {string} toolUsed   - Value of response.toolUsed from sendChatMessage
 * @param {object} toolArgs   - Value of response.toolArgs from sendChatMessage
 * @param {string} userRole   - 'admin' | 'hospital' | 'ambulance'
 * @returns {Promise<object|null>} API result, or null if tool is read-only
 */
export async function executeChatAction(toolUsed, toolArgs, userRole) {
  if (!toolUsed || !toolArgs) return null

  switch (toolUsed) {
    // ── Resource updates (hospital + admin) ──────────────────────────────────
    case 'update_hospital_resources': {
      if (userRole !== 'hospital' && userRole !== 'admin') {
        throw new Error('Only hospital users can update resources.')
      }
      const { hospital_id, resource_type, quantity_change, absolute_value, total_value } = toolArgs
      return api.updateHospitalResources(hospital_id, {
        resource_type,
        quantity_change,
        absolute_value,
        total_value
      })
    }

    case 'reserve_resources':
    case 'release_resources':
    case 'confirm_reservation': {
      if (userRole !== 'hospital' && userRole !== 'admin') {
        throw new Error('Only hospital users can manage resource reservations.')
      }
      const { hospital_id, ...rest } = toolArgs
      return api.updateHospitalResourceStatus(hospital_id, { tool: toolUsed, ...rest })
    }

    // ── Case reassignment (admin only) ────────────────────────────────────────
    case 'assign_ambulance_to_case':
    case 'recommend_ambulance_for_case': {
      if (userRole !== 'admin') {
        throw new Error('Only admins can reassign ambulances.')
      }
      const { ambulance_id, case_id } = toolArgs
      return api.changeAmbulance(case_id, ambulance_id)
    }

    case 'assign_hospital_to_case':
    case 'recommend_hospital_for_case': {
      if (userRole !== 'admin') {
        throw new Error('Only admins can reassign hospital destinations.')
      }
      const { hospital_id, case_id } = toolArgs
      return api.changeHospital(case_id, hospital_id)
    }

    // ── Ambulance status (ambulance drivers only) ─────────────────────────────
    case 'update_ambulance_status': {
      if (userRole !== 'ambulance' && userRole !== 'admin') {
        throw new Error('Only ambulance drivers or admins can update ambulance status.')
      }
      const { ambulance_id, status } = toolArgs
      return api.updateAmbulanceStatus(ambulance_id, status)
    }

    case 'update_ambulance_location': {
      if (userRole !== 'ambulance' && userRole !== 'admin') {
        throw new Error('Only ambulance drivers can update their location.')
      }
      const { ambulance_id, latitude, longitude } = toolArgs
      return api.updateAmbulanceLocation(ambulance_id, latitude, longitude)
    }

    // ── Case status update ────────────────────────────────────────────────────
    case 'update_case_data':
    case 'update_case_status': {
      const { case_id, status } = toolArgs
      if (userRole === 'hospital') {
        return api.updateHospitalCaseStatus(case_id, status)
      }
      if (userRole === 'admin') {
        return api.updateCaseStatus(case_id, status)
      }
      throw new Error('Insufficient permissions to update case status.')
    }

    // ── Read-only / fetch tools – no side effect needed ───────────────────────
    case 'fetch_hospital_data':
    case 'fetch_resource_snapshot':
    case 'fetch_case_data':
    case 'fetch_ambulance_data':
    case null:
    case undefined:
      return null

    default:
      // Unknown tool — no action, log for debugging
      console.warn('[chatActions] Unknown tool_used:', toolUsed, toolArgs)
      return null
  }
}

/**
 * Returns true if the given tool name represents a mutating action
 * (so the caller knows to show a confirmation / trigger a data refresh).
 */
export function isMutatingTool(toolUsed) {
  const READ_TOOLS = new Set([
    'fetch_hospital_data',
    'fetch_resource_snapshot',
    'fetch_case_data',
    'fetch_ambulance_data',
  ])
  return !!toolUsed && !READ_TOOLS.has(toolUsed)
}
