import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Discover } from './Discover';
import { Playback } from './Playback';
import { action, request } from './api';
import type { WorkflowService } from '../../src/workflow/service';
import type { Playlist } from '../../src/domain';
vi.mock('./api', () => ({ action: vi.fn(), request: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const playlist = { id: 'pl_test', name: 'Quiet evenings' } as Playlist;
function context(reference = 'global', revision = 0): ReturnType<WorkflowService['context']> {
  return { schemaVersion: 1, reference, revision, preferences: { guidance: '', query: '', tags: [], exclusions: [], shortlist: [], dismissed: [] },
    referenceName: 'Synthetic reference', capabilities: { provider: 'steam-workshop', appId: 431960, search: 'credentials_required', details: 'anonymous', subscribe: false, download: false },
    evidence: { method: 'title-tag-heuristic', analyzedImages: false, resolvedMembers: 1, unresolvedMembers: 1, tags: [{ value: 'nature', count: 1 }], titleWords: [{ value: 'forest', count: 1 }] }, suggestions: { query: 'forest', tags: ['nature'] } };
}
const candidate = { id: '22', title: 'Synthetic quiet forest', tags: ['Nature'], summary: '', appId: 431960, source: 'steam-workshop', steamUrl: 'https://steamcommunity.com/sharedfiles/filedetails/?id=22' };
test('select reference, edit guidance, get honest no-key handoff, inspect and shortlist with keyboard', async () => {
  const user = userEvent.setup(); let current = context();
  vi.mocked(request).mockImplementation(async url => url.startsWith('/api/shortlist') ? { details: [{ status: 'available', id: '22', candidate }], pagination: { offset: 0, total: 1, nextOffset: null } } : (current = context(new URL('http://local' + url).searchParams.get('reference')!)) as never);
  vi.mocked(action).mockImplementation(async (url, input) => {
    if (url === '/api/preferences') { const args = input as any; expect(args.expectedRevision).toBe(current.revision); current = { ...current, ...args, revision: current.revision + 1 }; return current as never; }
    if (url === '/api/discover') return { status: 'credentials_required', candidates: [], searchUrl: 'https://steamcommunity.com/workshop/browse/?appid=431960&searchtext=forest' } as never;
    return { status: 'available', candidate, installed: false, dismissed: false } as never;
  });
  render(<Discover playlists={[playlist]} initialReference="" />);
  await screen.findByRole('textbox', { name: 'What are you looking for?' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Reference playlist' }), 'pl_test');
  await waitFor(() => expect(vi.mocked(request)).toHaveBeenLastCalledWith('/api/discovery-context?reference=pl_test', expect.any(AbortSignal)));
  await user.type(await screen.findByRole('textbox', { name: 'What are you looking for?' }), 'less movement, quiet evenings');
  await user.click(screen.getByRole('button', { name: 'Find wallpapers' }));
  expect(await screen.findByRole('link', { name: 'Open Steam search' })).toHaveAttribute('href', expect.stringContaining('steamcommunity.com'));
  expect(current.preferences.guidance).toBe('less movement, quiet evenings');
  expect(screen.getByText(/Anonymous item inspection works below/)).toBeInTheDocument();
  const input = screen.getByRole('textbox', { name: 'Workshop URL or ID' }); await user.type(input, '22'); await user.keyboard('{Enter}');
  expect(await screen.findByRole('heading', { name: 'Synthetic quiet forest' })).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Shortlist' }); button.focus(); await user.keyboard('{Enter}');
  expect(await screen.findByText('Saved to companion shortlist.')).toBeInTheDocument(); expect(current.preferences.shortlist).toEqual(['22']);
  await user.click(screen.getByRole('button', { name: 'Show shortlist' }));
  expect(await screen.findByText(/A collection for this reference/)).toBeInTheDocument();
});
test('saved empty query is preserved and failed preference save explains recovery without overwriting', async () => {
  const user = userEvent.setup(); vi.mocked(request).mockResolvedValue(context('pl_test', 2));
  vi.mocked(action).mockRejectedValue(new Error('Preferences changed in another window. Reload preferences before saving again.'));
  render(<Discover playlists={[playlist]} initialReference="pl_test" />);
  expect(await screen.findByRole('textbox', { name: 'Search query' })).toHaveValue('');
  await user.type(screen.getByRole('textbox', { name: 'What are you looking for?' }), 'new guidance');
  await user.click(screen.getByRole('button', { name: 'Save guidance' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Preferences changed');
  expect(screen.getByRole('textbox', { name: 'What are you looking for?' })).toHaveValue('new guidance');
  await user.click(screen.getByRole('button', { name: 'Reload preferences' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'What are you looking for?' })).toHaveValue(''));
});
test('editing query invalidates next-page action until a new search is submitted', async () => {
  const user = userEvent.setup(); vi.mocked(request).mockResolvedValue(context());
  vi.mocked(action).mockImplementation(async (url, input) => url === '/api/preferences' ? { ...(input as object), revision: 1 } as never : { status: 'ok', candidates: [], nextCursor: 'cursor', searchUrl: 'https://steamcommunity.com/workshop/browse/?appid=431960' } as never);
  render(<Discover playlists={[]} initialReference="" />);
  await screen.findByRole('textbox', { name: 'Search query' }); await user.click(screen.getByRole('button', { name: 'Find wallpapers' }));
  const next = await screen.findByRole('button', { name: 'Next page' }); expect(next).not.toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'Search query' }), ' sunset'); expect(next).toBeDisabled();
});
test('slow preference mutation protects newer edits and shortlist provides next-page access', async () => {
  const user = userEvent.setup(); let release!: (value: unknown) => void;
  const current = context('global', 1); current.preferences.shortlist = Array.from({ length: 51 }, (_, i) => String(100 + i));
  vi.mocked(request).mockImplementation(async url => {
    if (url.includes('offset=50')) return { details: [{ id: '150', status: 'available', candidate: { ...candidate, id: '150', title: 'Last saved item' } }], pagination: { offset: 50, total: 51, nextOffset: null } } as never;
    if (url.startsWith('/api/shortlist')) return { details: [{ id: '100', status: 'available', candidate }], pagination: { offset: 0, total: 51, nextOffset: 50 } } as never;
    return current as never;
  });
  vi.mocked(action).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  render(<Discover playlists={[]} initialReference="" />);
  const guidance = await screen.findByRole('textbox', { name: 'What are you looking for?' });
  await user.type(guidance, 'saved text'); await user.click(screen.getByRole('button', { name: 'Save guidance' }));
  expect(guidance).toBeDisabled(); await user.type(guidance, 'cannot overwrite'); expect(guidance).toHaveValue('saved text');
  release({ ...current, revision: 2, preferences: { ...current.preferences, guidance: 'saved text' } });
  await waitFor(() => expect(guidance).not.toBeDisabled());
  await user.click(screen.getByRole('button', { name: 'Show shortlist' }));
  await user.click(await screen.findByRole('button', { name: 'Next shortlist page' }));
  expect(await screen.findByRole('heading', { name: 'Last saved item' })).toBeInTheDocument();
  expect(screen.getByText('Showing 51–51 of 51 saved items.')).toBeInTheDocument();
});
test('playback UI distinguishes verification, accepted playlist and engine failure', async () => {
  const user = userEvent.setup(); vi.mocked(action).mockResolvedValueOnce({ accepted: true, verification: 'target-observed' });
  const view = render(<Playback id="wp_test" />);
  await user.click(screen.getByRole('button', { name: 'Apply wallpaper' }));
  expect(await screen.findByRole('status')).toHaveTextContent('verified on monitor 0'); expect(action).toHaveBeenCalledWith('/api/apply', { wallpaperId: 'wp_test', monitor: 0 });
  view.unmount(); vi.mocked(action).mockResolvedValueOnce({ accepted: true, verification: 'not-supported' });
  const second = render(<Playback id="pl_test" playlist />); await user.click(screen.getByRole('button', { name: 'Play playlist' }));
  expect(await screen.findByRole('status')).toHaveTextContent('cannot be verified'); second.unmount();
  vi.mocked(action).mockRejectedValueOnce(new Error('Start Wallpaper Engine, then retry.')); render(<Playback id="wp_test" />);
  await user.click(screen.getByRole('button', { name: 'Apply wallpaper' })); expect(await screen.findByRole('alert')).toHaveTextContent('Start Wallpaper Engine');
});
