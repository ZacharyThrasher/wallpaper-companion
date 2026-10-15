export const readScope = 'wallpaper:read';
export type AuthConfig = { mode: 'localBearer'; token: string } | {
  mode: 'oauth'; resource: string; issuer: string; jwksUrl: string; subjects: string[];
};
export interface HttpConfig { port: number; auth: AuthConfig }

function invalid(): never { throw new Error('Invalid HTTP MCP configuration. See docs/http-mcp.md.'); }

/** Administrative configuration only. Never call with values from MCP requests. */
export function trustedHttpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      /[\s\x00-\x1f\x7f"\\?#]/u.test(value)) invalid();
  return url;
}

export function validateConfig(config: HttpConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) invalid();
  const auth = config.auth;
  if (auth.mode === 'localBearer') {
    // Require a base64url-shaped 256-bit random secret; entropy comes from the generator.
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(auth.token) || new Set(auth.token).size < 10) invalid();
  } else if (auth.mode === 'oauth') {
    if (trustedHttpsUrl(auth.resource).pathname !== '/mcp') invalid();
    trustedHttpsUrl(auth.issuer);
    trustedHttpsUrl(auth.jwksUrl);
    if (!Array.isArray(auth.subjects) || auth.subjects.length === 0 || auth.subjects.length > 100 ||
        auth.subjects.some(s => typeof s !== 'string' || s.length === 0 || s.length > 256 || /[\x00-\x1f\x7f]/u.test(s))) invalid();
  } else invalid();
}

export function configFromEnv(env: NodeJS.ProcessEnv): HttpConfig {
  const mode = env.WALLPAPER_MCP_AUTH_MODE;
  let auth: AuthConfig;
  if (mode === 'localBearer') {
    auth = { mode, token: env.WALLPAPER_MCP_TOKEN ?? '' };
  } else if (mode === 'oauth') {
    let subjects: string[];
    try { subjects = JSON.parse(env.WALLPAPER_MCP_ALLOWED_SUBJECTS ?? 'null') as string[]; }
    catch { return invalid(); }
    auth = { mode, resource: env.WALLPAPER_MCP_RESOURCE_URL ?? '', issuer: env.WALLPAPER_MCP_ISSUER ?? '',
      jwksUrl: env.WALLPAPER_MCP_JWKS_URL ?? '', subjects };
  } else return invalid();
  const rawPort = env.WALLPAPER_MCP_PORT ?? '3211';
  if (!/^\d{1,5}$/u.test(rawPort)) invalid();
  const config = { port: Number(rawPort), auth };
  validateConfig(config);
  return config;
}
