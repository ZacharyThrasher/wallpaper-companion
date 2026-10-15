import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { defaultDatabasePath } from './adapters/database-path.js';
import { openReadOnlyCatalog } from './mcp/index.js';
import { createCatalogMcpServer } from './mcp/server.js';

const help = `Wallpaper Companion local MCP server (stdio, read-only)
Usage: node <absolute-path>/dist/src/mcp-cli.js [--db <absolute-index-path>]
Options: --db <file> --help
The default index is the catalog CLI's per-user WallpaperCompanion/catalog.sqlite.
Build and scan with the catalog CLI first. This server cannot scan or write.
Node 24.11.1+ (24.x) required; node:sqlite is experimental.
stdout is reserved for MCP protocol traffic; all diagnostics use stderr.`;

/** Starts stdio without writing anything but SDK protocol messages to stdout. */
export function startMcp(argv: string[]): StdioServerHandle | undefined {
  const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
    db: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (positionals.length > 0 || values.db === '') throw new Error('Invalid arguments.');
  if (values.help) { process.stderr.write(`${help}\n`); return; }
  const catalog = openReadOnlyCatalog(path.resolve(values.db ?? defaultDatabasePath()));
  return serveStdio(() => createCatalogMcpServer(catalog), {
    legacy: 'serve',
    onerror: () => process.stderr.write('Wallpaper Companion MCP transport error. Check client protocol messages and the stdio connection.\n')
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const handle = startMcp(process.argv.slice(2));
    if (handle) {
      const shutdown = () => { void handle.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
  } catch {
    // Argument errors can echo arbitrary strings or paths; use a fixed diagnostic.
    process.stderr.write('Wallpaper Companion MCP could not start. Use --help; check arguments and the --db path.\n');
    process.exitCode = 1;
  }
}
