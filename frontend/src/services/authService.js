import { loginUser, logoutUser, registerUser } from './api.js'

export async function login(credentials) {
  return loginUser(credentials)
}

export async function register(payload) {
  return registerUser(payload)
}

export async function logout() {
  return logoutUser()
}

export default {
  login,
  register,
  logout,
}