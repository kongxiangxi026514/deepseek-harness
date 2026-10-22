// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/apply.ts'

interface Bench {
  runtime: SlotTestRuntime
  slots: SlotTestRuntime['slots']
  developerTools: ReturnType<typeof createSnapshotStore<boolean>>
  reference: { release(): void }
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function bench(): Promise<Bench> {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  // Provide the services the full apply() injects beyond the runtime's own.
  runtime.ctx.provide('locale', new LocaleRuntime(runtime.ctx))
  const developerTools = createSnapshotStore(true)
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: developerTools },
    get: () => stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('uiWorkspace', {
    openSession: () => {},
    openWorkspace: async () => {},
  } as never)
  // The Conversation registrations live under slots.inject('main', ...);
  // declaring 'main' materializes them, including the 'conversation.view'
  // child declaration.
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  // A conversation.view entry makes resolveActiveView find a tab, so
  // activateView reaches uiConversation.binding() during refreshViews.
  const disposeView = runtime.slots.register(
    { name: 'conversation.view', id: 'chat', label: 'Chat' },
    () => null,
  )
  cleanups.push(disposeView)
  await runtime.sessions.add({ id: 's1' })
  const reference = runtime.sessions.retain('s1' as SessionId)
  await reference.ready
  // Materialize the UiSession binding so the ui-conversation provide
  // descriptor resolves and tracks this binding in its refresh set.
  runtime.ctx.uiSession.bindingSource(reference)
  return { runtime, slots: runtime.slots, developerTools, reference }
}

describe('ui-conversation view refresh over dying bindings', () => {
  it('skips a released session without throwing during a view refresh', async () => {
    const b = await bench()
    // Kill the binding synchronously; its Set removal waits for the effect
    // cleanup flush, so the dead binding is still tracked at this point.
    b.reference.release()
    expect(b.runtime.sessions.binding('s1')).toBeUndefined()

    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    try {
      // developerTools toggle fires the refreshViews subscription while the
      // dead binding is still in the tracked Set.
      b.developerTools.set(false)
      await b.runtime.flush()
    } finally {
      spy.mockRestore()
    }
    expect(errors).toEqual([])
  })

  it('still activates the View for a live session', async () => {
    const b = await bench()
    const binding = b.runtime.sessions.binding('s1')
    expect(binding).toBeDefined()
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    try {
      b.developerTools.set(false)
      await b.runtime.flush()
    } finally {
      spy.mockRestore()
    }
    expect(errors).toEqual([])
  })
})
