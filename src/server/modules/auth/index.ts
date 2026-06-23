import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import type { Context } from 'hono'

// @security[auth-allowlist] flaredraw is a Jezweb-internal tool, so sign-in is
// locked to jezweb.net in code. vite-flare-starter left OAuth gating to the
// Google consent screen, which does NOT gate a non-Workspace OAuth client.
const AUTH_ALLOWED_DOMAINS = ['jezweb.net']
function isAuthEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.toLowerCase()
  return AUTH_ALLOWED_DOMAINS.some((d) => e.endsWith('@' + d))
}

// Accept any context that has at least the auth-related bindings
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuth(c: Context<any>) {
  const db = c.env.DB
  return betterAuth({
    database: c.env.DB,
    secret: c.env.BETTER_AUTH_SECRET,
    baseURL: c.env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      },
    },
    // @security[auth-allowlist] Gate at account-create (new logins) AND
    // session-create (existing accounts re-logging in). Fail closed.
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            if (!isAuthEmailAllowed(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'Access denied. This account is not authorised.' })
            }
            return { data: user }
          },
        },
      },
      session: {
        create: {
          before: async (session: { userId: string }) => {
            const row = await db
              .prepare('SELECT email FROM user WHERE id = ?')
              .bind(session.userId)
              .first()
            if (!isAuthEmailAllowed(row?.email as string | undefined)) {
              throw new APIError('FORBIDDEN', { message: 'Access denied. This account is not authorised.' })
            }
            return { data: session }
          },
        },
      },
    },
    trustedOrigins: [
      c.env.BETTER_AUTH_URL,
      'http://localhost:5173',
      'http://localhost:5174',
      'https://draw.flared.au',
    ],
  })
}
