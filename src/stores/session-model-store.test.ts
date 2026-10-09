import { beforeEach, describe, expect, it } from 'vitest'
import {
  NEW_CHAT_MODEL_KEY,
  sessionModelKey,
  useSessionModelStore,
} from './session-model-store'

const store = () => useSessionModelStore.getState()

describe('session model store', () => {
  beforeEach(() => {
    useSessionModelStore.setState({ models: {} })
  })

  it('stores a new-chat pick under the new-chat slot', () => {
    store().setModel(sessionModelKey(undefined), 'llm7/gemini-3.8-flash-high')
    expect(store().getModel(NEW_CHAT_MODEL_KEY)).toBe('llm7/gemini-3.8-flash-high')
  })

  it('moves a new-chat pick onto the thread it creates and clears the slot', () => {
    store().setModel(NEW_CHAT_MODEL_KEY, 'llm7/gemini-3.8-flash-high')
    store().adoptModel(undefined, 'thread-1')
    expect(store().getModel('thread-1')).toBe('llm7/gemini-3.8-flash-high')
    expect(store().getModel(NEW_CHAT_MODEL_KEY)).toBeUndefined()
  })

  it('follows a thread id the server resolves to another session id', () => {
    store().setModel('thread-1', 'llm7/kimi-k2.6')
    store().adoptModel('thread-1', 'hermes-session-9', 'thread-1')
    expect(store().getModel('hermes-session-9')).toBe('llm7/kimi-k2.6')
    expect(store().getModel('thread-1')).toBe('llm7/kimi-k2.6')
  })

  it('never overwrites a pick the target session already has', () => {
    store().setModel(NEW_CHAT_MODEL_KEY, 'llm7/kimi-k2.6')
    store().setModel('thread-1', 'llm7/minimax-m3')
    store().adoptModel(undefined, 'thread-1')
    expect(store().getModel('thread-1')).toBe('llm7/minimax-m3')
  })

  it('is a no-op without a source pick', () => {
    store().adoptModel(undefined, 'thread-1')
    expect(store().models).toEqual({})
  })
})
