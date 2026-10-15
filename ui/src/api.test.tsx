import { afterEach, expect, test, vi } from "vitest";
import { loadLibrary } from "./api";
afterEach(() => vi.unstubAllGlobals());
const status = {
  indexRevision: 9,
  data: { indexed: true },
  observedAt: "2026-01-01T00:00:00Z",
};
test("loads every page of the shared snapshot using the same revision", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const data =
        url === "/api/status"
          ? status
          : url.startsWith("/api/playlists")
            ? { data: [{ id: "pl_sample" }], pagination: { nextOffset: null } }
            : url.includes("offset=0")
              ? { data: [{ id: "wp_first" }], pagination: { nextOffset: 500 } }
              : { data: [{ id: "wp_last" }], pagination: { nextOffset: null } };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  const result = await loadLibrary(new AbortController().signal);
  expect(result.wallpapers.map((item) => item.id)).toEqual([
    "wp_first",
    "wp_last",
  ]);
  expect(result.playlists.map((item) => item.id)).toEqual(["pl_sample"]);
  expect(
    urls
      .filter((url) => url !== "/api/status")
      .every((url) => url.includes("revision=9")),
  ).toBe(true);
});
test("does not request lists before an index exists", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ...status, data: { indexed: false } })),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await loadLibrary(new AbortController().signal);
  expect(result.wallpapers).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("rejects a changed revision instead of combining different snapshots", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/status"
        ? new Response(JSON.stringify(status))
        : new Response(
            JSON.stringify({
              error: {
                code: "REVISION_CHANGED",
                message: "The index changed; refresh.",
              },
            }),
            { status: 409 },
          ),
    ),
  );
  await expect(loadLibrary(new AbortController().signal)).rejects.toThrow(
    "The index changed; refresh.",
  );
});
