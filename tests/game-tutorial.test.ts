import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ALL_ITEMS, createPuzzleState, DIFFICULTIES, interactPuzzle, randomizeItems, scoreEscape, type ItemId, type PuzzleTarget } from '../src/game/horrorRules'

describe('randomized survival-horror item placement', () => {
  const spots = Array.from({ length: 14 }, (_, i) => new THREE.Vector3((i % 5) * 2, i < 9 ? 0 : 3.8, Math.floor(i / 5) * 2))

  it('places each required item exactly once and deterministically for a seed', () => {
    const a = randomizeItems(84729, spots)
    const b = randomizeItems(84729, spots)
    expect(a.map(x => x.item)).toEqual(ALL_ITEMS)
    expect(new Set(a.map(x => `${x.position.x}:${x.position.y}:${x.position.z}`)).size).toBe(ALL_ITEMS.length)
    expect(a.map(x => x.position.toArray())).toEqual(b.map(x => x.position.toArray()))
  })

  it('moves item locations when the attempt seed changes', () => {
    const a = randomizeItems(1, spots).map(x => x.position.toArray())
    const b = randomizeItems(2, spots).map(x => x.position.toArray())
    expect(a).not.toEqual(b)
  })
})

describe('escape puzzle dependencies', () => {
  it('requires each physical front-exit dependency in order and then completes the main escape', () => {
    let state = createPuzzleState()
    const invoke = (tool: ItemId | null, inventory: ItemId[]) => {
      const result = interactPuzzle(state, 'front-exit', tool, new Set(inventory))
      state = result.state
      return result
    }

    expect(invoke(null, []).message).toMatch(/crowbar/i)
    expect(invoke('crowbar', ['crowbar']).state.frontBoardsPried).toBe(true)
    expect(invoke('hammer', ['hammer']).state.frontBarRemoved).toBe(true)
    expect(invoke('padlock-key', ['padlock-key']).state.frontPadlockOpen).toBe(true)
    expect(invoke('main-key', ['main-key']).state.frontDeadboltOpen).toBe(true)
    const finish = invoke(null, [])
    expect(finish.state.frontDoorOpen).toBe(true)
    expect(finish.openedDoor).toBe('front-exit')
    expect(finish.escaped).toBe('main-door')
  })

  it('requires the basement key, panel tool, both power parts and cut chain for the garage escape', () => {
    let state = createPuzzleState()
    const use = (target: PuzzleTarget, item: ItemId | null, inventory: ItemId[] = item ? [item] : []) => {
      const result = interactPuzzle(state, target, item, new Set(inventory))
      state = result.state
      return result
    }

    expect(use('basement-door', null).state.basementDoorOpen).toBe(false)
    expect(use('basement-door', 'basement-key').openedDoor).toBe('basement-door')
    expect(use('basement-panel', 'screwdriver').state.panelCoverOpen).toBe(true)
    expect(use('basement-panel', 'fuse').state.circuitPowered).toBe(false)
    expect(use('basement-panel', 'battery').state.circuitPowered).toBe(true)
    expect(use('garage-chain', 'pliers').state.garageChainCut).toBe(true)
    const finish = use('garage-exit', null)
    expect(finish.state.garageDoorOpen).toBe(true)
    expect(finish.openedDoor).toBe('garage-exit')
    expect(finish.escaped).toBe('basement-garage')
  })

  it('retains reusable tools and consumes installed fuse and battery only once', () => {
    let state = createPuzzleState()
    const screwdriver = interactPuzzle(state, 'basement-panel', 'screwdriver', new Set(['screwdriver']))
    state = screwdriver.state
    expect(screwdriver.consumed).toEqual([])
    const fuse = interactPuzzle(state, 'basement-panel', 'fuse', new Set(['fuse']))
    state = fuse.state
    expect(fuse.consumed).toEqual(['fuse'])
    const battery = interactPuzzle(state, 'basement-panel', 'battery', new Set(['battery']))
    expect(battery.consumed).toEqual(['battery'])
    expect(DIFFICULTIES.nightmare.chaseSpeed).toBeGreaterThan(DIFFICULTIES.easy.chaseSpeed)
    expect(DIFFICULTIES.nightmare.hearingRadius).toBeGreaterThan(DIFFICULTIES.easy.hearingRadius)
    expect(scoreEscape('nightmare', 180)!).toBeGreaterThan(scoreEscape('easy', 180)!)
  })
})
