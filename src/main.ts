import './styles/main.css'
import * as THREE from 'three'
import { Renderer, suggestQuality } from './engine/renderer'
import { GameLoop } from './engine/loop'
import { Input } from './engine/input'
import { Assets } from './engine/assets'
import { initPhysics } from './engine/physics'
import { SAVE_KEY, SaveStore, insertScore } from './engine/save'
import { HorrorAudio } from './game/horrorAudio'
import { CONFIG } from './game/config'
import { tuning } from './game/tuning'
import { Game, type EscapeResult, type HorrorSave } from './game/game'
import { HorrorUI, type BoardEntry, type Difficulty, type HorrorSettings as UISettings, type ResultState } from './ui/horror-ui'
import { ManusAuth, type ManusSession } from '../manus-auth.js'
import { createLeaderboardClient, type RunTicket } from '../leaderboard.js'

const MODEL_URL = '/manus-storage/game/sha256/029ba27d449a1b521e10f01b632d0f731909cadd838be894c9cfa708ca3fd166.glb'
const BOARD_ID = 'escape-score-v1'
const RULES_VERSION = 'v1'
const RESUME_KEY = 'pigeonhouse.resume.v1'
const DIFFICULTY_KEY = 'pigeonhouse.difficulty.v1'

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* Private storage must not prevent a playable run. */ }
}
function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard' || value === 'nightmare'
}
function loadResume(): HorrorSave | null {
  try {
    const raw = safeGet(RESUME_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const save = parsed as Partial<HorrorSave>
    if (save.version !== 1 || !Number.isInteger(save.seed) || !isDifficulty(save.difficulty) || !Number.isFinite(save.elapsed) || !Array.isArray(save.position) || save.position.length !== 3 || !save.position.every(Number.isFinite) || !Array.isArray(save.inventory) || !Array.isArray(save.picked) || !Array.isArray(save.drops) || !save.puzzle) return null
    return save as HorrorSave
  } catch { return null }
}
function difficultySetting(): Difficulty {
  const value = safeGet(DIFFICULTY_KEY)
  return isDifficulty(value) ? value : 'normal'
}
function secondsFromClock(value: string): number {
  const [minutes = '0', seconds = '0'] = value.split(':')
  return Math.max(0, Number(minutes) * 60 + Number(seconds))
}
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(null), milliseconds)
    promise.then(value => { window.clearTimeout(timer); resolve(value) }, () => { window.clearTimeout(timer); resolve(null) })
  })
}
function makeProceduralPigeonman(): THREE.Group {
  const root = new THREE.Group()
  const charcoal = new THREE.MeshStandardMaterial({ color: 0x333a3d, roughness: .82 })
  const wing = new THREE.MeshStandardMaterial({ color: 0x252c30, roughness: .88 })
  const beakMat = new THREE.MeshStandardMaterial({ color: 0xb78945, roughness: .52, metalness: .15 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xb32720, emissive: 0x390600, emissiveIntensity: .8, roughness: .25 })
  const bone = (geometry: THREE.BufferGeometry, material: THREE.Material, pos: [number, number, number], scale?: [number, number, number]): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...pos)
    if (scale) mesh.scale.set(...scale)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.pigeonman = true
    root.add(mesh)
    return mesh
  }
  bone(new THREE.SphereGeometry(.48, 20, 16), charcoal, [0, 1.06, 0], [1, 1.42, .78])
  bone(new THREE.SphereGeometry(.42, 20, 16), wing, [0, 2.04, -.015], [1, .92, .93])
  bone(new THREE.ConeGeometry(.18, .42, 6), beakMat, [0, 1.99, -.44]).rotation.x = -Math.PI / 2
  bone(new THREE.SphereGeometry(.055, 12, 8), eyeMat, [-.21, 2.13, -.35])
  bone(new THREE.SphereGeometry(.055, 12, 8), eyeMat, [.21, 2.13, -.35])
  bone(new THREE.SphereGeometry(.43, 16, 12), wing, [-.48, 1.14, .02], [.38, .86, .55]).rotation.z = .16
  bone(new THREE.SphereGeometry(.43, 16, 12), wing, [.48, 1.14, .02], [.38, .86, .55]).rotation.z = -.16
  const leg = new THREE.CylinderGeometry(.065, .045, .66, 8)
  bone(leg, beakMat, [-.18, .34, 0])
  bone(leg, beakMat, [.18, .34, 0])
  bone(new THREE.ConeGeometry(.14, .3, 5), beakMat, [-.18, .055, -.07]).rotation.x = -Math.PI / 2
  bone(new THREE.ConeGeometry(.14, .3, 5), beakMat, [.18, .055, -.07]).rotation.x = -Math.PI / 2
  return root
}

async function boot(): Promise<void> {
  document.documentElement.lang = 'en'
  const canvas = document.querySelector<HTMLCanvasElement>('#game')
  const uiRoot = document.getElementById('ui')
  if (!canvas || !uiRoot) throw new Error('The game canvas or UI mount is missing.')

  const save = new SaveStore()
  const firstRun = safeGet(SAVE_KEY) === null
  let selectedDifficulty = difficultySetting()
  let authSession: ManusSession = { status: 'offline', user: null }
  let game: Game | undefined
  let loop: GameLoop | undefined
  let renderer: Renderer | undefined
  let resumeSave = loadResume()
  let attemptSerial = 0
  let settledSerial = -1
  let ticketPromise: Promise<RunTicket | null> | null = null
  let retrySubmission: { ticket: RunTicket; score: number; durationMs: number; result: EscapeResult; serial: number } | null = null
  let onlineStatus = 'No ranked ticket for this attempt.'

  const input = new Input(canvas)
  const audio = new HorrorAudio()
  const ui = new HorrorUI(uiRoot, {
    start: () => startNewAttempt(),
    continueRun: () => continueAttempt(),
    resume: () => resumeGame(),
    restart: () => startNewAttempt(),
    quit: () => returnToTitle(),
    pause: () => pauseGame(),
    difficulty: diff => { selectedDifficulty = diff; safeSet(DIFFICULTY_KEY, diff); refreshTitle() },
    settings: patch => applySettings(patch),
    interact: () => undefined,
    selectItem: name => { if (!game?.selectItem(name)) ui.notify('That item is not in your inventory.', 'error') },
    howTo: () => undefined,
    back: () => goBack(),
    signIn: () => signIn(),
    signOut: () => signOut(),
    leaderboard: () => loadLeaderboard(),
    retrySubmission: () => resendResult(),
  })
  const leaderboard = createLeaderboardClient({ identity: 'account', boardId: BOARD_ID, rulesVersion: RULES_VERSION, auth: ManusAuth })
  const currentSettings = (): UISettings => ({ musicVolume: save.data.musicVolume, sfxVolume: save.data.sfxVolume, sensitivity: save.data.sensitivity, quality: save.data.quality, muted: save.data.muted, invertY: save.data.invertY, reducedMotion: save.data.reducedMotion })
  const authLabel = (): string => authSession.status === 'authenticated'
    ? `Signed in · ${authSession.user.name || 'Player'}`
    : authSession.status === 'offline' ? 'Offline play · account optional' : 'Signed out · account optional'
  const localBest = (): string => {
    const best = save.data.leaderboard[0]
    return best ? `LOCAL BEST  ${clock(best.seconds)} · ${best.score.toLocaleString()} pts` : 'LOCAL RECORD  —'
  }
  function refreshTitle(): void {
    ui.title({ continueAvailable: !!resumeSave, difficulty: selectedDifficulty, authLabel: authLabel(), localBest: localBest() })
  }
  function applySettings(patch?: Partial<UISettings>): void {
    const oldQuality = save.data.quality
    if (patch) save.update(patch)
    input.sensitivity = save.data.sensitivity
    input.invertY = save.data.invertY
    audio.setLevels(save.data.sfxVolume, save.data.musicVolume, save.data.muted)
    document.documentElement.toggleAttribute('data-reduced-motion', save.data.reducedMotion)
    if (game && patch?.quality !== undefined && oldQuality !== save.data.quality) game.setQuality(save.data.quality)
    if (game) game.setSettings({ fov: CONFIG.camera.fov, flashlightDrain: CONFIG.horror.flashlightDrain })
    else if (renderer && patch?.quality !== undefined && oldQuality !== save.data.quality) renderer.applyQuality(save.data.quality)
    ui.setSettings(currentSettings())
  }
  function saveCurrentRun(snapshot = game?.snapshot() ?? null): void {
    if (!snapshot) { resumeSave = null; safeSet(RESUME_KEY, null); refreshTitle(); return }
    resumeSave = snapshot
    safeSet(RESUME_KEY, JSON.stringify(snapshot))
    if (game?.mode === 'title') refreshTitle()
  }
  function resetLoop(): void {
    if (!loop) return
    loop.resetAccumulator()
    loop.paused = false
  }
  async function issueRankedTicket(serial: number): Promise<RunTicket | null> {
    onlineStatus = 'Checking signed-in account…'
    const holder: { request: Promise<Awaited<ReturnType<typeof leaderboard.beginRun>>> | null } = { request: null }
    const authTask = ManusAuth.startGame(state => {
      authSession = state
      ui.setAuth(authLabel())
      if (state.status === 'authenticated' && attemptSerial === serial && game?.mode === 'playing' && game.debugState().elapsed <= 4) {
        holder.request = leaderboard.beginRun()
      }
    })
    const session = await withTimeout(authTask, 5000)
    if (serial !== attemptSerial) return null
    if (!session) { onlineStatus = 'Account check timed out — this attempt stays playable offline.'; return null }
    authSession = session
    ui.setAuth(authLabel())
    if (!holder.request) {
      onlineStatus = session.status === 'authenticated'
        ? 'No ranked ticket — account check finished too late for this run.'
        : session.status === 'offline' ? 'Offline leaderboard unavailable in this preview.' : 'Offline play — sign in before a new attempt for a ranked run.'
      return null
    }
    const result = await withTimeout(holder.request, 5000)
    if (serial !== attemptSerial) return null
    if (!result) { onlineStatus = 'Ticket request timed out — this attempt continues offline.'; return null }
    if (!result.ok) { onlineStatus = `Ticket unavailable: ${result.error}`; return null }
    onlineStatus = 'Ready for account leaderboard'
    return result.value
  }
  function beginRun(mode: 'new' | 'continue'): void {
    if (!game) return
    audio.unlock()
    input.lockPointer()
    settledSerial = -1
    retrySubmission = null
    ticketPromise = null
    attemptSerial += 1
    const serial = attemptSerial
    if (mode === 'new') {
      game.startAttempt(selectedDifficulty)
      // Start immediately. OAuth and the score API run beside gameplay and may fail harmlessly.
      ticketPromise = issueRankedTicket(serial)
      void ticketPromise.then(ticket => { if (ticket && attemptSerial === serial) onlineStatus = 'Ready for account leaderboard' })
    } else {
      const saved = resumeSave
      if (!saved || !game.continueAttempt(saved)) {
        saveCurrentRun(null)
        ui.notify('No valid attempt can be continued.', 'error')
        input.unlockPointer()
        return
      }
      selectedDifficulty = saved.difficulty
      safeSet(DIFFICULTY_KEY, selectedDifficulty)
      onlineStatus = 'Continued locally — this resumed run has no ranked ticket.'
      ticketPromise = Promise.resolve(null)
    }
    ui.show('hud')
    resetLoop()
    refreshTitle()
  }
  function startNewAttempt(): void { beginRun('new') }
  function continueAttempt(): void { beginRun('continue') }
  function pauseGame(): void {
    if (!game || game.mode !== 'playing') return
    game.pause()
    saveCurrentRun()
    input.unlockPointer()
    ui.show('pause')
    if (loop) loop.paused = true
  }
  function resumeGame(): void {
    if (!game || game.mode !== 'paused') return
    audio.unlock()
    game.resume()
    ui.show('hud')
    input.lockPointer()
    resetLoop()
  }
  function returnToTitle(): void {
    if (!game) { refreshTitle(); ui.show('title'); return }
    if (game.mode === 'playing' || game.mode === 'paused') saveCurrentRun(game.snapshot())
    game.toTitle()
    if (loop) { loop.paused = false; loop.resetAccumulator() }
    input.unlockPointer()
    audio.update(0, { enemyDistance: 100, chasing: false, paused: true, hidden: false })
    refreshTitle()
    ui.show('title')
  }
  function goBack(): void {
    if (ui.screen === 'pause' && game?.mode === 'paused') { resumeGame(); return }
    if (game?.mode === 'paused') { ui.show('pause'); return }
    refreshTitle()
    ui.show('title')
  }
  function signIn(): void {
    // Direct call from the user's button gesture; embedded auth opens standalone as designed.
    void ManusAuth.login().then(() => ManusAuth.prepare()).then(state => { authSession = state; ui.setAuth(authLabel()); refreshTitle() }).catch(error => ui.notify(`Sign in unavailable: ${error instanceof Error ? error.message : 'try again later'}`, 'error'))
  }
  function signOut(): void {
    void ManusAuth.logout().then(state => { authSession = state; ui.setAuth(authLabel()); refreshTitle() }).catch(error => ui.notify(`Sign out unavailable: ${error instanceof Error ? error.message : 'try again later'}`, 'error'))
  }
  function loadLeaderboard(): void {
    ui.showLeaderboard([], 'Loading account leaderboard…')
    void leaderboard.list(20).then(result => {
      if (!result.ok) { ui.showLeaderboard([], `Leaderboard unavailable: ${result.error}`); return }
      const entries: BoardEntry[] = result.value.entries.map(entry => ({ displayName: entry.displayName, score: entry.score, rank: entry.rank, achievedAt: entry.achievedAt }))
      ui.showLeaderboard(entries, entries.length ? 'Account results · client-reported casual rankings' : 'No completed runs yet. Start a new attempt while signed in to be listed.')
    }).catch(error => ui.showLeaderboard([], `Leaderboard unavailable: ${error instanceof Error ? error.message : 'network error'}`))
  }
  function showVictory(result: EscapeResult, status: string): void {
    const view: ResultState = { route: result.route === 'main-door' ? 'Main door' : 'Basement / garage', elapsed: result.elapsed, difficulty: result.difficulty, score: result.score, onlineStatus: status }
    ui.showVictory(view)
  }
  function updateVictoryIfVisible(result: EscapeResult, status: string, serial: number): void {
    if (attemptSerial === serial && ui.screen === 'victory') showVictory(result, status)
  }
  function handleVictory(result: EscapeResult): void {
    if (settledSerial === attemptSerial) return
    settledSerial = attemptSerial
    saveCurrentRun(null)
    if (!result.unranked) {
      const entry = { name: authSession.status === 'authenticated' ? authSession.user.name || save.data.playerName : save.data.playerName, score: result.score, seconds: result.elapsed, at: Date.now() }
      const next = insertScore(save.data.leaderboard, entry)
      save.update({ leaderboard: next.board })
    }
    const serial = attemptSerial
    const status = result.unranked ? 'Unranked — preview Tweak changed gameplay rules.' : 'Submission pending…'
    showVictory(result, status)
    refreshTitle()
    if (result.unranked) return
    const queued = ticketPromise ?? Promise.resolve(null)
    void queued.then(ticket => {
      if (!ticket || attemptSerial !== serial) {
        updateVictoryIfVisible(result, onlineStatus || 'No ranked ticket for this attempt.', serial)
        return
      }
      const durationMs = Math.max(1000, Math.min(1_800_000, Math.round(result.elapsed * 1000)))
      retrySubmission = { ticket, score: result.score, durationMs, result, serial }
      return leaderboard.submitRun(ticket, result.score, durationMs).then(response => {
        if (attemptSerial !== serial) return
        if (response.ok) {
          retrySubmission = null
          onlineStatus = response.value.receipt.accepted ? 'Submitted · account leaderboard (client-reported)' : 'Run received; leaderboard refresh is pending.'
        } else onlineStatus = `Submission failed: ${response.error}`
        updateVictoryIfVisible(result, onlineStatus, serial)
      })
    }).catch(error => {
      if (attemptSerial !== serial) return
      onlineStatus = `Submission failed: ${error instanceof Error ? error.message : 'network error'}`
      updateVictoryIfVisible(result, onlineStatus, serial)
    })
  }
  function resendResult(): void {
    const pending = retrySubmission
    if (!pending || attemptSerial !== pending.serial) { ui.notify('There is no pending account submission to retry.', 'error'); return }
    onlineStatus = 'Retry pending…'
    showVictory(pending.result, onlineStatus)
    void leaderboard.retryRun(pending.ticket).then(response => {
      if (attemptSerial !== pending.serial) return
      if (response.ok) { retrySubmission = null; onlineStatus = 'Submitted · account leaderboard (client-reported)' }
      else onlineStatus = `Submission failed: ${response.error}`
      updateVictoryIfVisible(pending.result, onlineStatus, pending.serial)
    }).catch(error => {
      if (attemptSerial !== pending.serial) return
      onlineStatus = `Submission failed: ${error instanceof Error ? error.message : 'network error'}`
      updateVictoryIfVisible(pending.result, onlineStatus, pending.serial)
    })
  }

  ui.setBootProgress(.06, 'The house is listening…')
  ui.setSettings(currentSettings())
  refreshTitle()
  window.addEventListener('manus-auth-change', event => {
    authSession = event.detail
    ui.setAuth(authLabel())
    refreshTitle()
  })
  // Startup auth is intentionally fire-and-forget: local play never waits on OAuth or network.
  void ManusAuth.prepare().then(state => { authSession = state; ui.setAuth(authLabel()); refreshTitle() }).catch(() => {
    authSession = { status: 'offline', user: null }
    ui.setAuth(authLabel())
  })

  const assets = new Assets()
  assets.onProgress(progress => ui.setBootProgress(.12 + progress * .43, 'Waking Pigeonman…'))
  await Promise.all([initPhysics(), document.fonts.ready])
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.setSettings(currentSettings())
  }
  renderer = new Renderer(canvas, save.data.quality)
  let pigeonTemplate: THREE.Object3D
  try { pigeonTemplate = (await assets.gltf(MODEL_URL)).scene }
  catch (error) {
    console.warn('Pigeonman GLB could not be loaded; using the procedural pigeon fallback.', error)
    pigeonTemplate = makeProceduralPigeonman()
    ui.notify('Using the built-in Pigeonman fallback; the generated model could not be reached.', 'error')
  }
  ui.setBootProgress(.7, 'The locks are settling…')
  game = new Game(renderer, input, audio, pigeonTemplate, {
    onSave: snapshot => saveCurrentRun(snapshot),
    onCaught: reason => { saveCurrentRun(null); input.unlockPointer(); ui.showCaught(reason) },
    onJumpscare: active => ui.setJumpscare(active),
    onVictory: result => { input.unlockPointer(); handleVictory(result) },
    onMessage: message => ui.notify(message),
  })
  applySettings()
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning: gameTuning }] = await Promise.all([
      import('../scripts/manus-tuning/adapter.js'), import('./game/tuning'),
    ])
    await registerGameTuning(gameTuning)
  }
  loop = new GameLoop({
    beforeFrame: frameSeconds => input.update(frameSeconds),
    step: dt => game?.step(dt),
    render: (alpha, frameSeconds) => {
      ui.frame(frameSeconds)
      if (game) {
        game.render(alpha, frameSeconds)
        if (game.mode === 'playing' || game.mode === 'caught' || game.mode === 'escaped') {
          const h = game.hud()
          ui.updateHud({ prompt: h.prompt, enemyState: h.state, inventory: h.inventory.map(item => item.label), selectedItem: h.inventory.find(item => item.selected)?.label ?? null, stamina: h.stamina, flashlight: h.battery, flashlightOn: h.flashlight, elapsed: secondsFromClock(h.elapsed), hidden: h.hidden, message: '', chase: h.chase, heartbeat: h.heartbeat, difficulty: h.difficulty })
        }
        loop!.paused = game.mode === 'paused'
      }
      input.endFrame()
    },
  })
  loop.start()
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && game?.mode === 'playing' && input.method === 'keyboard') pauseGame()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game?.mode === 'playing') pauseGame()
      else if (game?.mode === 'paused') saveCurrentRun()
    }
  })
  window.addEventListener('pagehide', () => { if (game?.mode === 'playing' || game?.mode === 'paused') saveCurrentRun(game.snapshot()) })
  window.addEventListener('game:pause', pauseGame)
  canvas.addEventListener('click', () => { if (game?.mode === 'playing' && !document.pointerLockElement) input.lockPointer() })
  const saveTimer = window.setInterval(() => { if (game?.mode === 'playing' || game?.mode === 'paused') saveCurrentRun(game.snapshot()) }, 5000)
  window.addEventListener('beforeunload', () => { window.clearInterval(saveTimer); input.dispose(); audio.stop() }, { once: true })
  ui.setBootProgress(1, 'The house is waiting.')
  refreshTitle()
  window.setTimeout(() => { if (ui.screen === 'boot') ui.show('title') }, 250)
  ;(window as unknown as { __game: unknown }).__game = { game, ui, input, save, tuning }
}

boot().catch(error => {
  console.error(error)
  const root = document.getElementById('ui')
  if (root) root.innerHTML = `<div class="fatal">Failed to start: ${String((error as Error)?.message ?? error).replace(/[<>&]/g, '')}</div>`
})
