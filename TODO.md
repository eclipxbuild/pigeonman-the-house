# PIGEONMAN: THE HOUSE — Delivery outcomes

This checklist records the approved Three.js Blueprint and the concrete requirements in the supplied brief. The registered project Pigeonman reference is `assets/references/pigeonman-reference.png`; the rigged character is `assets/models/pigeonman-rigged.glb`. Blueprint approval and online-feature decisions are recorded in project setup.

## 1. Pigeonman character, animation, and hunt AI — complete
- Use the project's registered pigeon reference image and preserve the recognizable pigeon silhouette; do not replace it with a random bird, emoji, or unrelated monster.
- The exact registered rigged GLB is used. The runtime applies uniform whole-model scale and vertical origin placement; it does not edit skeletal bones or move the legs into the torso.
- Character behavior includes idle, walking, running, head-turning, searching, attack, and catch/jumpscare presentation; supporting audio includes heavy footsteps, pigeon cooing, breathing, search cues, and chase sounds.
- Enemy AI states: PATROL walks around the house and selects destinations across rooms; INVESTIGATE hears player footsteps and searches sound locations; CHASE follows audible footsteps; SEARCH investigates the last known position and likely hiding places after the sound stops; ATTACK catches a nearby player, triggers a cinematic jumpscare, and ends the attempt; RETURN resumes patrol when detection ends.
- Pigeonman is blind, navigates the house, and does not pursue crouched silent movement.

## 2. Abandoned multi-room house and horror atmosphere — complete
- Explore a navigable house with main entrance, living room, kitchen, dining room, multiple bedrooms, bathroom, basement, storage room, locked doors, secret passages, staircase, and attic.
- Include old wooden floors, dirty walls, broken furniture, dark corridors, cobwebs, sparing blood stains, flickering lights, dust particles, creaking doors, and abandoned objects.
- Use low-light horror, cinematic lighting, deep shadows, atmospheric fog, and performant materials.
- Add dynamic ambient audio, random creepy sounds, sudden noises, distant footsteps, doors, occasional Pigeonman appearances, chase cues, heartbeat feedback near Pigeonman, and jumpscare effects. Build tension through sound, darkness, and enemy behavior, not only jumpscares.

## 3. First-person desktop controls, collision, interaction, and hiding — complete
- Controls: W/A/S/D move; mouse looks; E interacts; SHIFT sprints; CTRL crouches; SPACE jumps; F toggles flashlight; G drops the selected item; ESC pauses.
- Include smooth mouse movement, collision, sprint stamina, crouching, intentional jumping, player footsteps, smooth camera movement, and functional interactions.
- Hiding places adjust the camera, prevent normal movement, reduce detection, allow Pigeonman to investigate, and create tension.
- Include flashlight battery and functional interaction prompts. All important buttons and interactions work; no decorative fake mechanics.

## 4. Collectibles, inventory, and solvable escape puzzles — complete
- Pick up, carry, inspect, and use the main-door key, padlock key, hammer, pliers, screwdriver, battery, fuse, crowbar, and special basement key.
- Inventory, item inspection, locked doors, item use, and puzzle dependencies work.
- Randomize item locations between attempts while keeping puzzles solvable.
- MAIN DOOR escape: find required keys, unlock multiple locks, open the final door, and escape.
- ALTERNATIVE escape: discover a separate basement/garage route, complete its puzzle sequence, and escape.
- Both endings work and attempts have real win/lose conditions.

## 5. Difficulty, menus, HUD, settings, and attempt lifecycle — complete
- EASY: slower Pigeonman, more time to escape, less sensitive hearing. NORMAL: balanced. HARD: faster Pigeonman, better hearing, more aggressive searching. NIGHTMARE: very fast Pigeonman, more frequent patrols, more difficult escape puzzles.
- Main menu: game title, START GAME, CONTINUE, DIFFICULTY, SETTINGS, HOW TO PLAY.
- In-game: minimal HUD, inventory, interaction prompts, stamina, flashlight battery, and pause menu.
- Game over: Pigeonman jumpscare, RESTART, and return to main menu. Victory: escape cinematic, victory screen, completion time, and completed difficulty.
- Persistent settings, restart, and randomized replayability work.

## 6. Audio, technology, and reliable browser play — complete
- Original synthesized/Web Audio sound cues; no paid API requirement.
- Use Three.js, TypeScript, Vite, Web Audio API, the registered GLB, and Pointer Lock API. Run locally in a browser and optimize for desktop PCs/common desktop resolutions.
- Restore registered media from `assets.lock.json`; use procedural fallbacks where needed.
- Working collision, AI, item interactions, puzzles, win/lose conditions, persistent settings, restart, and browser acceptance are required.
- This is a complete playable game—not a landing page, mockup, or static demo.

## 7. Approved account login and shared leaderboard — integrated; signed-in online acceptance pending
- Preserve the approved Manus OAuth account login and shared leaderboard integration. The project declares its required server and database; use the canonical project database, not an Addon database or fabricated player store.
- Use account identity for ranked play; protect writes; keep local play working offline and display honest API/login status. Do not invent a run, score, global rank, or accepted submission. Submit only actual completed, eligible runs.
- Preserve the Three.js `pnpm build` → `dist` output and supported `/api/*` server routes, health check, migrations, lockfiles, and managed-database workflow. Authenticated cross-session online acceptance was not verified in a signed-in managed runtime. The game has not been published.

## Verification recorded (2026-11-08)

- `pnpm typecheck`: passed.
- `pnpm test`: 78 tests passed across 12 files.
- `pnpm build`: passed. The game-specific OG art and favicon are included, and the bundle-size contract passes; Vite reports a large-chunk advisory.
- `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm smoke`: passed. Covers loading art, no-vision behavior, footsteps-only pursuit, silent crouching/no superjump, flashlight, pickup/drop, hiding, Continue/restart, door creak, both escape routes, and the caught/jumpscare sequence.
- `assets.lock.json` records the reference image and rigged model. `src/main.ts` selects the exact model hash from the asset lock; runtime code preserves the rigged model's skeletal pose. The final model-only smoke capture shows both legs below the torso; house geometry was hidden only for that diagnostic screenshot.
- Authenticated leaderboard submission/cross-session acceptance was not verified in a signed-in managed runtime. The game has not been published.

## 8. User-specified Pigeonman, stealth, crouch, and loading-screen refinements — complete
- Pigeonman follows audible footsteps only and cannot see the player; non-footstep interactions do not become player-hearing targets.
- While crouching with CTRL, the player produces no voice or footstep cue and creates no new hearing target.
- CTRL crouches without a superjump or vertical impulse; SPACE remains the intentional jump control.
- Display the existing `assets/share/og.png` artwork as the loading screen, not just as sharing metadata.
- Use the registered `pigeonman-rigged.glb` and preserve its supplied leg/torso pose without procedural bone rotations.
- Keep the complete game playable, with both escape routes and win/lose conditions verified by the browser suite.
