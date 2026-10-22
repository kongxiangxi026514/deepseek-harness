import { describe, expect, it } from 'vitest'
import type {
  ConversationMatch, ConversationNodeContext, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { toolDefinition, type ToolState } from '../src/client/conversation-nodes/tool.ts'

/** A durable root tool/call, typed for the Definition's start path. */
const rootCall = (seq: number): SessionEvent<'tool/call'> => ({
  type: 'tool/call',
  seq: SessionSeq(seq),
  time: 1_700_000_000_000 + seq,
  data: { turn: 1, step: 1, callId: ToolCallId('root'), name: 'run_code', arguments: '{}' },
})

const dispatchStart = (seq: number, parentCallId: string, subCallId: string): SessionEvent<'tool/ptc-dispatch-start'> => ({
  type: 'tool/ptc-dispatch-start',
  seq: SessionSeq(seq),
  time: 1_700_000_000_000 + seq,
  data: {
    rootCallId: ToolCallId('root'),
    parentCallId: ToolCallId(parentCallId),
    subCallId: ToolCallId(subCallId),
    name: 'read_file',
    arguments: { path: 'a' },
  },
})

const dispatchSettle = (seq: number, parentCallId: string, subCallId: string): SessionEvent<'tool/ptc-dispatch'> => ({
  type: 'tool/ptc-dispatch',
  seq: SessionSeq(seq),
  time: 1_700_000_000_000 + seq,
  data: {
    rootCallId: ToolCallId('root'),
    parentCallId: ToolCallId(parentCallId),
    subCallId: ToolCallId(subCallId),
    name: 'read_file',
    arguments: { path: 'a' },
    isError: false,
    content: [{ type: 'text', text: 'done' }],
  },
})

const matchOf = (event: SessionEvent): ConversationMatch =>
  ({ event, role: 'update', location: { kind: 'session' } })

const startMatchOf = (event: SessionEvent): ConversationStartMatch =>
  ({ event, role: 'start', location: { kind: 'session' } })

const contextWith = (state?: ToolState): ConversationNodeContext<ToolState> & { readonly state: ToolState } =>
  ({
    key: 'k', kind: 'tool-call', id: 'root', matches: [], start: undefined,
    state: state ?? null!, current: new Map(),
  })

/**
 * Count Map copy constructions inside one callback window by swapping the
 * global: only calls passing existing entries (`new Map(old)`) count. Fresh
 * no-argument Maps are legitimate per-event allocations (every child call
 * view owns two), while copy constructions are the full-state copies a
 * quadratic fold performs per event.
 */
function countMapCopies(window: () => void): number {
  let copies = 0
  const NativeMap = globalThis.Map
  class CountingMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries)
      if (entries != null) copies++
    }
  }
  globalThis.Map = CountingMap as typeof Map
  try {
    window()
  } finally {
    globalThis.Map = NativeMap
  }
  return copies
}

describe('tool dispatch fold performance (high fanout)', () => {
  it('keeps N dispatch-start updates free of full-state Map copies', () => {
    const N = 500
    const startState = toolDefinition.start(
      contextWith(),
      startMatchOf(dispatchStart(1, 'root', 'root:ptc:0')),
      { previous: () => undefined },
    )
    expect(toolDefinition.match(dispatchStart(2, 'root', 'root:ptc:1'))).toEqual({ id: 'root', role: 'update' })

    // Matches and engine contexts are pre-built so per-event PartialArguments
    // construction (which owns two internal Maps per child call view) stays
    // outside the window; it then isolates exactly the state-structure copies
    // the fold itself performs.
    const contexts: ConversationNodeContext<ToolState>[] = []
    const matches: ConversationMatch[] = []
    for (let index = 1; index <= N; index += 1) {
      matches.push(matchOf(dispatchStart(2 + index, 'root', `root:ptc:${index}`)))
      contexts.push(contextWith())
    }

    let state = startState
    const copies = countMapCopies(() => {
      for (const [at, match] of matches.entries()) {
        const next = toolDefinition.update({ ...contexts[at]!, state }, match)
        if (next === undefined) throw new Error('update returned undefined state')
        state = next
      }
    })

    // The quadratic fold copied both Maps per event (2N copies). The in-place
    // fold performs none.
    expect(copies).toBeLessThanOrEqual(N / 5)
  })

  it('keeps 2N mixed start+settle updates within linear time', () => {
    const N = 500
    const startState = toolDefinition.start(
      contextWith(),
      startMatchOf(rootCall(1)),
      { previous: () => undefined },
    )

    let state = startState
    let seq = 1
    const budgetMs = 2_000
    const began = Date.now()
    for (let index = 1; index <= N; index += 1) {
      seq += 1
      state = toolDefinition.update(contextWith(state), matchOf(dispatchStart(seq, 'root', `root:ptc:${index}`)))!
    }
    for (let index = 1; index <= N; index += 1) {
      seq += 1
      state = toolDefinition.update(contextWith(state), matchOf(dispatchSettle(seq, 'root', `root:ptc:${index}`)))!
    }
    const elapsed = Date.now() - began
    expect(elapsed).toBeLessThan(budgetMs)

    // The view projection still reflects every settled subcall in dispatch order.
    const view = toolDefinition.buildViewNode?.(contextWith(state))
    const subCalls = (view?.data as { root: ToolCallBlock }).root.subCalls
    expect(subCalls).toHaveLength(N)
    for (const [index, child] of subCalls.entries()) {
      expect(child.callId).toBe(`root:ptc:${index + 1}`)
      expect('kind' in child && child.kind).toBe('tool-result')
    }
  })
})
