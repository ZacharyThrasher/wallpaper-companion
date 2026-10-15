import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { JWTVerifyGetKey } from 'jose';
import { createCatalogMcpServer, type ReadOnlyCatalog } from '../mcp/server.js';
import { createAuthenticator } from './auth.js';
import { readScope, validateConfig, type HttpConfig } from './config.js';

export const maxBodyBytes = 65_536;
export const requestDeadlineMs = 10_000;
const metadataPath = '/.well-known/oauth-protected-resource/mcp';

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: status === 500 ? -32603 : -32000, message }, id: null }));
}

/** Read with an actual byte bound, including chunked requests, before JSON parsing or SDK dispatch. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const clean = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = () => { clean(); reject(400); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBodyBytes) { req.pause(); clean(); reject(413); }
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch { reject(400); }
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

/** Always binds IPv4 loopback. A public HTTPS proxy and OAuth issuer are separate administrative work. */
export async function startHttpMcp(catalog: ReadOnlyCatalog, config: HttpConfig,
  fixtures: { oauthKeyResolver?: JWTVerifyGetKey } = {}) {
  validateConfig(config);
  // Snapshot config so later caller mutation cannot change authentication or trusted endpoints.
  config = structuredClone(config);
  const auth = config.auth;
  const authenticate = createAuthenticator(auth, fixtures.oauthKeyResolver);
  const handler = createMcpHandler(() => createCatalogMcpServer(catalog), {
    legacy: 'stateless', maxRequestBodySize: maxBodyBytes, maxSubscriptions: 0
  });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: maxBodyBytes });
  let port = config.port;
  let stopping = false;
  const publicUrl = auth.mode === 'oauth' ? new URL(auth.resource) : undefined;
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: requestDeadlineMs,
    headersTimeout: 5_000, keepAliveTimeout: 1_000 }, (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const timer = setTimeout(() => {
      jsonError(res, 408, 'Request timed out.');
      // Finish the fixed error first; then abort any incomplete body/SDK exchange.
      res.once('finish', () => req.destroy());
    }, requestDeadlineMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    res.once('finish', clear); res.once('close', clear);
    void (async () => {
      const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const localOrigins = localHosts.map(host => `http://${host}`);
      const hosts = publicUrl ? [...localHosts, publicUrl.host] : localHosts;
      const origins = publicUrl ? [...localOrigins, publicUrl.origin] : localOrigins;
      // Reject duplicate security-sensitive headers rather than trusting Node's first value.
      for (const name of ['host', 'origin', 'authorization']) {
        if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === name).length > 1) {
          jsonError(res, 400, 'Invalid headers.'); return;
        }
      }
      if (!req.headers.host || !hosts.includes(req.headers.host) ||
          (req.headers.origin !== undefined && !origins.includes(req.headers.origin))) {
        jsonError(res, 403, 'Request origin or host is not allowed.'); return;
      }
      if (stopping) { jsonError(res, 503, 'Server is stopping.'); return; }
      // Exact origin-form targets: no query-string tokens, path aliases, forwarding header trust, or media serving.
      if (auth.mode === 'oauth' && (req.url === metadataPath || req.url === '/.well-known/oauth-protected-resource')) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET'); jsonError(res, 405, 'Method not allowed.'); return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: auth.resource, authorization_servers: [auth.issuer],
          scopes_supported: [readScope], bearer_methods_supported: ['header'] }));
        return;
      }
      if (req.url !== '/mcp') { jsonError(res, 404, 'Not found.'); return; }
      const outcome = await authenticate(req.headers.authorization);
      if (res.writableEnded || res.destroyed) return;
      if (outcome !== 'allowed') {
        const discovery = publicUrl ? `resource_metadata="${publicUrl.origin}${metadataPath}", scope="${readScope}", ` : '';
        res.setHeader('www-authenticate', `Bearer ${discovery}error="${outcome}"`);
        jsonError(res, outcome === 'insufficient_scope' ? 403 : 401, outcome === 'insufficient_scope' ? 'Required scope is missing.' : 'Authentication required.');
        return;
      }
      if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
        res.setHeader('allow', 'POST, GET, DELETE'); jsonError(res, 405, 'Method not allowed.'); return;
      }
      // Node's optional properties include undefined; the adapter's structural type does not.
      const sdkRequest = { method: req.method!, url: req.url!, headers: req.headers,
        [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]() };
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '') ||
            (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
          jsonError(res, 415, 'Expected uncompressed application/json.'); return;
        }
        if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) {
          jsonError(res, 413, 'Request body is too large.'); return;
        }
        let body: unknown;
        try { body = await readBody(req); }
        catch (status) {
          jsonError(res, status === 413 ? 413 : 400, status === 413 ? 'Request body is too large.' : 'Invalid JSON request.');
          return;
        }
        if (res.writableEnded || res.destroyed) return;
        await nodeHandler(sdkRequest, res, body);
      } else await nodeHandler(sdkRequest, res);
    })().catch(() => jsonError(res, 500, 'Internal server error.'));
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  // Parser failures can contain raw packets; return only a fixed JSON error.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"Invalid HTTP request."}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await handler.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await handler.close(); throw new Error('HTTP MCP could not bind.'); }
  port = address.port;
  let closed: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${port}/mcp`, close(): Promise<void> {
    return closed ??= (async () => {
      stopping = true;
      const done = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const deadline = setTimeout(() => server.closeAllConnections(), 1_000);
      deadline.unref();
      try { await handler.close(); await done; }
      finally { clearTimeout(deadline); server.closeAllConnections(); }
    })();
  } };
}
