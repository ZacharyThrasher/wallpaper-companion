import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Catalog } from "../catalog.js";
import { CatalogError, type CatalogRepository } from "../domain.js";
import { defaultDatabasePath } from "../cli.js";
import { SqliteCatalogRepository } from "../adapters/sqlite.js";
import { createGalleryServer } from "./server.js";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    port: { type: "string", default: "4318" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Wallpaper Companion gallery: --db <catalog.sqlite> --port <1..65535>\nOpen the printed 127.0.0.1 URL. Read-only; scanning stays in the CLI.",
  );
} else {
  const port = Number(values.port);
  if (
    !/^\d+$/.test(values.port!) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Port must be between 1 and 65535.");
  const database = path.resolve(values.db ?? defaultDatabasePath());
  let repository: CatalogRepository | undefined;
  const empty = new Catalog({
    read: () => null,
    close() {},
    replace() {
      throw new CatalogError("READ_ONLY", "Gallery is read-only.");
    },
  });
  const server = createGalleryServer({
    catalog: () => {
      if (!repository && existsSync(database))
        repository = new SqliteCatalogRepository(database, true);
      return repository ? new Catalog(repository) : empty;
    },
    uiDirectory: fileURLToPath(new URL("../../../ui-dist/", import.meta.url)),
    scanCommand: values.db
      ? `node dist/src/cli.js scan --db '${database.replaceAll("'", "''")}' --json`
      : "node dist/src/cli.js scan --json",
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "Gallery port is in use. Choose another with --port."
        : "Gallery could not start. Check the port and local network permissions.",
    );
    repository?.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Wallpaper Companion: http://127.0.0.1:${port}\nRead-only local gallery. Press Ctrl+C to stop.`,
    ),
  );
  const stop = () =>
    server.close(() => {
      repository?.close();
      process.exitCode = 0;
    });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
