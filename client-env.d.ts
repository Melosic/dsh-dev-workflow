// Type declarations for the browser half.
//
// `client.js` is hand-written in the deployment's module-table format rather
// than built, so nothing declares the two things it leans on: the loader that
// calls its factory, and the `react` external that factory receives (the Host
// resolves it at runtime, it is not a dependency of this package).
//
// The value this file adds is the IMPORT below. Pulling in the Host's own type
// entries puts their `declare module '@deepseek-ai/cordis'` augmentations in
// the program, so `Context` really carries `configForms`, `locale`, `remote`
// and `slots`. `client.js` annotates its `apply` parameter with that type, and
// from there a renamed method or a field the Host dropped is a compile error
// instead of a blank panel discovered by a user. This is what makes
// `tsconfig.client.json` a contract check rather than a syntax check.
//
// Build-time input only; not in `files`, so it never ships.

/* `ctx.slots` is declared by the renderer, not by `dsh-client-ui-slots`: that
 * package owns the types but never mounts the service, so importing it alone
 * leaves `slots` missing from `Context`. The other three declare `configForms`,
 * `locale` and `remote`. */
import '@deepseek-ai/dsh-client-ui-renderer/client'
import '@deepseek-ai/dsh-client-ui-settings/client'
import '@deepseek-ai/dsh-client-locale/client'
import '@deepseek-ai/dsh-api-remotes/client'

/* The panel's own locale namespace, declared the way an official client plugin
 * declares its strip of copy. Without this the host's `register`/`bind` reject
 * `settings.devWorkflow` at the type level, even though the dictionary is
 * registered at runtime. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.devWorkflow': string
  }
}

/* The imports above make this file a module, so an ambient `Window` merge has
 * to be spelled inside `declare global`. */
declare global {
  /** The module-table loader the deployment evaluates `client.js` in. */
  interface Window {
    __ModuleLoader__: {
      load(module: { id: string; factory: (require: ModuleRequire) => unknown }): unknown
    }
  }
}

export {}

/**
 * The externals the loader resolves. `client.js` asks for `react` and nothing
 * else, so the first overload pins that one id and everything else stays
 * unknown rather than silently typed.
 */
interface ModuleRequire {
  (id: 'react'): typeof import('react')
  (id: string): unknown
}

type ReactNode = unknown
type DependencyList = readonly unknown[]

interface ReactRef<T> {
  current: T
}

declare module 'react' {
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: ReactNode[]
  ): ReactNode
  export const Fragment: unique symbol
  /* `current` widens to `any` on purpose: `client.js` is unannotated JS that
   * stores DOM nodes in refs, so a `ReactRef<T>` narrowed from `useRef([])`
   * makes the element type `never`. Ref plumbing is not the surface this check
   * guards — service and prop shapes are — so it stays open. The lint exemption
   * is scoped to this one line for the same reason. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function useRef<T>(initial: T): ReactRef<any>
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: DependencyList): void
}
