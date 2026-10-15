/** Synthetic, local-only review data. Never reads the user's library or configuration. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { SqliteCatalogRepository } from "../adapters/sqlite.js";
import type { Wallpaper, Playlist } from "../domain.js";
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
function sampleImage(seed: number) {
  const width = 720,
    height = 450;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  const palettes = [
    [
      [133, 159, 160],
      [87, 118, 114],
      [48, 82, 80],
      [24, 50, 52],
    ],
    [
      [177, 144, 122],
      [126, 98, 95],
      [83, 76, 84],
      [48, 50, 65],
    ],
    [
      [130, 142, 168],
      [97, 111, 147],
      [61, 78, 113],
      [29, 47, 74],
    ],
  ];
  const palette = palettes[seed % palettes.length]!;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let layer = 0;
      for (let i = 1; i <= 3; i++)
        if (
          y >
          130 +
            i * 55 +
            Math.sin(x / (80 + seed * 8) + i * 3 + seed) * (20 + i * 10)
        )
          layer = i;
      let color = palette[layer]!;
      if (layer === 0 && (x - (530 - seed * 22)) ** 2 + (y - 94) ** 2 < 25 ** 2)
        color = [221, 212, 178];
      const position = y * (width * 3 + 1) + x * 3 + 1;
      pixels[position] = color[0]!;
      pixels[position + 1] = color[1]!;
      pixels[position + 2] = color[2]!;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const root = path.resolve(".local/gallery-demo");
await fs.mkdir(root, { recursive: true });
const names = [
  "Stillwater",
  "Dusk ridge",
  "Blue horizon",
  "Forest layers",
  "Evening passage",
  "Northern quiet",
  "Open valley",
  "Last light",
  "Soft coastline",
];
const observedAt = new Date().toISOString();
const wallpapers: Wallpaper[] = [];
for (const [index, name] of names.entries()) {
  const directory = path.join(root, `sample-${index}`);
  await fs.mkdir(directory, { recursive: true });
  const projectPath = path.join(directory, "project.json");
  const preview = path.join(directory, "preview.png");
  await fs.writeFile(
    projectPath,
    JSON.stringify({
      title: `Sample: ${name}`,
      type: "scene",
      file: "scene.pkg",
      preview: "preview.png",
    }),
  );
  await fs.writeFile(preview, sampleImage(index));
  wallpapers.push({
    id: `wp_demo${index}`,
    title: `Sample: ${name}`,
    type: index % 3 ? "scene" : "video",
    tags: index % 2 ? ["Landscape", "Warm"] : ["Landscape", "Cool"],
    projectPath,
    preview: index === 7 ? null : preview,
    playableTarget: null,
    availability:
      index === 6 ? "missing" : index === 8 ? "unsupported" : "available",
    provenance: [],
    metadata: { cache: [] },
    observedAt,
  });
}
const playlists: Playlist[] = [
  {
    id: "pl_demo",
    name: "Sample: Quiet evenings",
    profile: "Synthetic profile",
    items: [3, 1, -1, 4, 3].map((value, position) => ({
      position,
      wallpaperId: value < 0 ? null : wallpapers[value]!.id,
      file: null,
      resolution: value < 0 ? "unresolved" : "resolved",
      raw: null,
    })),
    settings: null,
    raw: {},
    provenance: { source: "saved-playlist", path: "", position: 0 },
    observedAt,
  },
  {
    id: "pl_empty",
    name: "Sample: Empty playlist",
    profile: "Synthetic profile",
    items: [],
    settings: null,
    raw: {},
    provenance: { source: "saved-playlist", path: "", position: 1 },
    observedAt,
  },
];
const repository = new SqliteCatalogRepository(
  path.join(root, "catalog.sqlite"),
);
try {
  repository.replace({
    wallpapers,
    playlists,
    observedAt,
    diagnostics: [
      {
        code: "SYNTHETIC_DEMO",
        severity: "warning",
        message:
          "Synthetic review library. These images and playlists are test fixtures, not your Wallpaper Engine library.",
      },
    ],
    sourceFiles: [],
  });
} finally {
  repository.close();
}
console.log(
  "Synthetic review index created. Launch: npm run gallery -- --db .local/gallery-demo/catalog.sqlite",
);
