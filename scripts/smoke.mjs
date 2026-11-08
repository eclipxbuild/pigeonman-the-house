// Local browser smoke for the browser-based survival-horror game.
// Uses local copies of registered CDN media for deterministic offline preview.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = process.cwd()
const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = resolve(process.env.SHOTS_DIR ?? '/tmp/pigeonhouse-smoke')
mkdirSync(out, { recursive: true })
const modelFile = resolve(root, 'assets/models/pigeonman-rigged.glb')
const iconFile = resolve(root, 'assets/share/favicon-512.png')
const coverFile = resolve(root, 'assets/share/og.png')
if (!existsSync(modelFile) || !existsSync(iconFile) || !existsSync(coverFile)) throw new Error('Build asset restore must complete before smoke test')

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore', detached: false })
let browser
const errors = []
const guard = setTimeout(() => fail('overall watchdog expired after 240 seconds'), 240_000)

async function cleanup() {
  clearTimeout(guard)
  await browser?.close().catch(() => {})
  try { server.kill('SIGTERM') } catch {}
}
async function fail(message) {
  console.error(`smoke: FAIL — ${message}`)
  await cleanup()
  process.exit(1)
}
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('preview server did not start')
}
function positionDistance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }

async function useAt(page, position, item = null) {
  await page.evaluate(({ position, item }) => {
    const game = window.__game.game
    game.hiddenSpot = null
    game.crouched = false
    game.playerBody.setTranslation({ x: position[0], y: position[1], z: position[2] }, true)
    game.lastY = position[1]
    if (item && !game.selectItem(item)) throw new Error(`Fixture is missing ${item}`)
  }, { position, item })
  await page.keyboard.press('e')
  await page.waitForTimeout(150)
}

try {
  await waitForServer()
  const launchOptions = { args: ['--ignore-gpu-blocklist', '--use-gl=swiftshader', '--disable-dev-shm-usage'] }
  if (process.env.CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE
  browser = await chromium.launch(launchOptions).catch(() => chromium.launch({ args: ['--ignore-gpu-blocklist'], channel: 'chrome' }))
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('/api/')) errors.push(message.text()) })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) errors.push(`HTTP ${response.status()} ${response.url()}`) })
  await page.route('**/manus-storage/game/sha256/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.glb')) return route.fulfill({ path: modelFile })
    if (path.endsWith('339bdc0c96e0842fd98d81a618eff74720fe1b4022537bb991847da660be987f.png')) return route.fulfill({ path: coverFile })
    if (path.endsWith('.png')) return route.fulfill({ path: iconFile })
    return route.continue()
  })
  await page.goto(url)
  await page.locator('.ph-loader-cover').waitFor({ timeout: 10_000 })
  const loaderArt = await page.locator('.ph-loader-cover').evaluate(image => ({ src: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit }))
  if (!loaderArt.src?.includes('339bdc0c96e0842fd98d81a618eff74720fe1b4022537bb991847da660be987f') || loaderArt.width !== 2560 || loaderArt.height !== 1440 || loaderArt.fit !== 'cover') throw new Error(`Loading screen is not showing the supplied OG artwork: ${JSON.stringify(loaderArt)}`)
  await page.screenshot({ path: `${out}/00-loading.png` })
  await page.waitForSelector('[data-screen="title"].is-active', { timeout: 30_000 })
  await page.screenshot({ path: `${out}/01-title.png` })

  // Verify the visible menus, persistent difficulty and settings.
  await page.locator('#ph-difficulty').selectOption('easy')
  await page.click('[data-action="howto"]')
  await page.waitForSelector('[data-screen="howto"].is-active')
  if (!await page.locator('[data-screen="howto"]').innerText().then(text => text.includes('Basement Service Exit'))) throw new Error('How to Play is missing the exit instructions')
  await page.click('[data-screen="howto"] [data-action="back"]')
  await page.waitForSelector('[data-screen="title"].is-active')
  await page.click('[data-action="settings"]')
  await page.waitForSelector('[data-screen="settings"].is-active')
  await page.locator('#ph-sfx').evaluate(element => {
    element.value = '0.31'
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const settings = await page.evaluate(() => ({ sfx: window.__game.save.data.sfxVolume, difficulty: localStorage.getItem('pigeonhouse.difficulty.v1') }))
  if (Math.abs(settings.sfx - 0.31) > 0.01 || settings.difficulty !== 'easy') throw new Error('Settings or difficulty did not persist')
  await page.click('[data-screen="settings"] [data-action="back"]')
  await page.waitForSelector('[data-screen="title"].is-active')

  // Start and exercise actual movement and flashlight controls.
  await page.click('[data-action="start"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')
  // Place the enemy nearby in clear view but emit no clue: a blind Pigeonman must not react.
  await page.evaluate(() => {
    const game = window.__game.game
    const player = game.debugState().player
    game.heard.length = 0
    game.enemy.set(player[0] + 4, player[1] - .87, player[2])
    game.enemyBody.setTranslation({ x: player[0] + 4, y: player[1], z: player[2] }, true)
    game.enemyYaw = Math.PI / 2
  })
  await page.waitForTimeout(180)
  const noVision = await page.evaluate(() => window.__game.game.debugState())
  if (noVision.mode !== 'playing' || noVision.enemyState !== 'PATROL' || noVision.heard.length !== 0) throw new Error(`Pigeonman reacted without an audible footstep: ${JSON.stringify(noVision)}`)
  const before = await page.evaluate(() => window.__game.game.debugState().player)
  await page.keyboard.down('w')
  await page.waitForTimeout(800)
  await page.keyboard.up('w')
  await page.keyboard.press('f')
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => ({ state: window.__game.game.debugState(), hud: window.__game.game.hud() }))
  const moved = positionDistance(before, after.state.player)
  if (after.state.mode !== 'playing' || moved < 0.55) throw new Error(`first-person movement did not advance (${moved.toFixed(2)}m)`)
  if (!after.hud.flashlight || after.hud.battery >= 100) throw new Error('flashlight did not toggle/drain its battery')
  if (!after.state.heard.some(source => source === 'footstep-walk') || !['INVESTIGATE', 'CHASE'].includes(after.state.enemyState)) throw new Error(`Pigeonman did not follow an audible walking footstep: ${JSON.stringify(after.state)}`)
  await page.screenshot({ path: `${out}/02-gameplay.png` })

  // CTRL crouch must still permit slow movement, emit no footfalls, and never add vertical impulse.
  await page.evaluate(() => { const game = window.__game.game; game.heard.length = 0 })
  const crouchStart = await page.evaluate(() => window.__game.game.debugState())
  if (!crouchStart.lastAudible) throw new Error('Walking did not leave an audible-footstep target for the silence check')
  let crouchPeakY = crouchStart.player[1]
  await page.keyboard.down('Control')
  await page.keyboard.down('w')
  let crouchCheck = crouchStart
  for (let i = 0; i < 9; i += 1) {
    await page.waitForTimeout(55)
    crouchCheck = await page.evaluate(() => window.__game.game.debugState())
    crouchPeakY = Math.max(crouchPeakY, crouchCheck.player[1])
  }
  await page.keyboard.up('w')
  const crouchedEnd = await page.evaluate(() => window.__game.game.debugState())
  await page.keyboard.up('Control')
  await page.waitForTimeout(120)
  if (!crouchedEnd.crouched || crouchedEnd.heard.length !== 0 || positionDistance(crouchStart.player, crouchedEnd.player) < 0.15 || crouchPeakY > crouchStart.player[1] + 0.16 || positionDistance(crouchStart.lastAudible, crouchedEnd.lastAudible) > 0.02) throw new Error(`Silent crouch movement, target, or vertical velocity is incorrect: ${JSON.stringify({ start: crouchStart, end: crouchedEnd, peakY: crouchPeakY })}`)

  // Local-only fixture placement, then real E/G keyboard inputs through the simulation.
  await page.evaluate(() => {
    const game = window.__game.game
    const spot = game.items.find(item => !game.picked.has(item.id)
      && game.world.hideSpots.every(hide => hide.entry.distanceTo(item.position) > 2.8)
      && game.world.targets.every(target => target.position.distanceTo(item.position) > 3))
    if (!spot) throw new Error('No unambiguous pickup fixture was generated')
    const p = { x: spot.position.x, y: 0.75, z: spot.position.z }
    game.playerBody.setTranslation(p, true)
    game.lastY = p.y
    window.__game.smokePickupId = spot.id
  })
  await page.keyboard.press('e')
  await page.waitForFunction(() => window.__game.game.hud().inventory.length > 0, { timeout: 5000 })
  const pickedId = await page.evaluate(() => window.__game.smokePickupId)
  await page.keyboard.press('g')
  await page.waitForTimeout(120)
  const dropped = await page.evaluate(id => {
    const game = window.__game.game
    return { hasItem: game.debugState().inventory.includes(id), instances: game.drops.length, picked: game.picked.has(id) }
  }, pickedId)
  if (dropped.hasItem || dropped.instances !== 1 || !dropped.picked) throw new Error('Dropping respawned a duplicate or did not create one bait instance')
  await page.evaluate(() => {
    const game = window.__game.game
    const drop = game.drops[0]
    const p = { x: drop.position.x, y: drop.position.y + 0.4, z: drop.position.z }
    game.playerBody.setTranslation(p, true)
    game.lastY = p.y
  })
  await page.keyboard.press('e')
  await page.waitForFunction(id => window.__game.game.debugState().inventory.includes(id) && window.__game.game.drops.length === 0, pickedId, { timeout: 5000 })

  // Hide with E, verify WASD cannot move a hidden player, then exit using E.
  await page.evaluate(() => {
    const game = window.__game.game
    const hide = game.world.hideSpots.find(spot => spot.id === 'sofa-hide')
    const p = { x: hide.entry.x, y: hide.entry.y - 0.17, z: hide.entry.z }
    game.playerBody.setTranslation(p, true)
    game.lastY = p.y
  })
  await page.keyboard.press('e')
  await page.waitForFunction(() => window.__game.game.hud().hidden, { timeout: 5000 })
  const hiddenBefore = await page.evaluate(() => window.__game.game.debugState().player)
  await page.keyboard.down('w')
  await page.waitForTimeout(350)
  await page.keyboard.up('w')
  const hiddenAfter = await page.evaluate(() => window.__game.game.debugState().player)
  if (positionDistance(hiddenBefore, hiddenAfter) > 0.08) throw new Error('A hidden player could still move normally')
  await page.keyboard.press('e')
  await page.waitForFunction(() => !window.__game.game.hud().hidden, { timeout: 5000 })
  const hideExit = await page.evaluate(() => window.__game.game.debugState().player)
  if (hideExit[1] < 0.55 || hideExit[1] > 1.05) throw new Error(`Hiding exit left the player off the floor (${hideExit[1].toFixed(2)}m)`)
  await page.screenshot({ path: `${out}/03-hide-exit.png` })

  // Pause, return to title, Continue from the local snapshot, then restart cleanly.
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  await page.screenshot({ path: `${out}/04-pause.png` })
  const savedPosition = await page.evaluate(() => window.__game.game.debugState().player)
  await page.click('[data-screen="pause"] [data-action="title"]')
  await page.waitForSelector('[data-screen="title"].is-active')
  if (await page.locator('[data-action="continue"]').isDisabled()) throw new Error('Continue was disabled after saving an in-progress attempt')
  await page.click('[data-action="continue"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')
  const continuedPosition = await page.evaluate(() => window.__game.game.debugState().player)
  if (positionDistance(savedPosition, continuedPosition) > 0.4) throw new Error('Continue did not restore the local attempt position')

  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  await page.click('[data-screen="pause"] [data-action="restart"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')
  const restarted = await page.evaluate(() => window.__game.game.debugState())
  if (restarted.inventory.length !== 0 || restarted.itemsRemaining !== 9 || positionDistance(restarted.player, [-12.5, 0.79, -8]) > 0.4) throw new Error(`Restart did not reset its puzzle, inventory, and spawn: ${JSON.stringify(restarted)}`)

  // Exercise the real interaction handler through every main-door lock and the final escape.
  await page.evaluate(() => {
    const game = window.__game.game
    for (const item of ['crowbar', 'hammer', 'padlock-key', 'main-key']) {
      game.inventory.add(item)
      game.picked.add(item)
      const placed = game.items.find(candidate => candidate.id === item && !candidate.mesh.userData.dropInstance)
      if (placed) placed.mesh.visible = false
    }
  })
  for (const item of ['crowbar', 'hammer', 'padlock-key', 'main-key']) await useAt(page, [0, 0.79, 14], item)
  await useAt(page, [0, 0.79, 14])
  await page.waitForSelector('[data-screen="victory"].is-active', { timeout: 10_000 })
  const mainRoute = await page.locator('[data-screen="victory"] .ph-result').innerText()
  if (!mainRoute.includes('Main door')) throw new Error(`The main door did not produce the right victory route: ${mainRoute}`)
  await page.screenshot({ path: `${out}/05-main-escape.png` })

  // Start over and exercise the independent basement key, panel, fuse/battery, chain and exit.
  await page.click('[data-screen="victory"] [data-action="restart"]')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')
  await page.evaluate(() => {
    const game = window.__game.game
    for (const item of ['basement-key', 'screwdriver', 'fuse', 'battery', 'pliers']) {
      game.inventory.add(item)
      game.picked.add(item)
      const placed = game.items.find(candidate => candidate.id === item && !candidate.mesh.userData.dropInstance)
      if (placed) placed.mesh.visible = false
    }
  })
  await page.evaluate(() => {
    const game = window.__game.game
    window.__game.smokeCues = []
    const original = game.audio.cue.bind(game.audio)
    game.audio.cue = (cue, intensity) => { window.__game.smokeCues.push(cue); return original(cue, intensity) }
  })
  await useAt(page, [14, 0.79, 4], 'basement-key')
  await page.waitForFunction(() => window.__game.smokeCues.includes('door'), { timeout: 2500 }).catch(() => { throw new Error('Opening a puzzle door did not play its creak cue') })
  await useAt(page, [29, -2.21, 5.05], 'screwdriver')
  await useAt(page, [29, -2.21, 5.05], 'fuse')
  await useAt(page, [29, -2.21, 5.05], 'battery')
  await useAt(page, [25, -2.21, 21.6], 'pliers')
  await useAt(page, [29, -2.21, 17])
  await page.waitForSelector('[data-screen="victory"].is-active', { timeout: 10_000 })
  const basementRoute = await page.locator('[data-screen="victory"] .ph-result').innerText()
  if (!basementRoute.includes('Basement / garage')) throw new Error(`The basement route did not produce the right victory route: ${basementRoute}`)
  await page.screenshot({ path: `${out}/06-basement-escape.png` })

  // A real close-range attack must create a brief looming-camera sequence before game over.
  await page.click('[data-screen="victory"] [data-action="restart"]')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')
  await page.evaluate(() => {
    const game = window.__game.game
    const player = game.debugState().player
    game.heard.length = 0
    game.enemy.set(player[0] + .55, player[1] - .87, player[2])
    game.enemyBody.setTranslation({ x: player[0] + .55, y: player[1], z: player[2] }, true)
    game.enemyYaw = Math.PI / 2
    // The real game noise gate accepts this only because it is a fresh footstep.
    game.noise(game.playerPosition(), .72, 'footstep-walk')
    game.step(1 / 60)
  })
  await page.waitForFunction(() => window.__game.game.mode === 'caught' && document.querySelector('.ph-ui').classList.contains('is-jumpscare'), { timeout: 5000 })
  await page.waitForFunction(() => window.__game.game.camera.fov < 73.5, { timeout: 1200 })
  const fright = await page.evaluate(() => ({
    label: getComputedStyle(document.querySelector('.ph-ui'), '::after').content,
    fov: window.__game.game.camera.fov,
    screenAlreadyEnded: document.querySelector('[data-screen="caught"]').classList.contains('is-active'),
  }))
  if (!fright.label.includes('PIGEONMAN') || fright.fov >= 74 || fright.screenAlreadyEnded) throw new Error(`Capture did not stage its camera/visual sequence: ${JSON.stringify(fright)}`)
  await page.evaluate(() => {
    const game = window.__game.game
    document.querySelector('.ph-ui').style.visibility = 'hidden'
    window.__game.smokeVisibility = []
    for (const object of game.scene.children) {
      if (object === game.pigeon || object === game.glow.target || object.isLight || object.isCamera) continue
      window.__game.smokeVisibility.push([object, object.visible])
      object.visible = false
    }
    window.__game.smokeOriginalStep = game.step.bind(game)
    game.step = () => {}
    game.mode = 'caught'
    game.caughtAge = 0.2
    game.caughtTimer = 2
    game.flashlightOn = true
    game.charge = 100
    game.playerBody.setTranslation({ x: 0, y: 0.79, z: 0 }, true)
    game.lastY = 0.79
    game.yaw = 0
    game.pitch = 0
    game.caughtPlayer.set(0, 0.79, 0)
    game.caughtEnemy.set(0, 0.79, -2.7)
  })
  await page.waitForTimeout(80)
  await page.screenshot({ path: `${out}/07-jumpscare.png` })
  await page.evaluate(() => {
    const game = window.__game.game
    for (const [object, visible] of window.__game.smokeVisibility) object.visible = visible
    delete window.__game.smokeVisibility
    document.querySelector('.ph-ui').style.visibility = ''
    game.step = window.__game.smokeOriginalStep
    delete window.__game.smokeOriginalStep
    game.caughtTimer = 0.01
  })
  await page.waitForSelector('[data-screen="caught"].is-active', { timeout: 3000 })
  if (await page.evaluate(() => document.querySelector('.ph-ui').classList.contains('is-jumpscare'))) throw new Error('Capture effect did not clear before the restart screen')

  if (errors.length) throw new Error(`console/network errors:\n  ${errors.join('\n  ')}`)
  await context.close()
  await cleanup()
  console.log(`smoke: OK — OG loading art, no-vision behavior, footsteps-only pursuit, silent crouch/no superjump, flashlight, pickup/drop, hiding, Continue/restart, door creak, both escape routes and close-up capture/jumpscare verified. Screenshots: ${out}`)
} catch (error) {
  await fail(error?.message ?? String(error))
}
