import { createGameApp } from './app.mjs'
import { leaderboard } from './leaderboard.mjs'
import { gameRouter } from './routers.mjs'

for (const name of ['MANUS_PROJECT_ID', 'MANUS_JWT_SECRET', 'MANUS_OAUTH_API_URL', 'MANUS_OAUTH_PORTAL_URL', 'DATABASE_URL']) {
  if (!process.env[name]) throw new Error(`Required Webdev runtime value is missing: ${name}`)
}
const app = createGameApp(gameRouter, { leaderboard })
const port = Number(process.env.PORT || 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
app.listen(port, '0.0.0.0')
