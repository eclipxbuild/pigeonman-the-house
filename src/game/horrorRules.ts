import * as THREE from 'three'

export type Difficulty = 'easy' | 'normal' | 'hard' | 'nightmare'
export type ItemId = 'main-key' | 'padlock-key' | 'hammer' | 'pliers' | 'screwdriver' | 'battery' | 'fuse' | 'crowbar' | 'basement-key'
export type PuzzleTarget = 'front-exit' | 'basement-door' | 'secret-passage' | 'basement-panel' | 'garage-chain' | 'garage-exit'
export type EscapeRoute = 'main-door' | 'basement-garage'
export type PuzzleState = {
  frontBoardsPried: boolean
  frontBarRemoved: boolean
  frontPadlockOpen: boolean
  frontDeadboltOpen: boolean
  frontDoorOpen: boolean
  basementDoorOpen: boolean
  secretPassageOpen: boolean
  panelCoverOpen: boolean
  fuseInstalled: boolean
  batteryInstalled: boolean
  circuitPowered: boolean
  garageChainCut: boolean
  garageDoorOpen: boolean
}
export type PuzzleResolution = {
  state: PuzzleState
  message: string
  consumed: ItemId[]
  openedDoor?: string
  escaped?: EscapeRoute
}
export type DifficultyProfile = {
  chaseSpeed: number
  patrolSpeed: number
  hearingRadius: number
  visionRange: number
  searchSeconds: number
  visionAngle: number
  puzzleHint: string
}

export const DIFFICULTIES: Record<Difficulty, DifficultyProfile> = {
  easy: { chaseSpeed: 2.55, patrolSpeed: 0.8, hearingRadius: 5.8, visionRange: 8.5, searchSeconds: 7, visionAngle: 0.8, puzzleHint: 'Pigeonman moves slowly and reacts only to nearby sounds.' },
  normal: { chaseSpeed: 3.45, patrolSpeed: 1.08, hearingRadius: 8, visionRange: 11, searchSeconds: 10, visionAngle: 1.05, puzzleHint: 'A balanced hunt. Keep your distance and watch your noise.' },
  hard: { chaseSpeed: 4.2, patrolSpeed: 1.35, hearingRadius: 10, visionRange: 13, searchSeconds: 14, visionAngle: 1.25, puzzleHint: 'He hears farther away and searches longer when you vanish.' },
  nightmare: { chaseSpeed: 5.05, patrolSpeed: 1.7, hearingRadius: 12.5, visionRange: 15, searchSeconds: 18, visionAngle: 1.5, puzzleHint: 'Very fast patrols, long searches and the smallest window to hide.' },
}

export const ITEM_INFO: Record<ItemId, { name: string; detail: string; symbol: string }> = {
  'main-key': { name: 'Front Door Key', detail: 'A tarnished key for the final front-door deadbolt.', symbol: '⌑' },
  'padlock-key': { name: 'Padlock Key', detail: 'A small iron key, worn around the teeth.', symbol: '⚿' },
  hammer: { name: 'Hammer', detail: 'Heavy claw hammer. Good for driven nails and weak plaster.', symbol: '⌁' },
  pliers: { name: 'Pliers', detail: 'Long-nose pliers, rusted but still biting.', symbol: '⌗' },
  screwdriver: { name: 'Screwdriver', detail: 'An old flat-head driver for the basement electrical panel.', symbol: '⊢' },
  battery: { name: 'Battery', detail: 'A heavy rechargeable cell. It can feed the garage circuit once.', symbol: '▣' },
  fuse: { name: 'Fuse', detail: 'A porcelain fuse. One circuit still needs it.', symbol: '▤' },
  crowbar: { name: 'Crowbar', detail: 'A scarred crowbar. Leverage will peel away the front boards.', symbol: '⌟' },
  'basement-key': { name: 'Basement Key', detail: 'A thick black key for the locked stair door.', symbol: '⌘' },
}
export const ALL_ITEMS = Object.keys(ITEM_INFO) as ItemId[]

export function createPuzzleState(): PuzzleState {
  return {
    frontBoardsPried: false,
    frontBarRemoved: false,
    frontPadlockOpen: false,
    frontDeadboltOpen: false,
    frontDoorOpen: false,
    basementDoorOpen: false,
    secretPassageOpen: false,
    panelCoverOpen: false,
    fuseInstalled: false,
    batteryInstalled: false,
    circuitPowered: false,
    garageChainCut: false,
    garageDoorOpen: false,
  }
}

/** Deterministically shuffle valid ground-floor spots once per attempt. */
export function randomizeItems(seed: number, spots: THREE.Vector3[]): Array<{ item: ItemId; position: THREE.Vector3 }> {
  if (spots.length < ALL_ITEMS.length) throw new Error(`Need at least ${ALL_ITEMS.length} accessible item spots`)
  let state = (seed >>> 0) || 0x9e3779b9
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  const indices = spots.map((_, i) => i)
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return ALL_ITEMS.map((item, i) => ({ item, position: spots[indices[i]].clone() }))
}

/** Pure puzzle resolver: only returns state changes and item consumption; gameplay applies them. */
export function interactPuzzle(
  oldState: PuzzleState,
  target: PuzzleTarget,
  selected: ItemId | null,
  inventory: ReadonlySet<ItemId>,
): PuzzleResolution {
  const state = { ...oldState }
  const use = (expected: ItemId) => selected === null ? inventory.has(expected) : selected === expected && inventory.has(expected)
  const consume = (expected: ItemId, message: string): PuzzleResolution => ({ state, message, consumed: [expected] })
  switch (target) {
    case 'front-exit':
      if (!state.frontBoardsPried) {
        if (!use('crowbar')) return { state, consumed: [], message: 'Boards seal the door. A crowbar could lift them.' }
        state.frontBoardsPried = true
        return { state, consumed: [], message: 'The crowbar shrieks against the boards. One layer gives way.' }
      }
      if (!state.frontBarRemoved) {
        if (!use('hammer')) return { state, consumed: [], message: 'A crossbar is nailed in place. You need a hammer.' }
        state.frontBarRemoved = true
        return { state, consumed: [], message: 'The hammer splits the nailed bar. The front door shudders.' }
      }
      if (!state.frontPadlockOpen) {
        if (!use('padlock-key')) return { state, consumed: [], message: 'A heavy padlock hangs from the chain.' }
        state.frontPadlockOpen = true
        return { state, consumed: [], message: 'The padlock clicks open.' }
      }
      if (!state.frontDeadboltOpen) {
        if (!use('main-key')) return { state, consumed: [], message: 'The deadbolt is still locked. The front-door key may fit.' }
        state.frontDeadboltOpen = true
        return { state, consumed: [], message: 'The deadbolt turns. One last shove will open the door.' }
      }
      state.frontDoorOpen = true
      return { state, consumed: [], message: 'The front door groans open. Cold air spills in.', openedDoor: 'front-exit', escaped: 'main-door' }
    case 'basement-door':
      if (state.basementDoorOpen) return { state, consumed: [], message: 'The basement stair door stands open.' }
      if (!use('basement-key')) return { state, consumed: [], message: 'The basement door is locked. Find its black key.' }
      state.basementDoorOpen = true
      return { state, consumed: [], message: 'The lock turns. A dark stairway drops below the house.', openedDoor: 'basement-door' }
    case 'secret-passage':
      if (state.secretPassageOpen) return { state, consumed: [], message: 'The narrow passage is open.' }
      if (!use('hammer')) return { state, consumed: [], message: 'The hidden panel is nailed shut. A hammer might break its brittle frame.' }
      state.secretPassageOpen = true
      return { state, message: 'Plaster cracks; a narrow passage opens behind the bookcase.', consumed: [], openedDoor: 'secret-passage' }
    case 'basement-panel':
      if (!state.panelCoverOpen) {
        if (!use('screwdriver')) return { state, consumed: [], message: 'The basement power panel is screwed closed.' }
        state.panelCoverOpen = true
        return { state, consumed: [], message: 'You unscrew the panel. Two empty sockets wait inside.' }
      }
      if (!state.fuseInstalled && use('fuse')) {
        state.fuseInstalled = true
        state.circuitPowered = state.batteryInstalled
        return consume('fuse', state.circuitPowered ? 'The fuse seats with a snap.' : 'The fuse clicks in. The panel still needs a battery.')
      }
      if (!state.batteryInstalled && use('battery')) {
        state.batteryInstalled = true
        state.circuitPowered = state.fuseInstalled
        return consume('battery', state.circuitPowered ? 'The relay hums awake. Basement lights flicker on.' : 'The battery slots in. A fuse is still missing.')
      }
      return { state, consumed: [], message: state.circuitPowered ? 'The garage circuit is live.' : 'Two sockets remain: a fuse and a battery.' }
    case 'garage-chain':
      if (state.garageChainCut) return { state, consumed: [], message: 'The garage chain has already been cut.' }
      if (!use('pliers')) return { state, consumed: [], message: 'A thick chain binds the garage shutter. Pliers could sever it.' }
      state.garageChainCut = true
      return { state, consumed: [], message: 'The pliers bite through the chain with a sharp metallic snap.' }
    case 'garage-exit':
      if (!state.circuitPowered) return { state, consumed: [], message: 'The garage shutter motor is dead. Restore power in the basement.' }
      if (!state.garageChainCut) return { state, consumed: [], message: 'The shutter is powered but still chained shut.' }
      state.garageDoorOpen = true
      return { state, consumed: [], message: 'The garage shutter rattles upward. Night air waits beyond.', openedDoor: 'garage-exit', escaped: 'basement-garage' }
  }
}

export function scoreEscape(difficulty: Difficulty, elapsedSeconds: number): number {
  const tier: Record<Difficulty, number> = { easy: 0, normal: 1, hard: 2, nightmare: 3 }
  const safeElapsed = Math.max(0, Math.min(1800, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 1800))
  const timeBonus = Math.max(0, 1800 - Math.round(safeElapsed)) * 100
  return Math.min(1_000_000, tier[difficulty] * 200_000 + timeBonus)
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}
