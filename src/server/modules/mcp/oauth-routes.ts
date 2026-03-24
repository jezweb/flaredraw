import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { hashToken } from '../../middleware/auth'
import { mcpOAuthClients, mcpOAuthCodes, mcpOAuthTokens, users, accounts } from '../../db/schema'

type Bindings = {
  DB: D1Database
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

const oauthRoutes = new Hono<{ Bindings: Bindings }>()

// ─── Helpers ───

function randomString(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function sha256Base64url(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

// ─── Discovery endpoints (mounted at app root, not /oauth) ───

export function wellKnownRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/.well-known/oauth-protected-resource', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json({
      resource: origin,
      authorization_servers: [origin],
    })
  })

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['drawings'],
    })
  })
}

// ─── Dynamic Client Registration (RFC 7591) ───

oauthRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    redirect_uris: string[]
    client_name?: string
    token_endpoint_auth_method?: string
  }>()

  if (!body.redirect_uris?.length) {
    return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' }, 400)
  }

  const clientId = randomString(16)
  const clientSecret = randomString(32)

  const db = drizzle(c.env.DB)
  await db.insert(mcpOAuthClients).values({
    clientId,
    clientSecret,
    redirectUris: JSON.stringify(body.redirect_uris),
    clientName: body.client_name || null,
  })

  return c.json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: nowUnix(),
    client_secret_expires_at: 0, // never expires
    redirect_uris: body.redirect_uris,
    client_name: body.client_name || undefined,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201)
})

// ─── Authorization Endpoint ───

oauthRoutes.get('/authorize', async (c) => {
  const clientId = c.req.query('client_id')
  const redirectUri = c.req.query('redirect_uri')
  const codeChallenge = c.req.query('code_challenge')
  const codeChallengeMethod = c.req.query('code_challenge_method') || 'S256'
  const state = c.req.query('state')
  const scope = c.req.query('scope')

  if (!clientId || !redirectUri || !codeChallenge) {
    return c.json({ error: 'invalid_request', error_description: 'Missing client_id, redirect_uri, or code_challenge' }, 400)
  }

  if (codeChallengeMethod !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method supported' }, 400)
  }

  // Validate client exists and redirect_uri matches
  const db = drizzle(c.env.DB)
  const [client] = await db
    .select()
    .from(mcpOAuthClients)
    .where(eq(mcpOAuthClients.clientId, clientId))
    .limit(1)

  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400)
  }

  const allowedUris: string[] = JSON.parse(client.redirectUris)
  if (!allowedUris.includes(redirectUri)) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri not registered' }, 400)
  }

  // Store authorization request as a pending code (nonce-keyed)
  const nonce = randomString(32)
  await db.insert(mcpOAuthCodes).values({
    code: nonce,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: scope || 'drawings',
    clientState: state || null,
    expiresAt: nowUnix() + 600, // 10 minutes
  })

  // Redirect to Google OAuth
  const origin = new URL(c.req.url).origin
  const googleParams = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/oauth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: nonce,
    access_type: 'online',
    prompt: 'select_account',
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${googleParams}`)
})

// ─── Google OAuth Callback ───

oauthRoutes.get('/callback', async (c) => {
  const googleCode = c.req.query('code')
  const nonce = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    // Google denied — find the pending code to get the client's redirect_uri
    if (nonce) {
      const db = drizzle(c.env.DB)
      const [pending] = await db.select().from(mcpOAuthCodes).where(eq(mcpOAuthCodes.code, nonce)).limit(1)
      if (pending) {
        const url = new URL(pending.redirectUri)
        url.searchParams.set('error', 'access_denied')
        if (pending.clientState) url.searchParams.set('state', pending.clientState)
        await db.delete(mcpOAuthCodes).where(eq(mcpOAuthCodes.code, nonce))
        return c.redirect(url.toString())
      }
    }
    return c.text('Authorization denied', 400)
  }

  if (!googleCode || !nonce) {
    return c.text('Missing code or state', 400)
  }

  const db = drizzle(c.env.DB)
  const origin = new URL(c.req.url).origin

  // Look up the pending auth request
  const [pending] = await db
    .select()
    .from(mcpOAuthCodes)
    .where(eq(mcpOAuthCodes.code, nonce))
    .limit(1)

  if (!pending || pending.used || pending.expiresAt < nowUnix()) {
    return c.text('Invalid or expired authorization request', 400)
  }

  // Exchange Google code for tokens (server-side)
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: googleCode,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/oauth/callback`,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    console.error(JSON.stringify({ event: 'oauth_google_token_error', status: tokenRes.status }))
    return c.text('Failed to exchange Google authorization code', 500)
  }

  const googleTokens = await tokenRes.json<{ access_token: string }>()

  // Get user info from Google
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${googleTokens.access_token}` },
  })

  if (!userInfoRes.ok) {
    return c.text('Failed to get user info from Google', 500)
  }

  const googleUser = await userInfoRes.json<{ email: string; name: string; picture?: string }>()

  // Find or create user
  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, googleUser.email))
    .limit(1)

  if (!user) {
    // Auto-create account for new users coming through MCP OAuth
    const userId = randomString(16)
    const accountId = randomString(16)
    const now = new Date().toISOString()

    await db.insert(users).values({
      id: userId,
      name: googleUser.name || googleUser.email.split('@')[0],
      email: googleUser.email,
      emailVerified: true,
      image: googleUser.picture || null,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(accounts).values({
      id: accountId,
      accountId: googleUser.email,
      providerId: 'google',
      userId,
      createdAt: now,
      updatedAt: now,
    })

    user = { id: userId }
    console.log(JSON.stringify({ event: 'mcp_oauth_user_created', email: googleUser.email, userId }))
  }

  // Generate our own authorization code
  const authCode = randomString(32)

  // Replace the nonce row with the real auth code
  await db.delete(mcpOAuthCodes).where(eq(mcpOAuthCodes.code, nonce))
  await db.insert(mcpOAuthCodes).values({
    code: authCode,
    clientId: pending.clientId,
    userId: user.id,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    scope: pending.scope,
    clientState: pending.clientState,
    expiresAt: nowUnix() + 300, // 5 minutes to exchange
  })

  // Redirect back to Claude with our auth code
  const redirectUrl = new URL(pending.redirectUri)
  redirectUrl.searchParams.set('code', authCode)
  if (pending.clientState) redirectUrl.searchParams.set('state', pending.clientState)

  return c.redirect(redirectUrl.toString())
})

// ─── Token Endpoint ───

oauthRoutes.post('/token', async (c) => {
  const body = await c.req.parseBody() as Record<string, string>
  const grantType = body.grant_type

  const db = drizzle(c.env.DB)

  if (grantType === 'authorization_code') {
    const { code, client_id, client_secret, code_verifier, redirect_uri } = body

    if (!code || !client_id || !code_verifier) {
      return c.json({ error: 'invalid_request', error_description: 'Missing code, client_id, or code_verifier' }, 400)
    }

    // Validate client
    const [client] = await db
      .select()
      .from(mcpOAuthClients)
      .where(eq(mcpOAuthClients.clientId, client_id))
      .limit(1)

    if (!client || (client.clientSecret && client.clientSecret !== client_secret)) {
      return c.json({ error: 'invalid_client' }, 401)
    }

    // Look up authorization code
    const [codeRecord] = await db
      .select()
      .from(mcpOAuthCodes)
      .where(eq(mcpOAuthCodes.code, code))
      .limit(1)

    if (!codeRecord || codeRecord.used || codeRecord.expiresAt < nowUnix()) {
      return c.json({ error: 'invalid_grant', error_description: 'Code expired or already used' }, 400)
    }

    if (codeRecord.clientId !== client_id) {
      return c.json({ error: 'invalid_grant', error_description: 'Code was not issued to this client' }, 400)
    }

    if (redirect_uri && codeRecord.redirectUri !== redirect_uri) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
    }

    // Verify PKCE
    const expectedChallenge = await sha256Base64url(code_verifier)
    if (expectedChallenge !== codeRecord.codeChallenge) {
      return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
    }

    // Mark code as used
    await db.update(mcpOAuthCodes).set({ used: true }).where(eq(mcpOAuthCodes.code, code))

    // Generate tokens
    const accessTokenRaw = randomString(32)
    const refreshTokenRaw = randomString(32)
    const accessTokenHash = await hashToken(accessTokenRaw)
    const refreshTokenHash = await hashToken(refreshTokenRaw)
    const expiresIn = 3600 // 1 hour

    await db.insert(mcpOAuthTokens).values({
      token: accessTokenHash,
      clientId: client_id,
      userId: codeRecord.userId!,
      scope: codeRecord.scope,
      expiresAt: nowUnix() + expiresIn,
      refreshToken: refreshTokenHash,
      refreshExpiresAt: nowUnix() + 30 * 24 * 3600, // 30 days
    })

    return c.json({
      access_token: accessTokenRaw,
      token_type: 'bearer',
      expires_in: expiresIn,
      refresh_token: refreshTokenRaw,
      scope: codeRecord.scope || 'drawings',
    })
  }

  if (grantType === 'refresh_token') {
    const { refresh_token, client_id, client_secret } = body

    if (!refresh_token || !client_id) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    // Validate client
    const [client] = await db
      .select()
      .from(mcpOAuthClients)
      .where(eq(mcpOAuthClients.clientId, client_id))
      .limit(1)

    if (!client || (client.clientSecret && client.clientSecret !== client_secret)) {
      return c.json({ error: 'invalid_client' }, 401)
    }

    // Find the token by refresh token hash
    const refreshHash = await hashToken(refresh_token)
    const [existing] = await db
      .select()
      .from(mcpOAuthTokens)
      .where(eq(mcpOAuthTokens.refreshToken, refreshHash))
      .limit(1)

    if (!existing || (existing.refreshExpiresAt && existing.refreshExpiresAt < nowUnix())) {
      return c.json({ error: 'invalid_grant', error_description: 'Refresh token expired or invalid' }, 400)
    }

    if (existing.clientId !== client_id) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    // Delete old token
    await db.delete(mcpOAuthTokens).where(eq(mcpOAuthTokens.token, existing.token))

    // Issue new tokens
    const newAccessRaw = randomString(32)
    const newRefreshRaw = randomString(32)
    const newAccessHash = await hashToken(newAccessRaw)
    const newRefreshHash = await hashToken(newRefreshRaw)
    const expiresIn = 3600

    await db.insert(mcpOAuthTokens).values({
      token: newAccessHash,
      clientId: client_id,
      userId: existing.userId,
      scope: existing.scope,
      expiresAt: nowUnix() + expiresIn,
      refreshToken: newRefreshHash,
      refreshExpiresAt: nowUnix() + 30 * 24 * 3600,
    })

    return c.json({
      access_token: newAccessRaw,
      token_type: 'bearer',
      expires_in: expiresIn,
      refresh_token: newRefreshRaw,
      scope: existing.scope || 'drawings',
    })
  }

  return c.json({ error: 'unsupported_grant_type' }, 400)
})

export { oauthRoutes }
