import type { Wallpaper, Playlist, Diagnostic } from "../../src/domain";
export type Status = {
  indexRevision: number;
  observedAt: string | null;
  diagnostics: Diagnostic[];
  data: { indexed: boolean; wallpapers: number; playlists: number };
  scanCommand: string;
};
export type Library = {
  status: Status;
  wallpapers: Wallpaper[];
  playlists: Playlist[];
};
export async function request<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error?.message ?? "The local gallery could not be reached.",
    );
  }
  return response.json();
}
export async function loadLibrary(signal: AbortSignal): Promise<Library> {
  const status = await request<Status>("/api/status", signal);
  if (!status.data.indexed) return { status, wallpapers: [], playlists: [] };
  async function all<T>(kind: string): Promise<T[]> {
    const result: T[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: { data: T[]; pagination: { nextOffset: number | null } } =
        await request(
          `/api/${kind}?limit=500&offset=${offset}&revision=${status.indexRevision}`,
          signal,
        );
      result.push(...page.data);
      offset = page.pagination.nextOffset;
    }
    return result;
  }
  const [wallpapers, playlists] = await Promise.all([
    all<Wallpaper>("wallpapers"),
    all<Playlist>("playlists"),
  ]);
  return { status, wallpapers, playlists };
}
export async function action<T>(url: string, input: unknown): Promise<T> {
  const session = await request<{ csrf: string }>('/api/session', new AbortController().signal);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Companion-CSRF': session.csrf }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${value.error?.message ?? 'Action failed.'}${value.error?.mayHaveApplied ? ' Playback may have changed. Read current state before retrying.' : ''}`);
  return value as T;
}
