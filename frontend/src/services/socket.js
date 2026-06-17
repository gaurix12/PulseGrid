import { io } from 'socket.io-client'

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5000'

export function createSocket() {
  return io(API_URL, {
    transports: ['websocket', 'polling'],
  })
}
