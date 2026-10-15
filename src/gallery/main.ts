import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultDatabasePath } from "../adapters/database-path.js";
import { createGalleryServer } from "./server.js";
import { createCompanionRuntime } from '../workflow/runtime.js';

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    preferences: { type: 'string' },
    port: { type: "string", default: "4318" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Wallpaper Companion gallery: --db <catalog.sqlite> --preferences <preferences.sqlite> --port <1..65535>\nOpen the printed 127.0.0.1 URL. Guided discovery, explicit refresh and playback actions.",
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
  const companion = createCompanionRuntime(database, values.preferences);
  const server = createGalleryServer({
    catalog: () => companion.catalog,
    companion,
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
    companion.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Wallpaper Companion: http://127.0.0.1:${port}\nLocal gallery and discovery. Press Ctrl+C to stop.`,
    ),
  );
  const stop = () =>
    server.close(() => {
      companion.close();
      process.exitCode = 0;
    });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
