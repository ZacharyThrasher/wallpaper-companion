import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Catalog } from '../src/catalog.js';
import type { ReadOnlyCatalog } from '../src/mcp/server.js';
import { configFromEnv, readScope, type AuthConfig } from '../src/mcp-http/config.js';
import { createAuthenticator } from '../src/mcp-http/auth.js';
import { maxBodyBytes, requestDeadlineMs, startHttpMcp } from '../src/mcp-http/server.js';

// Synthetic secrets, subjects, paths, and keys only; never use the user's catalog or accounts.
const token = 'synthetic-Test-Secret_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const bearer: AuthConfig = { mode: 'localBearer', token };
const oauth: Extract<AuthConfig, { mode: 'oauth' }> = { mode: 'oauth', resource: 'https://catalog.example/mcp',
  issuer: 'https://identity.example/', jwksUrl: 'https://identity.example/keys', subjects: ['fixture-owner'] };
const keys = await generateKeyPair('ES256');
const localKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'ES256' }] });
const now = () => Math.floor(Date.now() / 1000);
async function jwt(overrides: Record<string, unknown> = {}, key = keys.privateKey, header = {}) {
  return new SignJWT({ iss: oauth.issuer, aud: oauth.resource, sub: oauth.subjects[0]!, exp: now() + 120,
    scope: readScope, ...overrides }).setProtectedHeader({ alg: 'ES256', kid: 'fixture', ...header }).sign(key);
}
function fixture() {
  let reads = 0;
  const catalog = new Catalog({ read() { reads++; return { indexRevision: 1, wallpapers: [], playlists: [],
    observedAt: '2026-01-01T00:00:00.000Z', sourceFiles: [], diagnostics: [] }; },
    replace() { throw new Error('Read-only fixture.'); }, close() {} });
  return { catalog, reads: () => reads };
}
const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog_status', arguments: {} } };
const requestHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
type Response = { status: number; headers: import('node:http').IncomingHttpHeaders; text: string };
function http(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; chunks?: string[] } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'POST', headers: options.headers ?? requestHeaders }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end(options.body ?? ((options.method ?? 'POST') === 'POST' ? JSON.stringify(call) : undefined));
  });
}

for (const modern of [false, true]) {
  test(`HTTP SDK ${modern ? 'modern discovery' : 'legacy initialize'}/list/call uses shared read-only tools`, async t => {
    const f = fixture();
    const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer });
    t.after(server.close);
    const observedAuth: (string | null)[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, options) => { observedAuth.push(new Headers(options?.headers).get('authorization')); return fetch(url, options); }
    });
    const client = new Client({ name: 'http-fixture', version: '1.0.0' }, modern
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'wallpaper-companion');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['catalog_status', 'get_playlist', 'get_preview', 'get_wallpaper', 'list_playlists', 'list_wallpapers']);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const status = await client.callTool({ name: 'catalog_status', arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { indexRevision: number }).indexRevision, 1);
    assert.equal(f.reads(), 1);
    assert.ok(observedAuth.length >= 3);
    assert.ok(observedAuth.every(auth => auth === `Bearer ${token}`));
    const unauthenticated = await http(server.url, { headers: { 'content-type': 'application/json' } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(f.reads(), 1, 'previous initialization cannot authorize the next request');
  });
}

test('all MCP HTTP methods authenticate before SDK/tool execution; bad tokens and query credentials fail', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer }); t.after(server.close);
  for (const method of ['POST', 'GET', 'DELETE', 'PUT', 'OPTIONS']) {
    for (const authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${token} extra`]) {
      const response = await http(server.url, { method, headers: { ...requestHeaders, authorization } });
      assert.equal(response.status, 401, `${method}: ${authorization}`);
      assert.equal(response.headers['www-authenticate'], 'Bearer error="invalid_token"');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.text.includes(token));
    }
  }
  assert.equal((await http(`${server.url}?access_token=${token}`, { headers: {} })).status, 404);
  assert.equal((await http(server.url.replace('/mcp', '/.well-known/oauth-protected-resource'), { method: 'GET' })).status, 404);
  assert.equal(f.reads(), 0);
});

test('strict Host and Origin checks block rebinding, alternate ports/schemes, and forged forwarded hosts', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer }); t.after(server.close);
  const url = new URL(server.url);
  for (const headers of [
    { host: 'attacker.example' }, { host: '127.0.0.1:1' }, { host: `${url.host}.attacker.example` },
    { origin: 'https://attacker.example' }, { origin: 'null' }, { origin: 'http://localhost:1' },
    { origin: `https://${url.host}` }, { origin: `http://${url.host}/` },
    { host: 'attacker.example', 'x-forwarded-host': url.host }
  ]) {
    assert.equal((await http(server.url, { headers: { ...requestHeaders, ...headers } })).status, 403);
  }
  assert.equal(f.reads(), 0);
  assert.equal((await http(server.url, { headers: { ...requestHeaders, host: `localhost:${url.port}`, origin: `http://localhost:${url.port}` } })).status, 200);
  assert.equal(f.reads(), 1);
});

test('OAuth signed fixture works over SDK HTTP, public host and path-specific discovery', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: oauth }, { oauthKeyResolver: localKeys }); t.after(server.close);
  const signed = await jwt();
  const client = new Client({ name: 'oauth-fixture', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${signed}` } } }));
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal((await client.callTool({ name: 'catalog_status', arguments: {} })).isError, undefined);
  const denied = await http(server.url, { headers: {} });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['www-authenticate'], 'Bearer resource_metadata="https://catalog.example/.well-known/oauth-protected-resource/mcp", scope="wallpaper:read", error="invalid_token"');
  for (const suffix of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await http(server.url.replace('/mcp', suffix), { method: 'GET', headers: { host: 'catalog.example', origin: 'https://catalog.example' } });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { resource: oauth.resource, authorization_servers: [oauth.issuer],
      scopes_supported: [readScope], bearer_methods_supported: ['header'] });
    assert.ok(!response.text.includes('fixture-owner'));
    assert.ok(!response.text.includes('keys'));
  }
  const response = await http(server.url, { headers: { ...requestHeaders, authorization: `Bearer ${signed}`, host: 'catalog.example', origin: 'https://catalog.example' } });
  assert.equal(response.status, 200);
});

test('OAuth rejects bad signature, issuer, audience, expiry, missing claims, subject, scope, and future nbf', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: oauth }, { oauthKeyResolver: localKeys }); t.after(server.close);
  const otherKeys = await generateKeyPair('ES256');
  const cases: [string, string, number][] = [
    ['signature', await jwt({}, otherKeys.privateKey), 401],
    ['issuer', await jwt({ iss: 'https://other.example/' }), 401],
    ['audience', await jwt({ aud: 'https://catalog.example/other' }), 401],
    ['expired', await jwt({ exp: now() - 1 }), 401],
    ['no-exp', await jwt({ exp: undefined }), 401],
    ['no-subject', await jwt({ sub: undefined }), 401],
    ['subject', await jwt({ sub: 'another-user' }), 401],
    ['not-yet-valid', await jwt({ nbf: now() + 120 }), 401],
    ['missing scope', await jwt({ scope: undefined }), 403],
    ['substring scope', await jwt({ scope: 'wallpaper:read:all' }), 403],
    ['array scope', await jwt({ scope: [readScope] }), 403],
    ['invalid JWT', 'a.b.c', 401]
  ];
  for (const [name, signed, expected] of cases) {
    const response = await http(server.url, { headers: { ...requestHeaders, authorization: `Bearer ${signed}` } });
    assert.equal(response.status, expected, name);
    assert.ok(!response.text.includes(signed));
    assert.ok(!response.text.includes('fixture-owner'));
    assert.ok(!response.text.includes('identity.example'));
    if (expected === 403) assert.match(response.headers['www-authenticate']!, /error="insufficient_scope"/);
  }
  assert.equal(f.reads(), 0);
  const allowed = await jwt({ scope: `other ${readScope}` }, keys.privateKey, { jku: 'https://untrusted.example/keys' });
  assert.equal((await http(server.url, { headers: { ...requestHeaders, authorization: `Bearer ${allowed}` } })).status, 200);
  assert.equal(f.reads(), 1, 'signed tokens cannot redirect key discovery through a jku header');
});

test('OAuth JWKS failures fail closed without exposing resolver errors', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: oauth }, {
    oauthKeyResolver: async () => { throw new Error('private provider details C:/synthetic/private'); }
  }); t.after(server.close);
  const response = await http(server.url, { headers: { ...requestHeaders, authorization: `Bearer ${await jwt()}` } });
  assert.equal(response.status, 401);
  assert.ok(!response.text.includes('private'));
  assert.equal(f.reads(), 0);
});

test('production JOSE resolver uses only configured HTTPS keys, caches, and bounds retrieval', async t => {
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'ES256' }] };
  await t.test('fixed URL, no redirects, successful cache and unknown-key cooldown', async t => {
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
      fetches++;
      assert.equal(input, oauth.jwksUrl); assert.equal(options.redirect, 'manual');
      assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal);
      return Response.json(jwks);
    });
    const auth = createAuthenticator(oauth);
    const signed = await jwt({}, keys.privateKey, { jku: 'https://untrusted.example/keys' });
    assert.equal(await auth(`Bearer ${signed}`), 'allowed');
    assert.equal(await auth(`Bearer ${signed}`), 'allowed');
    assert.equal(await auth(`Bearer ${await jwt({}, keys.privateKey, { kid: 'unknown' })}`), 'invalid_token');
    assert.equal(fetches, 1, 'cached keys and successful-fetch cooldown prevent repeated retrieval');
  });
  for (const [name, response] of [
    ['redirect', () => new Response('', { status: 302, headers: { location: 'https://untrusted.example/keys' } })],
    ['oversized keys body', () => new Response('x'.repeat(65_537))],
    ['too many keys', () => Response.json({ keys: Array.from({ length: 65 }, () => jwks.keys[0]) })],
    ['malformed key JSON', () => new Response('{')]
  ] as const) {
    await t.test(name, async t => {
      t.mock.method(globalThis, 'fetch', async () => response());
      assert.equal(await createAuthenticator(oauth)(`Bearer ${await jwt()}`), 'invalid_token');
    });
  }
  await t.test('fetch deadline fails closed', { timeout: 5_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async (_input: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    }));
    const start = Date.now();
    assert.equal(await createAuthenticator(oauth)(`Bearer ${await jwt()}`), 'invalid_token');
    assert.ok(Date.now() - start < 4_500);
  });
});

test('duplicate security headers and oversized HTTP headers are rejected before catalog access', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer }); t.after(server.close);
  const host = new URL(server.url).host;
  for (const [name, value] of [['Host', host], ['Origin', `http://${host}`], ['Authorization', `Bearer ${token}`]]) {
    const status = await new Promise<number>((resolve, reject) => {
      const headers = ['Host', host, 'Authorization', `Bearer ${token}`, 'Content-Type', 'application/json'];
      if (name === 'Origin') headers.push(name!, value!);
      headers.push(name!, value!);
      const req = request(server.url, { method: 'POST', headers }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 400, name);
  }
  const response = await http(server.url, { headers: { ...requestHeaders, 'x-oversized': 'private'.repeat(3_000) } });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.text), { error: 'Invalid HTTP request.' });
  assert.equal(f.reads(), 0);
});

test('HTTP bounds reject oversized declared and chunked bodies, malformed JSON, encoding, and unsupported methods', async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer }); t.after(server.close);
  for (const options of [
    { body: 'x'.repeat(maxBodyBytes + 1), headers: { ...requestHeaders, 'content-length': String(maxBodyBytes + 1) } },
    { chunks: ['x'.repeat(32_768), 'x'.repeat(32_769)], body: '' }
  ]) assert.equal((await http(server.url, options)).status, 413);
  assert.equal((await http(server.url, { body: '{"private":"C:/synthetic/private","token":"' + token })).status, 400);
  assert.equal((await http(server.url, { headers: { ...requestHeaders, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await http(server.url, { headers: { ...requestHeaders, 'content-encoding': 'gzip' } })).status, 415);
  for (const method of ['GET', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await http(server.url, { method })).status, 405, method);
  assert.equal(f.reads(), 0);
  for (const suffix of ['/mcp/', '/%6dcp', '/preview', '/mcp?token=private']) {
    assert.equal((await http(server.url.replace('/mcp', suffix))).status, 404);
  }
  assert.equal((await http(server.url)).status, 200);
});

test('catalog and transport errors do not echo private paths, credentials, or exception details', async t => {
  const f = fixture();
  const broken: ReadOnlyCatalog = Object.assign(f.catalog, { status() { throw new Error(`C:/synthetic/private ${token}`); } });
  const server = await startHttpMcp(broken, { port: 0, auth: bearer }); t.after(server.close);
  const response = await http(server.url);
  assert.equal(response.status, 200);
  assert.match(response.text, /INDEX_UNAVAILABLE/);
  assert.ok(!response.text.includes('C:/synthetic/private'));
  assert.ok(!response.text.includes(token));
  const invalid = await http(server.url, { body: `{"secret":"${token}"` });
  assert.equal(invalid.status, 400);
  assert.ok(!invalid.text.includes(token));
  assert.doesNotThrow(() => JSON.parse(invalid.text));
});

test('configuration fails closed and CLI errors/help do not expose environment secrets', async () => {
  const valid = { WALLPAPER_MCP_AUTH_MODE: 'localBearer', WALLPAPER_MCP_TOKEN: token };
  for (const env of [{}, { ...valid, WALLPAPER_MCP_AUTH_MODE: 'none' }, { ...valid, WALLPAPER_MCP_TOKEN: '' },
    { ...valid, WALLPAPER_MCP_TOKEN: 'a'.repeat(43) }, { ...valid, WALLPAPER_MCP_PORT: '-1' },
    { ...valid, WALLPAPER_MCP_PORT: '65536' }, { WALLPAPER_MCP_AUTH_MODE: 'oauth' },
    { WALLPAPER_MCP_AUTH_MODE: 'oauth', WALLPAPER_MCP_RESOURCE_URL: 'http://catalog.example/mcp' }]) {
    assert.throws(() => configFromEnv(env), /Invalid HTTP MCP configuration/);
  }
  assert.equal(configFromEnv(valid).port, 3211);
  for (const changes of [{ resource: 'http://catalog.example/mcp' }, { resource: 'https://catalog.example/other' },
    { resource: 'https://catalog.example/mcp#' }, { resource: 'https://catalog.example/mcp?' },
    { issuer: 'https://user:pass@identity.example/' }, { jwksUrl: 'http://identity.example/keys' }, { subjects: [] }]) {
    await assert.rejects(startHttpMcp(fixture().catalog, { port: 0, auth: { ...oauth, ...changes } }));
  }
  const entry = fileURLToPath(new URL('../src/mcp-http-cli.js', import.meta.url));
  const failed = spawnSync(process.execPath, [entry, '--db', 'C:/synthetic/private'], {
    encoding: 'utf8', env: { ...process.env, WALLPAPER_MCP_AUTH_MODE: 'bad', WALLPAPER_MCP_TOKEN: token }
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.ok(!failed.stderr.includes(token)); assert.ok(!failed.stderr.includes('C:/synthetic/private'));
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stdout, ''); assert.match(help.stderr, /127.0.0.1/);
});

test('absolute deadline bounds an incomplete authenticated body', { timeout: requestDeadlineMs + 5_000 }, async t => {
  const f = fixture(); const server = await startHttpMcp(f.catalog, { port: 0, auth: bearer }); t.after(server.close);
  const response = await new Promise<Response>((resolve, reject) => {
    const req = request(server.url, { method: 'POST', headers: requestHeaders }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode!, headers: res.headers, text }); req.destroy(); });
    });
    req.on('error', error => { if (!req.destroyed) reject(error); });
    req.write('{'); // Keep the body incomplete without ending the request.
    t.after(() => req.destroy());
  });
  assert.equal(response.status, 408); assert.equal(f.reads(), 0);
  assert.match(response.text, /Request timed out/);
});

test('stop closes active/incomplete connections within a bound and is idempotent', async t => {
  const server = await startHttpMcp(fixture().catalog, { port: 0, auth: bearer }); t.after(server.close);
  const req = request(server.url, { method: 'POST', headers: requestHeaders });
  req.on('error', () => {});
  const connected = new Promise<void>(resolve => req.once('socket', socket => socket.once('connect', resolve)));
  req.write('{'); t.after(() => req.destroy());
  await connected;
  // Let the partial HTTP request arrive before testing shutdown's connection deadline.
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  await server.close(); await server.close();
  assert.ok(Date.now() - started < 3_000);
  await assert.rejects(fetch(server.url));
});
