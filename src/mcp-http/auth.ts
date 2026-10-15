import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { readScope, type AuthConfig } from './config.js';

export type AuthResult = 'allowed' | 'invalid_token' | 'insufficient_scope';
const digest = (value: string) => createHash('sha256').update(value).digest();

/** One resolver per server, fixed admin URL, bounded retrieval and cache. No token jku/x5u discovery. */
function remoteKeys(url: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url), {
    timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    [customFetch]: async (input, options) => {
      const response = await fetch(input, options); // jose requests redirect: manual and supplies an abort signal.
      if (response.status !== 200 || !response.body) throw new Error('JWKS unavailable.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65_536) throw new Error('JWKS unavailable.');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const jwks: unknown = JSON.parse(text);
      if (!jwks || typeof jwks !== 'object' || !('keys' in jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 64) {
        throw new Error('JWKS unavailable.');
      }
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
}

/** The optional resolver is a trusted in-process test seam, never an HTTP/config input. */
export function createAuthenticator(config: AuthConfig, keyResolver?: JWTVerifyGetKey) {
  const expected = config.mode === 'localBearer' ? digest(config.token) : undefined;
  const keys = config.mode === 'oauth' ? keyResolver ?? remoteKeys(config.jwksUrl) : undefined;
  return async (authorization: string | undefined): Promise<AuthResult> => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~+\/-]+=*)$/iu);
    const token = match?.[1];
    if (!token || token.length > 8_192) return 'invalid_token';
    if (config.mode === 'localBearer') return timingSafeEqual(expected!, digest(token)) ? 'allowed' : 'invalid_token';
    try {
      const { payload } = await jwtVerify(token, keys!, {
        issuer: config.issuer, audience: config.resource,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'], requiredClaims: ['exp', 'iss', 'aud', 'sub']
      });
      if (typeof payload.sub !== 'string' || !config.subjects.includes(payload.sub)) return 'invalid_token';
      if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(readScope)) return 'insufficient_scope';
      return 'allowed';
    } catch { return 'invalid_token'; }
  };
}
