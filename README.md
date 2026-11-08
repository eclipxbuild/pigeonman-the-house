# PIGEONMAN: THE HOUSE

A browser-based, first-person 3D survival-horror escape game built with Three.js and Rapier. Search an abandoned multi-room house, stay quiet around a blind Pigeonman who follows audible footsteps, solve item-gated puzzles, and escape through either the main entrance or the basement/garage route.

## Run and verify
To play the game CLICK ON THIS LINK : https://pigeonhouse-affd6ajq.manus.game
```bash
pnpm install
PORT=3000 HOST=0.0.0.0 pnpm dev
pnpm typecheck
pnpm test
pnpm build
CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm smoke
```

`pnpm dev` restores registered game assets before starting Vite. `pnpm build` restores assets, adds the configured title/favicon/OG metadata, and builds the production site to `dist/`. Run `pnpm smoke` after a build; it uses local registered media, runs a desktop Chromium playthrough, and writes captures to `/tmp/pigeonhouse-smoke/`.
<img width="933" height="458" alt="image" src="https://github.com/user-attachments/assets/bc7ecf52-f531-419b-a711-c8dfdc3efd1b" />
<img width="943" height="453" alt="image" src="https://github.com/user-attachments/assets/11c82e67-d4aa-4ae6-8dca-b7aaf81fa49d" />
<img width="937" height="455" alt="image" src="https://github.com/user-attachments/assets/80a0c7a7-e72f-426d-8c82-b6df33816d2d" />
<img width="943" height="455" alt="image" src="https://github.com/user-attachments/assets/ec90f639-6d5a-4cee-84bc-b8b0f532f18a" />

## Controls

| Input | Action |
| --- | --- |
| `W` / `A` / `S` / `D` | Move |
| Mouse | Look (click the game to capture the pointer) |
| `E` | Interact, pick up, or enter/leave a hiding place |
| `Shift` | Sprint (uses stamina) |
| `Ctrl` | Crouch silently |
| `Space` | Jump |
| `F` | Toggle flashlight |
| `G` | Drop the selected item |
| `1`–`9` | Select an inventory item |
| `Esc` | Pause/resume |

Pigeonman is blind and responds to audible player footsteps; crouched movement emits no player footfalls. Use furniture and storage spaces to hide, manage the flashlight battery, and avoid drawing attention while you collect tools and keys.

## Game modules

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Startup, registered GLB loading, UI/game wiring, and online integration hooks |
| `src/game/game.ts` | First-person movement, Rapier collision, inventory interactions, audio cues, enemy simulation, and win/lose flow |
| `src/game/houseWorld.ts` | House layout, navigation nodes, hiding spots, doors, and puzzle targets |
| `src/game/pigeonAI.ts` | Pigeonman patrol, hearing investigation, search, chase, and catch decisions |
| `src/game/horrorRules.ts` | Item placement, puzzle dependencies, route completion, and results |
| `src/game/horrorAudio.ts` | Web Audio cues, ambience, chase sounds, and proximity feedback |
| `src/ui/horror-ui.ts` / `src/styles/horror.css` | Menus, HUD, settings, inventory, and game-result screens |
| `src/engine/` | Shared input, Rapier physics, render loop, WebGL renderer, assets, and local saves |
| `assets.lock.json` | Registered GLB, reference image, favicon, and OG artwork addresses |
| `scripts/smoke.mjs` | Desktop browser acceptance playthrough and screenshots |

The active Pigeonman model is `assets/models/pigeonman-rigged.glb`; its stable registered URL is selected by `MODEL_URL` in `src/main.ts`. Preserve the rig and its rest pose when changing enemy presentation.

## Build and preview rules

- Keep gameplay state in the fixed simulation `step()` and visual updates in `render()`; use the engine's input actions and Rapier controllers.
- Keep puzzle/item rules in `horrorRules.ts` and AI decisions in `pigeonAI.ts`; update their unit tests when behavior changes.
- Registered runtime media stays in Manus Storage/CDN and is listed in `assets.lock.json`; use the package `dev` and `build` scripts so restoration and size checks run.
- Preserve the Three.js build-size gate in `scripts/check-size.mjs`, the canonical Git checkpoint workflow, and the user's current publication setting. A saved checkpoint is not necessarily published.
- Online account/leaderboard paths must remain offline-safe, submit only eligible completed runs, and enforce eligibility on the server as well as in the browser.

## Credits

Three.js (MIT), Rapier (Apache-2.0), and the bundled Manus CC0 fonts. See `public/fonts/ManusCC0-LICENSE.txt`.

## Preview Tweak

`src/game/tuning.ts` is this game's parameter manager. The Addon panel reads its catalog; `config.ts` owns source defaults and the active configuration used by gameplay. When adapting the game, keep only controls with actual gameplay consumers, and preserve stable IDs for unchanged parameters. Define ranges, units and the correct activation boundary. Register through `scripts/manus-tuning/adapter.js` only under `import.meta.env.DEV`. Keep the Vite plugin and `scripts/__manus__/` helpers intact; production builds exclude the browser adapter and never inject the bridge.

Apply changes preview state only. `LIVE` parameters are read in the next game update; `NEXT_ACTION` parameters activate at their relevant action start; `NEXT_RUN` parameters activate in `Game.start`. Do not mutate the source defaults or persist Apply to localStorage. Save with Manus checks the snapshot against the current catalog and edits `DEFAULT_CONFIG`, then uses the normal Three.js Web build/checkpoint workflow. Keep existing gameplay parameter managers when extending an older project; do not create a competing store.

For online leaderboards, skip submissions for unranked runs and enforce eligibility in the authoritative server too; client flags are not proof of a fair score. The preview plugin reads the ignored `.manus-webdev/preview-identity.json` v1 projection written by the Runtime when initializing, attaching or restoring this project. It contains only the resource ID and canonical project directory; private Host bindings and starter receipts are not template dependencies. Missing identity disables the bridge.
