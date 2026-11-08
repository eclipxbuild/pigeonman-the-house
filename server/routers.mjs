import { router, publicProcedure, protectedProcedure } from './webdev-adapter.mjs'

import { leaderboard } from './leaderboard.mjs'
import { createLeaderboardRouter } from './leaderboard/router.mjs'

export const gameRouter = router({
  leaderboard: createLeaderboardRouter({ router, publicProcedure, protectedProcedure }, leaderboard),
  // Add gameplay writes and Stripe Checkout creation as protectedProcedure
  // mutations. Derive the buyer/save owner from ctx.user, never browser input.
  player: protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id, name: ctx.user.name })),
})
