# Authenticated HTTP MCP

Wallpaper Companion can serve the existing six read-only catalog tools at `/mcp` using the official SDK's Streamable HTTP handler. Both legacy initialize and modern discovery use the same `createCatalogMcpServer` factory as stdio. No workflow, scan, download, playback, or file-serving tools are registered. Tool annotations remain read-only. The stdio command and factory contracts are unchanged.

## Local coding clients

Use Node 24.11.1 or later within 24.x. Build and scan the companion catalog separately first (see [local MCP](local-mcp.md)). In PowerShell:

```powershell
npm ci --ignore-scripts
npm run build
$env:WALLPAPER_MCP_AUTH_MODE = 'localBearer'
$env:WALLPAPER_MCP_TOKEN = node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))"
npm run mcp:http -- --db '<absolute-index-path>'
```

Configure a trusted MCP client for `http://127.0.0.1:3211/mcp`, transport Streamable HTTP, and `Authorization: Bearer <the generated token>`. Configure the credential through that client's secret/environment mechanism. Do not paste it into a URL, commit it, or share it in chat. Local bearer mode is for clients capable of setting headers and reaching this computer; it does not provide an OAuth login flow for hosted chat apps. Regenerating the secret and restarting revokes the old token. The listener does not persist credentials.

| Environment variable | Meaning |
| --- | --- |
| `WALLPAPER_MCP_AUTH_MODE` | Required: exactly `localBearer` or `oauth`; missing/unknown modes fail startup. |
| `WALLPAPER_MCP_PORT` | Optional decimal port, default `3211`; `0` lets the OS choose an ephemeral port. |
| `WALLPAPER_MCP_TOKEN` | Local mode only: generate at least 32 random bytes as base64url, 43–128 characters. Repeated/low-diversity values are rejected, but format checks cannot prove entropy. |
| `WALLPAPER_MCP_RESOURCE_URL` | OAuth only: trusted public HTTPS canonical resource URL, exactly the `/mcp` path. This exact string is the required JWT audience. |
| `WALLPAPER_MCP_ISSUER` | OAuth only: exact trusted HTTPS JWT issuer. Preserve any issuer trailing slash. |
| `WALLPAPER_MCP_JWKS_URL` | OAuth only: administrator-approved HTTPS public signing key endpoint. Never taken from a token or request. |
| `WALLPAPER_MCP_ALLOWED_SUBJECTS` | OAuth only: nonempty JSON array of exact subject strings allowed to read this private catalog. |

`--db` is administrative startup input. No MCP request can select paths, issuers, key URLs, subjects, or mode. Invalid configuration and startup failures produce fixed diagnostics without echoing credentials, URLs, or database paths.

## OAuth resource server and regular chat prerequisites

OAuth mode validates access tokens issued by an external authorization server. It does not implement an authorization server, token issuance, login, consent, registration, or a relay. Example administrative configuration (illustrative domains and subject only):

```powershell
$env:WALLPAPER_MCP_AUTH_MODE = 'oauth'
$env:WALLPAPER_MCP_RESOURCE_URL = 'https://companion.example.com/mcp'
$env:WALLPAPER_MCP_ISSUER = 'https://identity.example.com/'
$env:WALLPAPER_MCP_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json'
$env:WALLPAPER_MCP_ALLOWED_SUBJECTS = '["catalog-owner-subject"]'
npm run mcp:http -- --db '<absolute-index-path>'
```

Before a regular hosted ChatGPT, Claude, Gemini, or other chat client could connect, an administrator must provide all of the following:

- A reachable HTTPS endpoint that forwards only `/mcp` and the two discovery paths below to this loopback listener. TLS termination/hosting, routing, and the trust of that provider need separate review. The proxy must preserve the public Host or use the exact loopback Host, preserve Authorization, avoid logging tokens, disable caching, and enforce its own connection/request limits.
- A trusted OAuth 2.1 issuer with authorization/token endpoints and discovery metadata, appropriate client registration or preregistration for the selected app, and the app's required login/consent flow. That issuer must mint **access tokens** for the exact configured resource audience, approved subject, and `wallpaper:read` scope. Do not accept ID tokens or tokens intended for another API; configure distinct audiences at the issuer.
- A client/product tier that actually supports remote Streamable HTTP and the issuer's OAuth setup. Transport support alone does not establish that any named product supports this deployment or that its account has been configured.

No hosted app, external issuer, public proxy, or account has been connected or tested by this feature. No public endpoint is deployed. A local address is unreachable from a hosted chat service. The implementation provides verifiable transport and resource-server infrastructure, not an end-to-end compatibility claim.

## Authentication and discovery contract

Every `/mcp` request, including GET/DELETE and unsupported methods, must authenticate before the SDK is called. Local mode hashes the presented token and compares equal-size digests with Node's constant-time comparison. OAuth mode uses maintained `jose` JWT verification for signature, exact issuer, configured resource audience, mandatory expiration and subject, then enforces subject allowlisting and the exact `wallpaper:read` scope in the standard space-delimited `scope` claim. Supported asymmetric algorithms are RS256, PS256, ES256, and EdDSA. JOSE enforces `nbf` when present. JWTs without expiration, unsigned tokens, HMAC tokens, other issuers/audiences/subjects, and expired tokens are rejected. An issuer must ensure only access tokens use this audience; generic JWT verification cannot distinguish an ID token with deliberately identical claims.

OAuth mode serves public metadata without catalog data at:

- `GET /.well-known/oauth-protected-resource/mcp` (path-specific RFC 9728 discovery).
- `GET /.well-known/oauth-protected-resource` (root discovery alias for clients that try the root).

Both return the configured `resource`, `authorization_servers`, `scopes_supported`, and header-only bearer method. A 401 includes `WWW-Authenticate: Bearer resource_metadata="https://companion.example.com/.well-known/oauth-protected-resource/mcp", scope="wallpaper:read", error="invalid_token"`. A verified token missing scope receives 403 with `insufficient_scope`. All other invalid credentials receive the same fixed 401 without revealing verification details. Local mode returns a bearer challenge without OAuth metadata and does not expose discovery routes.

## Boundaries and limits

- Always listens on `127.0.0.1`; there is no bind-host or unauthenticated remote switch. Host must exactly match `127.0.0.1:<bound-port>`, `localhost:<bound-port>`, or the OAuth resource's configured public authority. Forwarded headers never expand this set.
- Missing Origin is accepted for native/server clients. A present Origin must exactly match the local listener origin or configured public HTTPS origin. No wildcard origins or cross-origin browser CORS/preflight support are provided. Hosted clients connect from their backend. Duplicate Host, Origin, or Authorization headers are rejected.
- Exact routes only: queries, encoded aliases, alternate paths, and media URLs do not resolve. Uncompressed JSON POST only, maximum 64 KiB including chunked bodies, 16 KiB headers, 5-second header timeout, 10-second absolute request deadline, 64 concurrent sockets, and 100 requests per socket. Stateless GET/DELETE return SDK 405 after authentication. No long-lived subscription streams are enabled.
- The issuer's single configured JWKS URL uses a 3-second fetch timeout, no redirects, maximum 64 KiB/64 keys, 30-second successful-fetch refresh cooldown, and 10-minute cache lifetime. Tokens cannot provide a different key URL. Issuer/JWKS outages fail closed for unavailable keys. Removing a key may take up to the cache lifetime to be observed; short-lived tokens and issuer revocation policy remain administrative concerns.
- SIGINT/SIGTERM stop accepting requests, close the SDK handler, and allow up to one second for HTTP connections before forcing them closed. Close is idempotent. Transport/startup/parser errors use fixed messages. Catalog tool errors and data projections remain owned by the shared factory.
- Authenticated detail tools can return private registered paths and playlist metadata. Authorization is intentionally all-or-nothing for this single user's read-only catalog; only trusted subjects/clients should be allowed. It is not a multi-tenant service or per-playlist permission system.

## Verification and references

Tests exercise the SDK client against a real loopback listener in both legacy and modern modes, plus synthetic JWT claims/signatures, metadata, unauthorized successive requests, Host/Origin and duplicate headers, declared/chunked body bounds, redacted errors, the actual request deadline, and an active-connection shutdown. Production JOSE retrieval tests intercept fetch in process to verify the fixed URL, no redirects, key/body bounds, caching, unknown-key cooldown, and a real 3-second timeout; they do not contact real issuers, user accounts, or media libraries. Existing stdio tests remain unchanged and part of `npm test`.

Local verification after incorporating main's gallery: `npm ci --ignore-scripts` (0 audit vulnerabilities), `npm run check`, and `npm test` passed: 82 backend/protocol tests and 11 frontend tests, UI type checking, and production UI build. The backend count includes 21 new HTTP tests (15 top-level tests and six JWKS subtests). A raw-socket regression also verifies that incomplete headers close within the 5-second header timeout plus the explicitly configured 1-second checking interval (with scheduling tolerance). The final PR records CI results for Windows/Linux and Node 24.11.1/current 24.x.

Handoff: `src/mcp-http/{config,auth,server}.ts` owns configuration, authentication, and lifecycle; `src/mcp-http-cli.ts` is the entrypoint; `test/mcp-http.test.ts` owns transport fixtures. Dependencies are pinned to `@modelcontextprotocol/node` 2.1.1 and `jose` 6.2.12, alongside the existing server/client 2.3.1. Gallery dependencies/scripts were preserved during integration. Coordinator review and merge are next. No deployment or provider credentials are needed to review the feature; a real issuer and hosting choice remain prerequisites for any later hosted-client integration. Future workflows must register tools separately and test their scope requirements; this listener intentionally retains only the catalog's six read-only tools.

Implementation references: [official Node adapter](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware/node), [official SDK v2](https://github.com/modelcontextprotocol/typescript-sdk), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [RFC 9728 discovery](https://www.rfc-editor.org/rfc/rfc9728.html), and [JOSE remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md).

## Brief

This adds authenticated HTTP access to the same private, read-only catalog tools used by coding clients. Local bearer mode is available for clients on this computer. OAuth validation and discovery create a foundation for hosted chat integration, but a trusted external issuer, secure public HTTPS routing, and actual product-specific testing are still required. The listener cannot be switched to unauthenticated or directly public operation. No hosting or account changes are included.
