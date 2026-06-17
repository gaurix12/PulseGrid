import { create } from 'zustand'

let toastId = 0

export const useUiStore = create((set, get) => ({
  toasts: [],
  pushToast: ({ title, description, tone = 'error', timeout = 4500 }) => {
    const id = ++toastId
    const toast = { id, title, description, tone }
    set({ toasts: [toast, ...get().toasts].slice(0, 5) })

    if (typeof window !== 'undefined' && timeout > 0) {
      window.setTimeout(() => {
        get().removeToast(id)
      }, timeout)
    }

    return id
  },
  removeToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
  clearToasts: () => set({ toasts: [] }),
}))