import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Per-session model preference.
 *
 * Stored locally in the browser keyed by sessionKey, so a user can pick a
 * different model for one chat without affecting the global default in
 * `~/.hermes/config.yaml` or any other channel (Telegram, Discord, etc.).
 *
 * On every send, the workspace passes this value as the `model` field in
 * the chat-completion request body. The gateway uses it for that request
 * only; nothing else mutates.
 *
 * A pick made on a brand-new chat (no session key yet) is stored under
 * NEW_CHAT_MODEL_KEY and moved onto the real key by `adoptModel` once the
 * chat gets one.
 *
 * Cleared automatically when the session is deleted.
 */
export const NEW_CHAT_MODEL_KEY = 'new'

export function sessionModelKey(sessionKey: string | null | undefined): string {
  const trimmed = typeof sessionKey === 'string' ? sessionKey.trim() : ''
  return trimmed || NEW_CHAT_MODEL_KEY
}

type State = {
  models: Record<string, string>
}

type Actions = {
  getModel: (sessionKey: string | null | undefined) => string | undefined
  setModel: (sessionKey: string, model: string) => void
  clearModel: (sessionKey: string) => void
  /**
   * Copy the model picked under `fromKey` onto each of `toKeys` that has no
   * pick of its own. When `fromKey` is the new-chat slot it is cleared, so the
   * next new chat starts on the default again.
   */
  adoptModel: (
    fromKey: string | null | undefined,
    ...toKeys: Array<string | null | undefined>
  ) => void
}

export const useSessionModelStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      models: {},
      getModel: (sessionKey) => {
        if (!sessionKey) return undefined
        return get().models[sessionKey]
      },
      setModel: (sessionKey, model) => {
        if (!sessionKey) return
        const trimmed = model.trim()
        if (!trimmed) return
        set((state) => ({
          models: { ...state.models, [sessionKey]: trimmed },
        }))
      },
      clearModel: (sessionKey) => {
        if (!sessionKey) return
        set((state) => {
          if (!(sessionKey in state.models)) return state
          const next = { ...state.models }
          delete next[sessionKey]
          return { models: next }
        })
      },
      adoptModel: (fromKey, ...toKeys) => {
        const source = sessionModelKey(fromKey)
        set((state) => {
          const model = state.models[source]
          if (!model) return state
          const next = { ...state.models }
          let changed = false
          for (const rawKey of toKeys) {
            const key = typeof rawKey === 'string' ? rawKey.trim() : ''
            if (!key || key === source || next[key]) continue
            next[key] = model
            changed = true
          }
          if (source === NEW_CHAT_MODEL_KEY) {
            delete next[source]
            changed = true
          }
          return changed ? { models: next } : state
        })
      },
    }),
    {
      name: 'hermes-session-model',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ models: state.models }),
    },
  ),
)
