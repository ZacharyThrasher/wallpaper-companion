import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { loadLibrary, type Library } from "./api";
import type { Wallpaper, Playlist } from "../../src/domain";
vi.mock("./api", () => ({ loadLibrary: vi.fn() }));
const wallpaper = (id: string, title: string, extra = {}): Wallpaper => ({
  id,
  title,
  type: "scene",
  tags: ["Nature"],
  projectPath: "fixture/project.json",
  playableTarget: null,
  preview: "fixture/preview.png",
  availability: "available",
  metadata: { cache: [] },
  provenance: [],
  observedAt: "2026-01-01T12:00:00Z",
  ...extra,
});
const walls = [
  wallpaper("wp_a", "Alpine light"),
  wallpaper("wp_b", "Blue hour", { availability: "missing", type: "video" }),
];
const playlist: Playlist = {
  id: "pl_test",
  name: "Quiet evenings",
  profile: "Synthetic",
  items: [
    {
      position: 2,
      wallpaperId: "wp_a",
      resolution: "resolved",
      file: null,
      raw: null,
    },
    {
      position: 0,
      wallpaperId: "wp_b",
      resolution: "resolved",
      file: null,
      raw: null,
    },
    {
      position: 1,
      wallpaperId: null,
      resolution: "unresolved",
      file: null,
      raw: null,
    },
    {
      position: 3,
      wallpaperId: "wp_b",
      resolution: "resolved",
      file: null,
      raw: null,
    },
  ],
  settings: null,
  raw: {},
  provenance: { source: "saved-playlist", path: "", position: 0 },
  observedAt: "",
};
function library(): Library {
  return {
    status: {
      indexRevision: 7,
      observedAt: "2026-01-01T12:00:00Z",
      diagnostics: [
        {
          code: "TEST_NOTICE",
          message: "Synthetic diagnostic",
          severity: "warning",
        },
      ],
      data: { indexed: true, wallpapers: walls.length, playlists: 1 },
      scanCommand: "node dist/src/cli.js scan --json",
    },
    wallpapers: walls,
    playlists: [playlist],
  };
}
beforeEach(() => vi.mocked(loadLibrary).mockResolvedValue(library()));
afterEach(() => vi.clearAllMocks());
test("shows loading before the real result, timestamp, and collapsed diagnostics", async () => {
  let finish!: (value: Library) => void;
  vi.mocked(loadLibrary).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading your local library",
  );
  finish(library());
  await screen.findByRole("button", { name: "View Alpine light" });
  expect(document.querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-01-01T12:00:00.000Z",
  );
  expect(
    screen.getByText("Index details · 1 notices").closest("details"),
  ).not.toHaveAttribute("open");
});
test("teaches setup for an unindexed or empty catalog", async () => {
  const data = library();
  data.status.data.indexed = false;
  data.wallpapers = [];
  data.playlists = [];
  vi.mocked(loadLibrary).mockResolvedValue(data);
  render(<App />);
  await screen.findByText("Bring your local library into view");
  expect(
    screen.getAllByText("node dist/src/cli.js scan --json").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
});
test("reports a connection failure and retry recovers", async () => {
  vi.mocked(loadLibrary).mockRejectedValueOnce(
    new Error("Local server unavailable."),
  );
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Local server unavailable.",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: "View Alpine light" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test("filters titles and availability, then clears to all results", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("searchbox");
  await user.type(screen.getByRole("searchbox"), "no match");
  expect(
    screen.getByRole("heading", { name: "No matching wallpapers" }),
  ).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
  await user.click(screen.getByText("Filters", { exact: true }));
  await user.selectOptions(screen.getByLabelText("Availability"), "missing");
  expect(
    screen.queryByRole("button", { name: "View Alpine light" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "View Blue hour" }),
  ).toBeInTheDocument();
});
test("keeps saved order, repeated memberships, and unresolved entries visible", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("searchbox");
  await user.click(screen.getByRole("button", { name: /Quiet evenings/ }));
  const grid = document.querySelector(".wallpaper-grid")!;
  expect(
    within(grid as HTMLElement)
      .getAllByRole("button")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual([
    "View Blue hour, entry 1",
    "View Alpine light, entry 3",
    "View Blue hour, entry 4",
  ]);
  expect(screen.getByText("Unresolved entry")).toBeInTheDocument();
  expect(screen.getByText("Kept in saved order")).toBeInTheDocument();
});
test("keyboard selection focuses details, Escape restores focus, and broken previews have a real fallback", async () => {
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByRole("button", { name: "View Alpine light" });
  card.focus();
  await user.keyboard("{Enter}");
  const panel = screen.getByRole("complementary");
  expect(panel).toHaveFocus();
  card.focus();
  await user.keyboard("{Enter}");
  expect(panel).toHaveFocus();
  const image = panel.querySelector("img")!;
  fireEvent.error(image);
  expect(within(panel).getByText("Preview unavailable")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(card).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "View Blue hour" })).toHaveFocus();
});
test("empty playlists remain selectable", async () => {
  const data = library();
  data.playlists[0] = { ...playlist, items: [] };
  vi.mocked(loadLibrary).mockResolvedValue(data);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("searchbox");
  await user.click(screen.getByRole("button", { name: /Quiet evenings/ }));
  await screen.findByRole("heading", { name: "This playlist is empty" });
});
