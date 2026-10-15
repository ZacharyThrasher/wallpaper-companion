import { useEffect, useMemo, useRef, useState } from "react";
import type { Playlist, Wallpaper } from "../../src/domain";
import { loadLibrary, type Library } from "./api";

function Preview({
  wallpaper,
  large = false,
}: {
  wallpaper: Wallpaper;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`preview ${large ? "preview-large" : ""}`}>
      {wallpaper.preview && !failed ? (
        <img
          src={`/api/wallpapers/${encodeURIComponent(wallpaper.id)}/preview`}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="preview-unavailable">
          {failed ? "Preview unavailable" : "No image preview"}
          <small>
            {failed
              ? "The file may have moved or uses an unsupported format."
              : "This item has no indexed preview image."}
          </small>
        </span>
      )}
    </div>
  );
}
function Setup({ command, indexed }: { command: string; indexed: boolean }) {
  return (
    <section className="empty-state">
      <h2>
        {indexed
          ? "Your index has no wallpapers"
          : "Bring your local library into view"}
      </h2>
      <p>
        {indexed
          ? "No wallpaper projects were found in the last scan. Check your Steam paths, then scan again."
          : "Run a read-only scan from the Wallpaper Companion folder. It indexes installed wallpapers and saved playlists."}
      </p>
      <pre>
        <code>{command}</code>
      </pre>
      <p className="muted">
        Then choose Refresh index above. Use the CLI’s <code>--help</code> for
        Steam path and profile options. Your Wallpaper Engine files stay
        untouched.
      </p>
    </section>
  );
}
export function App() {
  const [library, setLibrary] = useState<Library>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [playlistId, setPlaylistId] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [availability, setAvailability] = useState("");
  const [selected, setSelected] = useState<string>();
  const detail = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    loadLibrary(controller.signal)
      .then((data) => {
        setLibrary(data);
        setSelected(undefined);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Cannot load the local catalog.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (selected) detail.current?.focus();
  }, [selected]);
  const wallpapers = library?.wallpapers ?? [];
  const playlists = library?.playlists ?? [];
  const playlist = playlists.find((item) => item.id === playlistId);
  const byId = useMemo(
    () => new Map(wallpapers.map((item) => [item.id, item])),
    [wallpapers],
  );
  const selectedWallpaper = selected ? byId.get(selected) : undefined;
  const types = [...new Set(wallpapers.map((item) => item.type))].sort();
  const tags = [...new Set(wallpapers.flatMap((item) => item.tags))].sort();
  const filtered = Boolean(search || type || tag || availability);
  const matches = (item: Wallpaper) =>
    item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
    (!type || item.type === type) &&
    (!tag || item.tags.includes(tag)) &&
    (!availability || item.availability === availability);
  const entries = playlist
    ? [...playlist.items]
        .sort((a, b) => a.position - b.position)
        .map((item, index) => ({
          key: `${playlist.id}-${index}`,
          wallpaper: item.wallpaperId ? byId.get(item.wallpaperId) : undefined,
          position: index + 1,
        }))
    : [...wallpapers]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((item) => ({
          key: item.id,
          wallpaper: item,
          position: undefined,
        }));
  const visible = entries.filter((item) =>
    item.wallpaper ? matches(item.wallpaper) : !filtered,
  );
  function changePlaylist(id: string) {
    setPlaylistId(id);
    setSearch("");
    setType("");
    setTag("");
    setAvailability("");
    setSelected(undefined);
  }
  function resetFilters() {
    setSearch("");
    setType("");
    setTag("");
    setAvailability("");
    searchInput.current?.focus();
  }
  function closeDetail() {
    setSelected(undefined);
    returnFocus.current?.focus();
  }
  const observed = library?.status.observedAt;
  const date =
    observed && !Number.isNaN(Date.parse(observed))
      ? new Date(observed)
      : undefined;
  const scanCommand =
    library?.status.scanCommand ?? "node dist/src/cli.js scan --json";
  return (
    <>
      <a className="skip-link" href="#library">
        Skip to library
      </a>
      <header className="app-header">
        <a className="brand" href="/">
          Wallpaper Companion
        </a>
        <div className="index-status">
          <span>
            {date ? (
              <>
                Indexed{" "}
                <time
                  dateTime={date.toISOString()}
                  title={date.toLocaleString()}
                >
                  {date.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </>
            ) : (
              "No index yet"
            )}
          </span>
          <button
            className="quiet-button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? "Loading index…" : "Refresh index"}
          </button>
        </div>
      </header>
      <div className={`workspace ${selectedWallpaper ? "has-detail" : ""}`}>
        <nav className="playlist-rail" aria-label="Library and playlists">
          <button
            className={`nav-item library-nav ${!playlistId ? "is-selected" : ""}`}
            aria-current={!playlistId ? "page" : undefined}
            onClick={() => changePlaylist("")}
          >
            All wallpapers <span>{library?.status.data.wallpapers ?? "—"}</span>
          </button>
          <h2>
            Saved playlists <span>{playlists.length}</span>
          </h2>
          <div className="playlist-list">
            {playlists.map((item) => (
              <PlaylistButton
                key={item.id}
                playlist={item}
                selected={playlistId === item.id}
                onClick={() => changePlaylist(item.id)}
              />
            ))}
          </div>
          {!loading && !error && playlists.length === 0 && (
            <p className="rail-note">
              Saved Wallpaper Engine playlists appear after a scan.
            </p>
          )}
          <div className="mobile-playlists">
            <label htmlFor="playlist-view">View</label>
            <select
              id="playlist-view"
              value={playlistId}
              onChange={(event) => changePlaylist(event.target.value)}
            >
              <option value="">All wallpapers</option>
              {playlists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.items.length})
                </option>
              ))}
            </select>
          </div>
          <p className="local-note">
            Local library
            <br />
            <span>Read-only view</span>
          </p>
        </nav>
        <main id="library" className="library" tabIndex={-1}>
          <div className="library-heading">
            <div>
              <h1>{playlist?.name ?? "Your library"}</h1>
              <p className="muted">
                {playlist
                  ? `${playlist.items.length} entries · Saved order${playlist.profile ? ` · ${playlist.profile}` : ""}`
                  : "Installed wallpapers, ready to explore."}
              </p>
            </div>
          </div>
          {error && (
            <section className="error-state" role="alert">
              <h2>Couldn’t read your index</h2>
              <p>{error}</p>
              <p>
                Check that the local server is running. If the index changed
                during loading, refresh to load it again.
              </p>
              <button
                onClick={() => setRefresh((value) => value + 1)}
                disabled={loading}
              >
                Try again
              </button>
            </section>
          )}
          {loading ? (
            <div className="loading-state" role="status">
              <p>Loading your local library…</p>
              <div className="skeleton-grid" aria-hidden="true">
                <div />
                <div />
                <div />
                <div />
                <div />
                <div />
              </div>
            </div>
          ) : (
            !error &&
            library && (
              <>
                {!library.status.data.indexed ||
                (!wallpapers.length && !playlist) ? (
                  <Setup
                    command={scanCommand}
                    indexed={library.status.data.indexed}
                  />
                ) : (
                  <>
                    <div className="toolbar">
                      <label className="search-label">
                        Search titles
                        <input
                          ref={searchInput}
                          type="search"
                          placeholder={
                            playlist
                              ? "Search this playlist"
                              : "Find a wallpaper"
                          }
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </label>
                      <details className="filters">
                        <summary>
                          Filters
                          {type || tag || availability ? " · Active" : ""}
                        </summary>
                        <div className="filter-fields">
                          <label>
                            Type
                            <select
                              value={type}
                              onChange={(event) => setType(event.target.value)}
                            >
                              <option value="">All types</option>
                              {types.map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Tag
                            <select
                              value={tag}
                              onChange={(event) => setTag(event.target.value)}
                            >
                              <option value="">All tags</option>
                              {tags.map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Availability
                            <select
                              value={availability}
                              onChange={(event) =>
                                setAvailability(event.target.value)
                              }
                            >
                              <option value="">All items</option>
                              <option value="available">Available</option>
                              <option value="missing">Missing files</option>
                              <option value="unsupported">Unsupported</option>
                            </select>
                          </label>
                        </div>
                      </details>
                    </div>
                    <div className="results-line">
                      <p role="status">
                        {visible.length} {playlist ? "entries" : "wallpapers"}
                        {filtered ? ` of ${entries.length}` : ""}
                      </p>
                      {filtered && (
                        <button className="text-button" onClick={resetFilters}>
                          Clear filters
                        </button>
                      )}
                    </div>
                    {selectedWallpaper && (
                      <aside
                        className="detail-panel"
                        ref={detail}
                        tabIndex={-1}
                        aria-label={`Details for ${selectedWallpaper.title}`}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            closeDetail();
                          }
                        }}
                      >
                        <div className="detail-top">
                          <span>Wallpaper details</span>
                          <button
                            className="quiet-button"
                            onClick={closeDetail}
                          >
                            Close details
                          </button>
                        </div>
                        <Preview
                          key={`${selectedWallpaper.id}-${refresh}`}
                          wallpaper={selectedWallpaper}
                          large
                        />
                        <div className="detail-copy">
                          <h2>{selectedWallpaper.title}</h2>
                          <p
                            className={`availability ${selectedWallpaper.availability}`}
                          >
                            {availabilityText(selectedWallpaper)}
                          </p>
                          <dl>
                            <div>
                              <dt>Type</dt>
                              <dd>{selectedWallpaper.type}</dd>
                            </div>
                            {selectedWallpaper.workshopId && (
                              <div>
                                <dt>Workshop ID</dt>
                                <dd>{selectedWallpaper.workshopId}</dd>
                              </div>
                            )}
                            <div>
                              <dt>In saved playlists</dt>
                              <dd>
                                {
                                  playlists.filter((item) =>
                                    item.items.some(
                                      (member) =>
                                        member.wallpaperId ===
                                        selectedWallpaper.id,
                                    ),
                                  ).length
                                }
                              </dd>
                            </div>
                          </dl>
                          {!!selectedWallpaper.tags.length && (
                            <div className="tags" aria-label="Tags">
                              {selectedWallpaper.tags.map((item, index) => (
                                <span key={`${item}-${index}`}>{item}</span>
                              ))}
                            </div>
                          )}
                          <details className="source-details">
                            <summary>Local source details</summary>
                            <dl>
                              <div>
                                <dt>Project</dt>
                                <dd>{selectedWallpaper.projectPath}</dd>
                              </div>
                              <div>
                                <dt>Catalog ID</dt>
                                <dd>{selectedWallpaper.id}</dd>
                              </div>
                              <div>
                                <dt>Steam subscription</dt>
                                <dd>Unknown · disk presence only</dd>
                              </div>
                            </dl>
                          </details>
                          <p className="muted">
                            Preview image only. Applying wallpapers stays in
                            Wallpaper Engine.
                          </p>
                        </div>
                      </aside>
                    )}
                    {visible.length ? (
                      <div className="wallpaper-grid">
                        {visible.map((entry) =>
                          entry.wallpaper ? (
                            <button
                              className={`wallpaper ${selected === entry.wallpaper.id ? "is-selected" : ""}`}
                              aria-label={`View ${entry.wallpaper.title}${entry.position ? `, entry ${entry.position}` : ""}`}
                              aria-pressed={selected === entry.wallpaper.id}
                              key={entry.key}
                              onClick={(event) => {
                                returnFocus.current = event.currentTarget;
                                if (selected === entry.wallpaper!.id)
                                  detail.current?.focus();
                                setSelected(entry.wallpaper!.id);
                              }}
                            >
                              <Preview
                                key={`${entry.key}-${refresh}`}
                                wallpaper={entry.wallpaper}
                              />
                              <span className="wallpaper-caption">
                                {entry.position && (
                                  <span className="position" aria-hidden="true">
                                    {entry.position}
                                  </span>
                                )}
                                <span>
                                  <strong>{entry.wallpaper.title}</strong>
                                  <span className="wallpaper-meta">
                                    {entry.wallpaper.type}
                                    {entry.wallpaper.availability !==
                                      "available" && (
                                      <span className="unavailable-label">
                                        {" "}
                                        ·{" "}
                                        {entry.wallpaper.availability ===
                                        "missing"
                                          ? "Missing files"
                                          : "Unsupported"}
                                      </span>
                                    )}
                                  </span>
                                </span>
                              </span>
                            </button>
                          ) : (
                            <div
                              className="unresolved wallpaper"
                              key={entry.key}
                            >
                              <div className="preview">
                                <span className="preview-unavailable">
                                  Unresolved entry
                                  <small>
                                    This saved item has no matching indexed
                                    wallpaper.
                                  </small>
                                </span>
                              </div>
                              <div className="wallpaper-caption">
                                <span className="position">
                                  {entry.position}
                                </span>
                                <span>
                                  <strong>Wallpaper not found</strong>
                                  <span className="wallpaper-meta">
                                    Kept in saved order
                                  </span>
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      <section className="empty-state compact">
                        <h2>
                          {filtered
                            ? "No matching wallpapers"
                            : "This playlist is empty"}
                        </h2>
                        <p>
                          {filtered
                            ? "Try a shorter title or clear the filters to see every entry."
                            : "The saved playlist has no entries in this index."}
                        </p>
                        {filtered && (
                          <button onClick={resetFilters}>Clear filters</button>
                        )}
                      </section>
                    )}
                  </>
                )}
                <details className="index-details">
                  <summary>
                    Index details
                    {library.status.diagnostics.length
                      ? ` · ${library.status.diagnostics.length} notices`
                      : ""}
                  </summary>
                  <p>
                    Snapshot revision {library.status.indexRevision}. Refresh
                    reads the saved index; run a new CLI scan to discover source
                    changes.
                  </p>
                  <pre>
                    <code>{scanCommand}</code>
                  </pre>
                  {library.status.diagnostics.length > 0 && (
                    <ul>
                      {library.status.diagnostics.map((notice, index) => (
                        <li key={index}>
                          <strong>{notice.code}</strong>
                          <p>{notice.message}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </>
            )
          )}
        </main>
      </div>
    </>
  );
}
function PlaylistButton({
  playlist,
  selected,
  onClick,
}: {
  playlist: Playlist;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-item ${selected ? "is-selected" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      <span className="playlist-name">{playlist.name}</span>
      <span>{playlist.items.length}</span>
    </button>
  );
}
function availabilityText(wallpaper: Wallpaper) {
  return wallpaper.availability === "available"
    ? "Files available at last scan"
    : wallpaper.availability === "missing"
      ? "Missing files · scan again after restoring them"
      : "Unsupported wallpaper type or unsafe project path";
}
