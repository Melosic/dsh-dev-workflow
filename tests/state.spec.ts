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

  it('keys a remembered approval apart from a check that already ran', () => {
    // Both live in the same bucket, so a shared key space would let a check
    // over an operation count as an approval of it. That is the dangerous
    // direction: the guard would skip a prompt nobody answered.
    const state = createWorkflowState()
    state.remember('session', 'commit', 'abc')
    expect(state.approved('session', 'abc')).toBe(false)
    state.rememberApproval('session', 'abc')
    expect(state.seen('session', 'commit', 'abc')).toBe(true)
    // And the same hash means different things under a different kind.
    expect(state.seen('session', 'pr', 'abc')).toBe(false)
  })

  it('keeps the last outcome, and the tally the status line reads', () => {
    const state = createWorkflowState()
    expect(state.lastOutcome()).toBeUndefined()
    // Recognition is counted whether or not the policy let the call through —
    // otherwise "nothing happened" and "everything was downgraded" read alike.
    state.recordGuardHit('security.force_push', 'deny')
    state.recordGuardHit('security.force_push', 'deny')
    state.recordGuardHit('security.force_push', 'allow')
    state.record({ kind: 'commit', ok: false, summary: 'boom' })
    expect(state.lastOutcome()).toEqual({ kind: 'commit', ok: false, summary: 'boom' })
    expect(state.guardHits()).toEqual({ 'security.force_push': 3 })
    // The action list names the tier that applied last, which is the one that
    // needs explaining when a guard fired and nothing was blocked.
    expect(state.guardHitActions()).toEqual({ 'security.force_push': 'allow' })
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
