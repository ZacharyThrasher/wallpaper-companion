import http, { type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Catalog, type Query } from "../catalog.js";
import { CatalogError } from "../domain.js";
import { inside } from "../adapters/files.js";
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod/v4';
import { WorkflowError } from '../workflow/preferences.js';
import { WorkshopError } from '../workshop/types.js';
import { PlaybackError } from '../playback/types.js';
import type { WorkflowService } from '../workflow/service.js';
import type { PlaybackService } from '../playback/service.js';
import * as z from 'zod/v4';

const MAX_PREVIEW = 16 * 1024 * 1024;
const identifier = /^[a-z][a-z0-9]*_[a-zA-Z0-9_-]{1,128}$/;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
function failure(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: { code, message } }));
}
function query(url: URL): Query {
  const result: Record<string, string | number> = {};
  for (const [key, value] of url.searchParams) {
    if (
      ![
        "search",
        "type",
        "tag",
        "availability",
        "offset",
        "limit",
        "revision",
      ].includes(key) ||
      key in result ||
      value.length > 500
    ) {
      throw new CatalogError(
        "INVALID_ARGUMENT",
        "Unknown, duplicate, or oversized query parameter.",
      );
    }
    if (["offset", "limit", "revision"].includes(key)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new CatalogError(
          "INVALID_ARGUMENT",
          "Expected a nonnegative integer.",
        );
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result as Query;
}
function imageType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (
    bytes.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
  )
    return "image/gif";
  if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}
/** ID-only preview access. Refuse aliased project roots, escaped previews, changed files, and active formats. */
export async function readPreview(catalog: Catalog, id: string) {
  const preview = catalog.getPreview(id).data;
  if (!preview.path)
    throw new CatalogError("PREVIEW_UNAVAILABLE", "No indexed image preview.");
  const project = path.resolve(preview.projectPath);
  const approvedRoot = path.dirname(project);
  const canonicalRoot = await fs.realpath(approvedRoot);
  const equal = (a: string, b: string) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  if (
    !equal(canonicalRoot, approvedRoot) ||
    !equal(await fs.realpath(project), project) ||
    !(await fs.stat(project)).isFile()
  ) {
    throw new CatalogError(
      "PREVIEW_UNSAFE",
      "Project location changed; scan again.",
    );
  }
  const target = path.resolve(preview.path);
  const realTarget = await fs.realpath(target);
  if (!inside(approvedRoot, target) || !inside(canonicalRoot, realTarget))
    throw new CatalogError(
      "PREVIEW_UNSAFE",
      "Preview is outside its indexed project.",
    );
  const handle = await fs.open(realTarget, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PREVIEW || before.size < 4)
      throw new CatalogError(
        "PREVIEW_UNSUPPORTED",
        "Preview must be an image of at most 16 MiB.",
      );
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.stat(target);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs ||
      !equal(await fs.realpath(approvedRoot), canonicalRoot) ||
      !equal(await fs.realpath(target), realTarget)
    ) {
      throw new CatalogError("PREVIEW_CHANGED", "Preview changed; scan again.");
    }
    const bytes = buffer.subarray(0, length);
    const type = imageType(bytes);
    if (!type)
      throw new CatalogError(
        "PREVIEW_UNSUPPORTED",
        "Preview format is not PNG, JPEG, GIF, or WebP.",
      );
    return { bytes, type };
  } finally {
    await handle.close();
  }
}

export interface GalleryOptions {
  catalog: () => Catalog;
  uiDirectory: string;
  scanCommand?: string;
  companion?: {
    workflow: WorkflowService;
    playback: Pick<PlaybackService, 'applyWallpaper' | 'activatePlaylist' | 'readCurrent'>;
    refreshLibrary: () => Promise<unknown>;
  };
}
const actionId = z.string().regex(/^(wp|pl)_[a-f0-9]{32}$/);
const applySchema = z.strictObject({ wallpaperId: actionId, monitor: z.number().int().min(0).max(63).default(0) });
const playSchema = z.strictObject({ playlistId: actionId, monitor: z.number().int().min(0).max(63).default(0) });
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new WorkflowError('INVALID_BODY', 'Use application/json.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100_000) throw new WorkflowError('INVALID_BODY', 'Request body exceeds 100,000 bytes.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WorkflowError('INVALID_BODY', 'Expected a JSON object.'); }
}
/** The caller must listen on 127.0.0.1. No CORS or remote-origin access is provided. */
export function createGalleryServer(options: GalleryOptions) {
  const csrf = randomBytes(32).toString('hex');
  return http.createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://steamuserimages-a.akamaihd.net https://images.steamusercontent.com https://shared.fastly.steamstatic.com https://shared.akamai.steamstatic.com https://shared.steamstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      const authority = `127.0.0.1:${request.socket.localPort}`;
      if (
        request.headers.host !== authority ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== `http://${authority}`) ||
        (request.headers["sec-fetch-site"] !== undefined &&
          !["same-origin", "none"].includes(
            String(request.headers["sec-fetch-site"]),
          ))
      ) {
        failure(
          response,
          403,
          "LOCAL_ONLY",
          "Open the gallery using its 127.0.0.1 address.",
        );
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !(request.method === 'POST' && options.companion)) {
        response.setHeader("Allow", "GET, HEAD");
        failure(
          response,
          405,
          "READ_ONLY",
          "The gallery accepts read requests only.",
        );
        return;
      }
      try {
        const url = new URL(request.url ?? "/", `http://${authority}`);
        if (request.method === 'POST') {
          const token = request.headers['x-companion-csrf'];
          if (request.headers.origin !== `http://${authority}` || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) {
            failure(response, 403, 'CSRF_DENIED', 'Reload the view before trying this action.'); return;
          }
          if (url.search) throw new WorkflowError('INVALID_ARGUMENT', 'Actions do not accept query parameters.');
          const input = await body(request); const companion = options.companion!; let result: unknown;
          if (url.pathname === '/api/preferences') result = companion.workflow.save(input);
          else if (url.pathname === '/api/discover') result = await companion.workflow.discover(input);
          else if (url.pathname === '/api/inspect') result = await companion.workflow.inspect(input);
          else if (url.pathname === '/api/apply') result = await companion.playback.applyWallpaper(applySchema.parse(input));
          else if (url.pathname === '/api/play-playlist') result = await companion.playback.activatePlaylist(playSchema.parse(input));
          else if (url.pathname === '/api/refresh') { z.strictObject({}).parse(input); result = await companion.refreshLibrary(); }
          else { failure(response, 404, 'NOT_FOUND', 'Unknown action.'); return; }
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify(result)); return;
        }
        if (url.pathname.startsWith("/api/")) {
          const catalog = options.catalog();
          let result: unknown;
          if (url.pathname === '/api/session' && options.companion && !url.search) result = { csrf };
          else if (['/api/discovery-context', '/api/shortlist'].includes(url.pathname) && options.companion) {
            if ([...url.searchParams.keys()].join(',') !== 'reference') throw new WorkflowError('INVALID_ARGUMENT', 'Provide one reference.');
            const reference = url.searchParams.get('reference')!;
            result = url.pathname === '/api/shortlist' ? await options.companion.workflow.shortlist(reference) : options.companion.workflow.context(reference);
          }
          else if (url.pathname === '/api/current' && options.companion && !url.search) result = await options.companion.playback.readCurrent({ monitor: 0 });
          else if (url.pathname === "/api/status")
            result = {
              ...catalog.status(),
              scanCommand:
                options.scanCommand ?? "node dist/src/cli.js scan --json",
            };
          else if (url.pathname === "/api/wallpapers")
            result = catalog.listWallpapers(query(url));
          else if (url.pathname === "/api/playlists")
            result = catalog.listPlaylists(query(url));
          else {
            const match =
              /^\/api\/(wallpapers|playlists)\/([^/]+)(\/preview)?$/.exec(
                url.pathname,
              );
            if (!match || !identifier.test(match[2]!) || url.search) {
              failure(response, 404, "NOT_FOUND", "Unknown catalog resource.");
              return;
            }
            const [, kind, id, preview] = match;
            if (preview && kind === "wallpapers") {
              const image = await readPreview(catalog, id!);
              response.writeHead(200, {
                "Content-Type": image.type,
                "Content-Length": image.bytes.length,
              });
              response.end(request.method === "HEAD" ? undefined : image.bytes);
              return;
            }
            if (preview) {
              failure(response, 404, "NOT_FOUND", "Unknown catalog resource.");
              return;
            }
            result =
              kind === "wallpapers"
                ? catalog.getWallpaper(id!)
                : catalog.getPlaylist(id!);
          }
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(
            request.method === "HEAD" ? undefined : JSON.stringify(result),
          );
          return;
        }
        const filename =
          url.pathname === "/"
            ? "index.html"
            : decodeURIComponent(url.pathname.slice(1));
        const root = await fs.realpath(options.uiDirectory);
        const file = path.resolve(root, filename);
        if (
          !inside(root, file) ||
          !mime[path.extname(file)] ||
          !inside(root, await fs.realpath(file))
        ) {
          failure(response, 404, "NOT_FOUND", "Unknown gallery resource.");
          return;
        }
        const bytes = await fs.readFile(file);
        response.writeHead(200, {
          "Content-Type": mime[path.extname(file)]!,
          "Content-Length": bytes.length,
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch (error) {
        if (error instanceof ZodError) { failure(response, 400, 'INVALID_ARGUMENT', 'Invalid or oversized action fields.'); return; }
        if (error instanceof WorkflowError || error instanceof PlaybackError || error instanceof WorkshopError) {
          const status = error.code === 'PREFERENCE_CONFLICT' ? 409 : error.code.startsWith('INVALID') || error.code === 'invalid_input' ? 400 : 503;
          response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { code: error.code, message: error.message,
            ...(error instanceof PlaybackError ? { mayHaveApplied: error.mayHaveApplied } : {}) } })); return;
        }
        if (error instanceof URIError) {
          failure(response, 400, "INVALID_ARGUMENT", "Malformed resource URL.");
          return;
        }
        if (error instanceof CatalogError) {
          const status =
            error.code === "NOT_FOUND" || error.code === "PREVIEW_UNAVAILABLE"
              ? 404
              : error.code.startsWith("PREVIEW_")
                ? 422
                : error.code === "REVISION_CHANGED"
                  ? 409
                  : error.code.startsWith("INVALID_")
                    ? 400
                    : 503;
          failure(response, status, error.code, error.message);
        } else if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          failure(
            response,
            404,
            "NOT_FOUND",
            "The file is unavailable. Scan again if it moved.",
          );
        else
          failure(
            response,
            503,
            "CATALOG_UNAVAILABLE",
            "Cannot read the local catalog. Check file access and run the scan again.",
          );
      }
    },
  );
}
