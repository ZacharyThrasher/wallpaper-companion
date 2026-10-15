import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Catalog } from "../catalog.js";
import { type IndexedSnapshot, type Wallpaper } from "../domain.js";
import { createGalleryServer } from "./server.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64",
);
async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "companion-gallery-")),
  );
  const project = path.join(root, "project");
  const ui = path.join(root, "ui");
  await fs.mkdir(project);
  await fs.mkdir(ui);
  await fs.writeFile(path.join(project, "project.json"), "{}");
  await fs.writeFile(path.join(project, "preview.png"), png);
  await fs.writeFile(path.join(ui, "index.html"), "<h1>Synthetic library</h1>");
  const wallpaper: Wallpaper = {
    id: "wp_sample",
    title: "Synthetic sample",
    type: "scene",
    tags: ["test"],
    projectPath: path.join(project, "project.json"),
    preview: path.join(project, "preview.png"),
    playableTarget: null,
    availability: "available",
    provenance: [],
    metadata: { cache: [] },
    observedAt: "2026-01-01T00:00:00Z",
  };
  const snapshot: IndexedSnapshot = {
    indexRevision: 1,
    observedAt: wallpaper.observedAt,
    diagnostics: [],
    sourceFiles: [],
    wallpapers: [wallpaper],
    playlists: [
      {
        id: "pl_sample",
        name: "Synthetic playlist",
        profile: "fixture",
        items: [
          {
            position: 1,
            wallpaperId: null,
            file: null,
            resolution: "unresolved",
            raw: null,
          },
          {
            position: 2,
            wallpaperId: wallpaper.id,
            file: null,
            resolution: "resolved",
            raw: null,
          },
        ],
        settings: null,
        raw: {},
        provenance: { source: "saved-playlist", path: "", position: 0 },
        observedAt: wallpaper.observedAt,
      },
    ],
  };
  const catalog = new Catalog({
    read: () => snapshot,
    replace() {
      throw new Error("Read only");
    },
    close() {},
  });
  const server = createGalleryServer({
    catalog: () => catalog,
    uiDirectory: ui,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  return { root, project, wallpaper, catalog, snapshot, base, port };
}
test("serves catalog API parity and an ordered playlist without altering the snapshot", async (t) => {
  const f = await fixture(t);
  for (const [route, expected] of [
    ["status", f.catalog.status()],
    [
      "wallpapers?type=scene&tag=test",
      f.catalog.listWallpapers({ type: "scene", tag: "test" }),
    ],
    ["playlists", f.catalog.listPlaylists()],
    ["wallpapers/wp_sample", f.catalog.getWallpaper("wp_sample")],
    ["playlists/pl_sample", f.catalog.getPlaylist("pl_sample")],
  ] as const) {
    const response = await fetch(`${f.base}/api/${route}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (route === "status") delete body.scanCommand;
    assert.equal(response.status, 200);
    assert.deepEqual(body, expected);
  }
});
test("rejects remote origins, hostile Host values, cross-site image requests and writes", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: `http://localhost:${f.port}` },
  ]) {
    const response = await fetch(`${f.base}/api/status`, { headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(
      JSON.stringify(await response.json()).includes("Synthetic"),
      false,
    );
  }
  const hostileHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: f.port,
          path: "/api/status",
          headers: { Host: `attacker.example:${f.port}` },
        },
        (result) => {
          result.resume();
          resolve(result.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
  assert.equal(hostileHost, 403);
  assert.equal(
    (await fetch(`${f.base}/api/status`, { method: "POST" })).status,
    405,
  );
  assert.equal(
    (await fetch(`${f.base}/api/status`, { headers: { Origin: f.base } }))
      .status,
    200,
  );
});
test("requires an explicit Host header even for direct HTTP requests", async (t) => {
  const f = await fixture(t);
  const response = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: f.port,
        path: "/api/status",
        setHost: false,
      },
      (result) => {
        result.resume();
        resolve(result.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(response, 400); // Node rejects missing Host before the request handler.
});
test("serves only registered raster previews by ID with hardened headers and HEAD support", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/wallpapers/wp_sample/preview`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const head = await fetch(`${f.base}/api/wallpapers/wp_sample/preview`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const resource of [
    "wp_absent/preview",
    "..%2Fproject.json/preview",
    "wp_sample/preview?path=C:/secret",
    "wp_sample/preview?url=http://example.com",
    "%2e%2e/preview",
  ]) {
    assert.equal(
      (await fetch(`${f.base}/api/wallpapers/${resource}`)).status,
      404,
    );
  }
});
test("rejects traversal and symlink escapes in indexed preview paths", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.png");
  await fs.writeFile(outside, png);
  f.wallpaper.preview = outside;
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
  const link = path.join(f.project, "link");
  await fs.symlink(
    f.root,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.wallpaper.preview = path.join(link, "outside.png");
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
});
test("refuses a project root replaced by an alias", async (t) => {
  const f = await fixture(t);
  const moved = path.join(f.root, "moved");
  await fs.rename(f.project, moved);
  await fs.symlink(
    moved,
    f.project,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
});
test("blocks SVG, oversized files, missing previews and directories", async (t) => {
  const f = await fixture(t);
  const preview = f.wallpaper.preview!;
  await fs.writeFile(
    preview,
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
  await fs.writeFile(preview, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
  await fs.unlink(preview);
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    404,
  );
  f.wallpaper.preview = f.project;
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    422,
  );
  f.wallpaper.preview = null;
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers/wp_sample/preview`)).status,
    404,
  );
});
test("returns actionable empty/error states and rejects malformed filters", async (t) => {
  const f = await fixture(t);
  for (const suffix of [
    "?limit=0",
    "?limit=501",
    "?offset=-1",
    "?type=scene&type=web",
    "?path=x",
    "?availability=other",
  ])
    assert.equal(
      (await fetch(`${f.base}/api/wallpapers${suffix}`)).status,
      400,
    );
  assert.equal(
    (await fetch(`${f.base}/api/wallpapers?revision=99`)).status,
    409,
  );
  assert.equal(
    (await fetch(`${f.base}/`)).headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
    true,
  );
  assert.equal((await fetch(`${f.base}/src/secret.ts`)).status, 404);
  assert.equal(
    (await fetch(`${f.base}/%2e%2e%2fproject/project.json`)).status,
    404,
  );
  assert.equal((await fetch(`${f.base}/%ZZ`)).status, 400);
});
