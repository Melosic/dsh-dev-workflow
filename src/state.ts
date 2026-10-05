// Session-scoped memory for the automatic checks.
//
// The specification asks for one prompt per problem per session: an agent that
// ignores a finding must be able to carry on without being asked again, and a
// new session may ask again. That is a deduplication keyed by the thing being
// checked, and nothing about it survives a restart — so it lives in a plain
// in-memory structure owned by the plugin fiber, never on disk.

/** Which check produced an outcome. */
export type CheckKind = 'commit' | 'doc' | 'pr' | 'release'

/** The most recent outcome of one check, as the status line renders it. */
export interface CheckOutcome {
  /** The check that ran. */
  readonly kind: CheckKind
  /** Whether it ran and found no blocking problem. */
  readonly ok: boolean
  /** One line saying what it found. */
  readonly summary: string
}

/** How many times each guard reason has fired since the plugin loaded. */
export type GuardTally = Readonly<Record<string, number>>

/**
 * What the plugin remembers while it is loaded: what was already reported, what
 * the last check found, and how often the guards fired.
 */
export interface WorkflowState {
  /**
   * Whether this exact target was already reported in this session.
   * @param sessionId - the session the tool call belongs to.
   * @param kind - which check.
   * @param targetId - hash of what was checked.
   */
  seen(sessionId: string, kind: CheckKind, targetId: string): boolean
  /**
   * Mark a target as reported.
   * @param sessionId - the session the tool call belongs to.
   * @param kind - which check.
   * @param targetId - hash of what was checked.
   */
  remember(sessionId: string, kind: CheckKind, targetId: string): void
  /**
   * Remember the outcome of a check for the status line.
   * @param outcome - what the check found.
   */
  record(outcome: CheckOutcome): void
  /** The most recent outcome, or `undefined` if no check has run yet. */
  lastOutcome(): CheckOutcome | undefined
  /**
   * Count one guard hit.
   * @param reason - the dictionary key of the guard that fired.
   */
  recordGuardHit(reason: string): void
  /** A copy of the guard tallies, so callers cannot mutate them. */
  guardHits(): GuardTally
}

// A long session can commit many times; each remembered target is a short hash,
// but the map still needs a ceiling so a session that never ends cannot grow
// without bound. Oldest-first eviction is enough — a repeat of something
// reported hundreds of commits ago is worth re-reporting anyway.
const MAX_TARGETS_PER_SESSION = 512

/**
 * Create the state for one plugin instance.
 * @returns an empty state; nothing is remembered yet.
 */
export function createWorkflowState(): WorkflowState {
  const targets = new Map<string, Set<string>>()
  const guardHits = new Map<string, number>()
  let last: CheckOutcome | undefined

  const bucket = (sessionId: string): Set<string> => {
    const existing = targets.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    targets.set(sessionId, created)
    return created
  }

  return {
    seen: (sessionId, kind, targetId) => bucket(sessionId).has(`${kind}:${targetId}`),
    remember: (sessionId, kind, targetId) => {
      const set = bucket(sessionId)
      set.add(`${kind}:${targetId}`)
      while (set.size > MAX_TARGETS_PER_SESSION) {
        const oldest = set.values().next().value
        if (oldest === undefined) break
        set.delete(oldest)
      }
    },
    record: (outcome) => {
      last = outcome
    },
    lastOutcome: () => last,
    recordGuardHit: (reason) => {
      guardHits.set(reason, (guardHits.get(reason) ?? 0) + 1)
    },
    guardHits: () => Object.fromEntries(guardHits),
  }
}
