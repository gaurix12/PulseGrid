import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy only actual backend API paths — avoid catching frontend routes like /admin/dashboard
      '/auth': 'http://127.0.0.1:5000',
      '/admin/get-all-cases': 'http://127.0.0.1:5000',
      '/admin/change-hosp': 'http://127.0.0.1:5000',
      '/admin/change-ambulance': 'http://127.0.0.1:5000',
      '/hospitals': 'http://127.0.0.1:5000',
      '/ambulances': 'http://127.0.0.1:5000',
      '/cases': 'http://127.0.0.1:5000',
      '/chat': 'http://127.0.0.1:5000',
      '/emergency': 'http://127.0.0.1:5000',
      '/setup': 'http://127.0.0.1:5000',
      '/api': 'http://127.0.0.1:5000',
    },
  },
})
