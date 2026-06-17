import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'

import { AuthProvider } from './context/AuthContext.jsx'
import { DataProvider } from './context/DataContext.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import ToastViewport from './components/ToastViewport.jsx'
import { OfflineBanner } from './components/shared/OfflineBanner.jsx'
import AuthLayout from './layouts/AuthLayout.jsx'
import MainLayout from './layouts/MainLayout.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import NotFoundPage from './pages/NotFoundPage.jsx'
import AdminDashboardPage from './pages/AdminDashboardPage.jsx'
import AdminCaseManagementPage from './pages/admin/CaseManagement.jsx'
import AdminCaseMapPage from './pages/admin/CaseMap.jsx'
import HospitalDetailsPage from './pages/admin/HospitalDetails.jsx'
import HospitalDashboardPage from './pages/hospital/HospitalDashboard.jsx'
import HospitalHistoryPage from './pages/hospital/HospitalHistory.jsx'
import HospitalOnboarding from './pages/hospital/HospitalOnboarding.jsx'
import AmbulanceDashboardPage from './pages/ambulance/AmbulanceDashboard.jsx'
import AmbulanceOnboarding from './pages/ambulance/AmbulanceOnboarding.jsx'
import ChatPage from './pages/ChatPage.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <DataProvider>
        <BrowserRouter>
          <OfflineBanner />
          <ToastViewport />
          <Routes>
            <Route element={<AuthLayout />}>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
            </Route>

            <Route element={<ProtectedRoute allowedRoles={['admin']} />}>
              <Route element={<MainLayout />}>
                <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
                <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
                <Route path="/admin/cases" element={<AdminCaseManagementPage />} />
                <Route path="/admin/map" element={<AdminCaseMapPage />} />
                <Route path="/admin/hospitals/:hospitalId" element={<HospitalDetailsPage />} />
                <Route path="/admin/*" element={<Navigate to="/admin/dashboard" replace />} />
              </Route>
            </Route>

            <Route element={<ProtectedRoute allowedRoles={['hospital']} />}>
              <Route element={<MainLayout />}>
                <Route path="/hospital" element={<Navigate to="/hospital/dashboard" replace />} />
                <Route path="/hospital/dashboard" element={<HospitalDashboardPage />} />
                <Route path="/hospital/history" element={<HospitalHistoryPage />} />
                <Route path="/hospital/*" element={<HospitalDashboardPage />} />
              </Route>
              <Route path="/hospital/onboarding" element={<HospitalOnboarding />} />
            </Route>

            <Route element={<ProtectedRoute allowedRoles={['ambulance']} />}>
              <Route element={<MainLayout />}>
                <Route path="/ambulance" element={<Navigate to="/ambulance/dashboard" replace />} />
                <Route path="/ambulance/dashboard" element={<AmbulanceDashboardPage />} />
                <Route path="/ambulance/*" element={<AmbulanceDashboardPage />} />
              </Route>
              <Route path="/ambulance/onboarding" element={<AmbulanceOnboarding />} />
            </Route>
            {/* P1.2 FIX: ChatPage is full-screen – no MainLayout wrapper */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'hospital', 'ambulance']} />}>
              <Route path="/chat" element={<ChatPage />} />
            </Route>

            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </DataProvider>
    </AuthProvider>
  </StrictMode>,
)
