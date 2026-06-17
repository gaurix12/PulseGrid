export const roleHomeRoute = {
  admin: '/admin/dashboard',
  hospital: '/hospital/dashboard',
  ambulance: '/ambulance/dashboard',
}

export const permissionsByRole = {
  admin: ['view_all_cases', 'reassign_cases', 'audit_trail', 'fleet_monitoring'],
  hospital: ['view_hospital_cases', 'manage_resources', 'discharge_workflow'],
  ambulance: ['view_assigned_cases', 'update_status', 'update_location', 'route_navigation'],
}

export const navigationByRole = {
  admin: [
    { label: 'Dashboard', href: '/admin/dashboard' },
    { label: 'Cases', href: '/admin/cases' },
    { label: 'Map', href: '/admin/map' },
    { label: 'Chat Room', href: '/chat' },
  ],
  hospital: [
    { label: 'Dashboard', href: '/hospital/dashboard' },
    { label: 'History', href: '/hospital/history' },
    { label: 'Resources', href: '/hospital/dashboard#resources' },
    { label: 'Cases', href: '/hospital/dashboard#cases' },
    { label: 'Workflow', href: '/hospital/dashboard#workflow' },
    { label: 'Chat Room', href: '/chat' },
  ],
  ambulance: [
    { label: 'Dashboard', href: '/ambulance/dashboard' },
    { label: 'Queue', href: '/ambulance/dashboard#queue' },
    { label: 'Navigation', href: '/ambulance/dashboard#navigation' },
    { label: 'Status', href: '/ambulance/dashboard#status' },
    { label: 'Chat Room', href: '/chat' },
  ],
}