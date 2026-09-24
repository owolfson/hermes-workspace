import { describe, expect, it } from 'vitest'
import { newestCheckpointFromMessages, parseSwarmCheckpoint } from './swarm-checkpoints'

const checkpointText = (result: string) => `STATE: DONE
FILES_CHANGED: none
COMMANDS_RUN: none
RESULT: ${result}
BLOCKER: none
NEXT_ACTION: none`

describe('newestCheckpointFromMessages freshness guard', () => {
  // A worker's chat DB keeps its whole history. A DONE checkpoint left over from
  // an earlier mission must never be read as the result of a new dispatch.
  const dispatchedAtMs = 1790210060229 // 2026-09-24
  const staleSeconds = 1783559471 // 2026-07-09, worker chat DBs store epoch SECONDS
  const freshSeconds = Math.floor(dispatchedAtMs / 1000) + 30

  it('returns the newest checkpoint when no bound is given (unchanged behaviour)', () => {
    const found = newestCheckpointFromMessages([
      { role: 'assistant', content: checkpointText('old'), timestamp: staleSeconds },
    ])
    expect(found?.result).toBe('old')
  })

  it('ignores a checkpoint from before the dispatch (stale result from a previous mission)', () => {
    const found = newestCheckpointFromMessages(
      [{ role: 'assistant', content: checkpointText('old mission'), timestamp: staleSeconds }],
      { notBeforeMs: dispatchedAtMs },
    )
    expect(found).toBeNull()
  })

  it('accepts a checkpoint written after the dispatch, timestamps in seconds or ms', () => {
    const inSeconds = newestCheckpointFromMessages(
      [{ role: 'assistant', content: checkpointText('fresh'), timestamp: freshSeconds }],
      { notBeforeMs: dispatchedAtMs },
    )
    const inMillis = newestCheckpointFromMessages(
      [{ role: 'assistant', content: checkpointText('fresh'), timestamp: freshSeconds * 1000 }],
      { notBeforeMs: dispatchedAtMs },
    )
    expect(inSeconds?.result).toBe('fresh')
    expect(inMillis?.result).toBe('fresh')
  })

  it('picks the fresh checkpoint even when an older stale one also exists', () => {
    const found = newestCheckpointFromMessages(
      [
        { role: 'assistant', content: checkpointText('old mission'), timestamp: staleSeconds },
        { role: 'assistant', content: checkpointText('this mission'), timestamp: freshSeconds },
      ],
      { notBeforeMs: dispatchedAtMs },
    )
    expect(found?.result).toBe('this mission')
  })

  it('cannot prove a message without a timestamp is fresh, so it is skipped when a bound is given', () => {
    const found = newestCheckpointFromMessages(
      [{ role: 'assistant', content: checkpointText('undated'), timestamp: null }],
      { notBeforeMs: dispatchedAtMs },
    )
    expect(found).toBeNull()
  })
})

describe('parseSwarmCheckpoint', () => {
  it('parses complete proof checkpoints', () => {
    const parsed = parseSwarmCheckpoint(`STATE: DONE
FILES_CHANGED: none
COMMANDS_RUN: npm test
RESULT: all green
BLOCKER: none
NEXT_ACTION: ship it`)
    expect(parsed?.stateLabel).toBe('DONE')
    expect(parsed?.checkpointStatus).toBe('done')
    expect(parsed?.runtimeState).toBe('idle')
    expect(parsed?.commandsRun).toBe('npm test')
  })

  it('rejects partial checkpoint blocks', () => {
    const parsed = parseSwarmCheckpoint(`STATE: DONE
FILES_CHANGED: none
COMMANDS_RUN: none`)
    expect(parsed).toBeNull()
  })

  it('maps blocked checkpoints to runtime blocked state', () => {
    const parsed = parseSwarmCheckpoint(`STATE: BLOCKED
FILES_CHANGED: none
COMMANDS_RUN: none
RESULT: cannot continue
BLOCKER: missing auth
NEXT_ACTION: ask Eric`)
    expect(parsed?.runtimeState).toBe('blocked')
    expect(parsed?.checkpointStatus).toBe('blocked')
    expect(parsed?.blocker).toBe('missing auth')
  })
})
