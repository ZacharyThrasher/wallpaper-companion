import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultDatabasePath } from './adapters/database-path.js';
import { openReadOnlyCatalog } from './mcp/index.js';
import { configFromEnv } from './mcp-http/config.js';
import { startHttpMcp } from './mcp-http/server.js';

export async function startMcpHttp(argv: string[], env = process.env) {
  const { values } = parseArgs({ args: argv, strict: true, options: { db: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stderr.write('Wallpaper Companion authenticated HTTP MCP (read-only)\nUsage: npm run mcp:http -- [--db <index-path>]\nConfigure WALLPAPER_MCP_AUTH_MODE and credentials in the environment. See docs/http-mcp.md.\nBinds 127.0.0.1 only; default port 3211. No scan, write, or wallpaper control.\n');
    return;
  }
  if (values.db === '') throw new Error('Invalid arguments.');
  const config = configFromEnv(env);
  const handle = await startHttpMcp(openReadOnlyCatalog(path.resolve(values.db ?? defaultDatabasePath())), config);
  process.stderr.write(`Wallpaper Companion read-only MCP listening at ${handle.url}\n`);
  return handle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const handle = await startMcpHttp(process.argv.slice(2));
    if (handle) {
      const stop = () => { void handle.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch {
    process.stderr.write('Wallpaper Companion HTTP MCP could not start. Use --help; check configuration and index access.\n');
    process.exitCode = 1;
  }
}
