# FlareDraw — CLAUDE.md

Excalidraw on Cloudflare. Uses `@excalidraw/excalidraw` npm package (not a full fork).

## Commands

```bash
pnpm dev              # Start dev server (Vite + Cloudflare plugin)
pnpm build            # Production build
pnpm deploy           # Build + wrangler deploy
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate:local # Apply migrations locally
pnpm db:migrate:remote # Apply migrations to production D1
```

## Architecture

- **Frontend**: React 19 + Excalidraw npm package + React Router + Tailwind v4 + shadcn/ui
- **Backend**: Hono on Cloudflare Workers
- **Database**: D1 (metadata via Drizzle) + R2 (drawing content)
- **Auth**: better-auth with Google OAuth (D1 binding, NOT drizzleAdapter). No email/password.
- **Domain**: draw.flared.au

## Key Patterns

- Excalidraw needs `build.target: 'es2022'` in Vite config
- Import Excalidraw CSS before Tailwind to avoid style conflicts
- `window.EXCALIDRAW_ASSET_PATH = '/fonts/'` must be set before component mounts (in index.html)
- Use `getSceneVersion()` to debounce onChange (fires on every cursor move)
- Store `serializeAsJSON()` output directly in R2 — standard .excalidraw format
- Login redirect: `window.location.href`, not `navigate()` (SPA race condition)
- `run_worker_first` in wrangler.jsonc must include ALL non-asset Worker routes — not just `/api/*`. OAuth (`/.well-known/*`, `/oauth/*`) and any future server routes need explicit entries or the SPA fallback serves `index.html`.

## Auth

Three authentication methods:
- **Web UI**: Google OAuth via better-auth session cookies
- **API tokens**: Bearer token auth with `fd_` prefixed tokens (SHA-256 hashed in D1)
- **MCP OAuth 2.1**: Full OAuth flow for Claude AI — discovery, dynamic client registration, PKCE, Google OAuth proxy. Tokens stored as SHA-256 hashes in `mcp_oauth_tokens` table.

Dual-auth middleware in `src/server/middleware/auth.ts` supports all three methods. Token management (Settings page) is session-only — can't manage tokens via tokens.

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/health` | None | Health check |
| `GET /api/mcp` | None | MCP server info (discovery) |
| `POST /api/mcp/message` | Bearer/Session/OAuth | MCP Streamable HTTP (JSON-RPC) |
| `GET /api/drawings` | Bearer/Session/OAuth | List user's drawings |
| `POST /api/drawings` | Bearer/Session/OAuth | Create drawing (accepts optional elements/title) |
| `POST /api/v1/diagram` | Bearer/Session/OAuth | Create + share in one step (returns URLs) |
| `GET /api/shares/:id/png` | None | Serve cached PNG |
| `PUT /api/shares/:id/png` | Bearer/Session/OAuth | Upload client-generated PNG |
| `POST /api/shares/:id/png` | Bearer/Session/OAuth | Trigger server-side PNG via Browser Rendering |
| `GET /api/api-tokens` | Session only | List tokens |
| `POST /api/api-tokens` | Session only | Create token (returns raw once) |
| `DELETE /api/api-tokens/:id` | Session only | Revoke token |

### OAuth Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/oauth-protected-resource` | MCP OAuth discovery |
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata |
| `POST /oauth/register` | Dynamic client registration |
| `GET /oauth/authorize` | Start OAuth flow (redirects to Google) |
| `GET /oauth/callback` | Google OAuth callback (issues auth code) |
| `POST /oauth/token` | Token exchange (PKCE verified) + refresh |

## MCP Server

Streamable HTTP at `/api/mcp/message`. Stateless mode (fresh server per request, no session persistence). Uses `WebStandardStreamableHTTPServerTransport` for Workers compatibility.

**Tools**: read_guide, list_drawings, get_drawing, create_drawing, update_drawing, delete_drawing, share_drawing, create_diagram

**Resources**: `excalidraw://guide/elements` — element sizing guide (also available as `read_guide` tool since not all MCP clients support resources)

**Config — OAuth (recommended, for Claude AI)**:
```json
{
  "mcpServers": {
    "flaredraw": {
      "url": "https://draw.flared.au/api/mcp/message"
    }
  }
}
```

**Config — Bearer token (for scripts/automation)**:
```json
{
  "mcpServers": {
    "flaredraw": {
      "url": "https://draw.flared.au/api/mcp/message",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}
```

## PNG Export

Two paths for PNG generation:
1. **Client-side (fast)**: `exportToBlob()` from Excalidraw, uploaded via `PUT /api/shares/:id/png` on share
2. **Server-side (Browser Rendering)**: `POST /api/shares/:id/png` screenshots the share page via `@cloudflare/puppeteer`

## Project Structure

```
src/
  client/          # React SPA
    components/    # UI components
    hooks/         # Custom hooks (useAutoSave, useDrawing)
    pages/         # Route pages (Dashboard, Drawing, Settings, Login, SharedDrawing)
    layouts/       # Dashboard + Editor layouts
    lib/           # API client, auth client, utils
  server/          # Hono Worker
    modules/       # Feature modules (auth, drawings, shares, api-tokens, api, mcp, export)
    db/            # Drizzle schema + MCP OAuth tables (mcpOAuthClients, mcpOAuthCodes, mcpOAuthTokens)
    middleware/    # Auth (triple: session + Bearer token + MCP OAuth)
```

## Build Journal

Documenting the build experience at `.jez/artifacts/build-journal.md` for future blog/newsletter.
Screenshots go to `.jez/screenshots/`.
