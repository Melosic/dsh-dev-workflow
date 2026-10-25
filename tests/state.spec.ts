import { describe, expect, it } from 'vitest'
import { createWorkflowState } from '../src/state.js'

// The state is per plugin instance and lives as long as the process, so every
// map inside it needs a ceiling: a long-lived host serves session after session
// and a finished session never announces that it is finished.

describe('per-session memory', () => {
  it('drops the least recently used target instead of growing without bound', () => {
    const state = createWorkflowState()
    for (let index = 0; index < 600; index += 1) {
      state.remember('session', 'commit', `target-${index}`)
    }
    // The ceiling is 512, so the newest survive and the oldest are gone.
    expect(state.seen('session', 'commit', 'target-599')).toBe(true)
    expect(state.seen('session', 'commit', 'target-0')).toBe(false)
  })

  it('forgets old sessions rather than keeping an empty bucket each', () => {
    const state = createWorkflowState()
    state.remember('first', 'commit', 'target')
    for (let index = 0; index < 40; index += 1) {
      state.remember(`later-${index}`, 'commit', 'target')
    }
    // Forgetting only means the next check asks again, which is the safe
    // direction; keeping every bucket forever is the leak.
    expect(state.seen('first', 'commit', 'target')).toBe(false)
    expect(state.seen('later-39', 'commit', 'target')).toBe(true)
  })
})
