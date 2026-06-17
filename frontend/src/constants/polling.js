/**
 * P4.1 – Centralised polling intervals (ms) so every page uses the same constants.
 * Adjust here and all dashboards update automatically.
 */
export const POLLING = {
  /** Admin dashboard – needs frequent updates across all hospitals */
  ADMIN_CASES: 5_000,
  /** Hospital dashboard – incoming cases, still fairly frequent */
  HOSPITAL_CASES: 10_000,
  /** Ambulance dashboard – driver needs near-real-time case queue */
  AMBULANCE_CASES: 3_000,
  /** Resource counts change less often */
  RESOURCES: 15_000,
  /** DataContext global background refresh */
  GLOBAL: 15_000,
}
