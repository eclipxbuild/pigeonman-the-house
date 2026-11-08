import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PigeonAI } from '../src/game/pigeonAI'
import type { NavNode } from '../src/game/houseWorld'
import type { HeardEvent, PigeonAIInput } from '../src/game/pigeonAI'

function graph(): NavNode[] {
  return [
    { id: 'foyer', roomId: 'foyer', position: new THREE.Vector3(0, 0, 0), links: ['hall'] },
    { id: 'hall', roomId: 'hall', position: new THREE.Vector3(4, 0, 0), links: ['foyer', 'bedroom'] },
    { id: 'bedroom', roomId: 'bedroom', position: new THREE.Vector3(8, 0, 0), links: ['hall'] },
  ]
}

function step(x: number, time = 0, source: 'footstep-walk' | 'footstep-run' = 'footstep-walk', strength = 1): HeardEvent {
  return { position: new THREE.Vector3(x, 0, 0), strength, time, source }
}

function input(overrides: Partial<PigeonAIInput> = {}): PigeonAIInput {
  return {
    now: 0,
    dt: 1 / 60,
    enemyPosition: new THREE.Vector3(0, 0, 0),
    hidden: false,
    difficulty: 'normal',
    heard: [],
    ...overrides,
  }
}

describe('Pigeonman footsteps-only perception and route planner', () => {
  it('does not react to voice, dropped-object, light, door, or pickup events', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    const nonSteps: HeardEvent[] = ['voice', 'dropped-tool', 'switch', 'door', 'pickup'].map(source => ({
      position: new THREE.Vector3(8, 0, 0), strength: 5, time: 0, source,
    }))
    const result = ai.update(input({ heard: nonSteps }))
    expect(result.state).toBe('PATROL')
    expect(result.caught).toBe(false)
  })

  it('investigates standing footsteps and follows their most recent position by graph hops', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    const first = ai.update(input({ heard: [step(8)] }))
    expect(first.state).toBe('INVESTIGATE')
    expect(first.targetNodeId).toBe('hall')
    const second = ai.update(input({
      now: 0.6,
      enemyPosition: new THREE.Vector3(4, 0, 0),
      heard: [step(8.5, 0.6)],
    }))
    expect(second.state).toBe('INVESTIGATE')
    expect(second.targetNodeId).toBe('bedroom')
  })

  it('enters CHASE only when it hears running footsteps', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    const result = ai.update(input({ heard: [step(8, 0, 'footstep-run', 1.2)] }))
    expect(result.state).toBe('CHASE')
    expect(result.targetNodeId).toBe('hall')
    expect(result.speed).toBeGreaterThan(2.75)
  })

  it('catches only on a fresh nearby audible footstep', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    const result = ai.update(input({ enemyPosition: new THREE.Vector3(0, 0, 0), heard: [step(1)] }))
    expect(result.state).toBe('ATTACK')
    expect(result.caught).toBe(true)
  })

  it('cannot catch a crouching or hidden player from silence', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    const result = ai.update(input({ hidden: true, heard: [step(1)] }))
    expect(result.state).toBe('INVESTIGATE')
    expect(result.caught).toBe(false)
  })

  it('searches the last audible room after footsteps stop, then returns to patrol', () => {
    const ai = new PigeonAI(graph(), 'foyer')
    ai.update(input({ heard: [step(8)] }))
    const search = ai.update(input({ now: 3, enemyPosition: new THREE.Vector3(8, 0, 0) }))
    expect(search.state).toBe('SEARCH')
    expect(search.targetNodeId).toBe('hall')
    const returned = ai.update(input({ now: 13, enemyPosition: new THREE.Vector3(4, 0, 0) }))
    expect(returned.state).toBe('RETURN')
    expect(returned.targetNodeId).toBe('foyer')
  })

  it('uses difficulty to scale patrol speed from Easy to Nightmare', () => {
    const speeds = (['easy', 'normal', 'hard', 'nightmare'] as const).map(difficulty =>
      new PigeonAI(graph(), 'foyer').update(input({ difficulty })).speed,
    )
    expect(speeds[0]).toBeLessThan(speeds[1])
    expect(speeds[1]).toBeLessThan(speeds[2])
    expect(speeds[2]).toBeLessThan(speeds[3])
  })

  it('does not invent a route through an unlinked wall when following a footstep', () => {
    const nodes: NavNode[] = [
      { id: 'foyer', roomId: 'foyer', position: new THREE.Vector3(0, 0, 0), links: [] },
      { id: 'bedroom', roomId: 'bedroom', position: new THREE.Vector3(8, 0, 0), links: [] },
    ]
    const result = new PigeonAI(nodes, 'foyer').update(input({ heard: [step(8)] }))
    expect(result.state).toBe('INVESTIGATE')
    expect(result.targetNodeId).toBe('foyer')
  })
})
