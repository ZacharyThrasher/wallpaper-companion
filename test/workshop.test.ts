import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { SteamWorkshopProvider, WorkshopError, workshopItemUrl, workshopSearchUrl, type WorkshopClock } from '../src/workshop/index.js';

const key = '0123456789abcdef0123456789abcdef'; // Synthetic fixture, never a credential.
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  publishedfileid: id, result: 1, consumer_app_id: 431960, creator_app_id: 431960,
  visibility: 0, banned: 0, title: '[b]Rain[/b] &amp; Neon',
  description: '<p>Night</p> [url=https://example.com]city[/url]<script>bad()</script>',
  tags: [{ tag: 'Scene' }, { tag: 'Cyberpunk' }],
  preview_url: 'https://steamuserimages-a.akamaihd.net/ugc/123/preview.jpg',
  time_created: 1700000000, time_updated: 1700000123, file_size: '9007199254740993',
  subscriptions: 17, favorited: 3, lifetime_subscriptions: 23,
  creator: 'unneeded-creator-data', file_url: 'https://example.com/not-downloaded', ...overrides,
});
function queryItem(id: string, overrides: Record<string, unknown> = {}) {
  const { consumer_app_id, creator_app_id, ...rest } = item(id);
  return { ...rest, consumer_appid: consumer_app_id, creator_appid: creator_app_id, banned: false, ...overrides };
}
function response(rows: unknown[], extra: Record<string, unknown> = {}): Response {
  return Response.json({ response: { result: 1, publishedfiledetails: rows, ...extra } });
}
class Clock implements WorkshopClock {
  time = 1_700_000_000_000;
  sleeps: number[] = [];
  now = () => this.time;
  sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('should not sleep when aborted');
    this.sleeps.push(ms); this.time += ms;
  };
}
type FetchCall = { url: URL; init: RequestInit | undefined };
function fake(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: new URL(String(url)), init };
    calls.push(call); return handler(call, calls.length - 1);
  };
  return { calls, fetcher };
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof WorkshopError); assert.equal(error.code, expected);
  assert.equal(inspect(error).includes(key), false); assert.equal(JSON.stringify(error).includes(key), false);
  return true;
};

test('missing credentials honestly returns Steam search handoff without network or local candidates', async () => {
  const net = fake(() => { throw new Error('unexpected network'); });
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher });
  assert.deepEqual(provider.capabilities(), { provider: 'steam-workshop', appId: 431960,
    search: 'credentials_required', details: 'anonymous', subscribe: false, download: false });
  const result = await provider.search({ text: 'rain & neon', requiredTags: ['Scene'], excludedTags: ['Mature'] });
  assert.equal(result.status, 'credentials_required'); assert.deepEqual(result.candidates, []);
  const link = new URL(result.searchUrl);
  assert.equal(link.origin, 'https://steamcommunity.com');
  assert.equal(link.searchParams.get('appid'), '431960');
  assert.equal(link.searchParams.get('searchtext'), 'rain & neon');
  assert.deepEqual(link.searchParams.getAll('requiredtags[]'), ['Scene']);
  assert.deepEqual(link.searchParams.getAll('excludedtags[]'), ['Mature']);
  assert.equal(net.calls.length, 0);
});

test('official QueryFiles JSON serialization, text ranking, cursor and minimum projections', async () => {
  const net = fake(() => response([queryItem('9007199254740993'), queryItem('11', { consumer_appid: 7 })],
    { next_cursor: 'next +/=&?', total: 42 }));
  const provider = new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher, clock: new Clock() });
  const query = { text: 'rain & neon', requiredTags: ['Scene', '2D'], excludedTags: ['Mature'], matchAllTags: false, limit: 2 };
  const result = await provider.search(query);
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
  assert.equal(result.candidates.length, 1); assert.equal(result.nextCursor, 'next +/=&?'); assert.equal(result.total, 42);
  const { url, init } = net.calls[0]!;
  assert.equal(url.origin, 'https://api.steampowered.com');
  assert.equal(url.pathname, '/IPublishedFileService/QueryFiles/v1/');
  assert.equal(url.searchParams.get('key'), key); assert.equal(init?.method, 'GET'); assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(url.searchParams.get('input_json')!), {
    appid: 431960, filetype: 0, query_type: 12, search_text: 'rain & neon', cursor: '*', numperpage: 2,
    requiredtags: ['2D', 'Scene'], excludedtags: ['Mature'], match_all_tags: false,
    return_tags: true, return_previews: true, return_short_description: true,
  });
  await provider.search({ ...query, cursor: result.nextCursor });
  assert.equal(JSON.parse(net.calls[1]!.url.searchParams.get('input_json')!).cursor, 'next +/=&?');
  assert.equal(JSON.stringify(provider).includes(key), false); assert.equal(inspect(provider, { showHidden: true }).includes(key), false);
});

test('metadata POST preserves uint64 IDs, deduplicates requests and minimizes returned data', async () => {
  const net = fake(() => response([item('9007199254740993'), item('21')]));
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher });
  const rows = await provider.details(['21', '9007199254740993', '21']);
  const { url, init } = net.calls[0]!;
  assert.equal(url.pathname, '/ISteamRemoteStorage/GetPublishedFileDetails/v1/'); assert.equal(url.search, '');
  assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error');
  const body = new URLSearchParams(String(init.body));
  assert.equal(body.get('itemcount'), '2'); assert.equal(body.get('publishedfileids[0]'), '21');
  assert.equal(body.get('publishedfileids[1]'), '9007199254740993');
  assert.deepEqual(rows.map(row => row.id), ['21', '9007199254740993', '21']);
  assert.equal(rows[0]?.status, 'available'); if (rows[0]?.status !== 'available') return;
  const candidate = rows[0].candidate;
  assert.equal(candidate.title, 'Rain & Neon'); assert.equal(candidate.summary, 'Night city');
  assert.equal(candidate.fileSizeBytes, '9007199254740993'); assert.deepEqual(candidate.tags, ['Scene', 'Cyberpunk']);
  assert.deepEqual(candidate.popularity, { subscriptions: 17, favorites: 3, lifetimeSubscriptions: 23 });
  assert.equal(candidate.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(candidate.steamUrl, 'https://steamcommunity.com/sharedfiles/filedetails/?id=21');
  assert.equal(JSON.stringify(rows).includes('unneeded-creator-data'), false);
  assert.equal(JSON.stringify(rows).includes('not-downloaded'), false);
  candidate.tags.push('mutated');
  assert.equal(rows[2]?.status === 'available' && rows[2].candidate.tags.includes('mutated'), false);
  const cached = await provider.details(['21']);
  assert.equal(cached[0]?.status === 'available' && cached[0].candidate.tags.includes('mutated'), false);
  assert.equal(net.calls.length, 1);
});

test('explicit zero-total search can omit an empty repeated field and newest search has no text ranking', async () => {
  const net = fake(() => Response.json({ response: { total: 0 } }));
  const provider = new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher });
  const result = await provider.search();
  assert.deepEqual(result, { status: 'ok', candidates: [], total: 0, searchUrl: workshopSearchUrl() });
  assert.equal(JSON.parse(net.calls[0]!.url.searchParams.get('input_json')!).query_type, 1);
});

test('partial batches have explicit unavailable reasons and cannot substitute unrelated IDs', async () => {
  const net = fake(() => response([
    item('1', { consumer_app_id: 7 }), item('2', { visibility: 2 }), item('3', { banned: true }),
    { publishedfileid: '4', result: 9 }, item('5', { title: null }), item('99'),
  ]));
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher });
  const rows = await provider.details(['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(rows.map(row => row.status === 'unavailable' ? row.reason : 'available'),
    ['wrong_app', 'private', 'banned', 'missing', 'malformed', 'missing']);
});

test('duplicate upstream IDs, missing public visibility and malformed records fail closed', async () => {
  const net = fake(() => response([item('1'), item('1'), item('3', { visibility: undefined }), item('4', { consumer_appid: 7 })]));
  const rows = await new SteamWorkshopProvider({ fetch: net.fetcher }).details(['1', '2', '3', '4']);
  assert.deepEqual(rows.map(row => row.status === 'unavailable' && row.reason), ['malformed', 'missing', 'malformed', 'malformed']);
});

test('previews use exact HTTPS CDN allowlist and are never fetched', async () => {
  const urls = ['http://steamuserimages-a.akamaihd.net/x', 'https://steamuserimages-a.akamaihd.net.evil.test/x',
    'https://127.0.0.1/x', 'https://user:pass@images.steamusercontent.com/x',
    'https://images.steamusercontent.com:444/x', 'javascript:alert(1)', 'https://images.steamusercontent.com/x'];
  const net = fake(() => response(urls.map((url, i) => item(String(i + 1), { preview_url: url }))));
  const rows = await new SteamWorkshopProvider({ fetch: net.fetcher }).details(urls.map((_, i) => String(i + 1)));
  assert.deepEqual(rows.map(row => row.status === 'available' ? row.candidate.previewUrl : null),
    [undefined, undefined, undefined, undefined, undefined, undefined, urls[6]]);
  assert.equal(net.calls.length, 1);
});

test('inputs are bounded before network including IDs, opaque cursors, limits and tag arrays', async () => {
  const net = fake(() => response([])); const provider = new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher });
  for (const ids of [[], ['0'], ['01'], ['-1'], ['1e3'], ['18446744073709551616'], Array(51).fill('1'), [1] as unknown as string[]]) {
    await assert.rejects(provider.details(ids), code('invalid_input'));
  }
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: NaN }, { cursor: '' }, { cursor: 'x'.repeat(2049) },
    { cursor: 'x\n' }, { text: 'x'.repeat(513) }, { requiredTags: Array(21).fill('a') }, { excludedTags: [''] }, { text: key }]) {
    await assert.rejects(provider.search(query), code('invalid_input'));
  }
  assert.throws(() => workshopItemUrl('1?x=y'), code('invalid_input'));
  assert.throws(() => new SteamWorkshopProvider({ apiKey: 'invalid' }), code('invalid_input'));
  assert.equal(net.calls.length, 0);
  assert.equal(new URL(workshopSearchUrl()).searchParams.get('browsesort'), 'mostrecent');
});

test('cached search applies current installed/dismissed sets without filling from local results', async () => {
  const net = fake(() => response([queryItem('1'), queryItem('2')], { next_cursor: 'opaque', total: 20 }));
  const provider = new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher });
  const first = await provider.search({ limit: 2, installedIds: new Set(['1']) });
  assert.deepEqual(first.candidates.map(candidate => candidate.id), ['2']);
  first.candidates[0]!.tags.push('mutated');
  const second = await provider.search({ limit: 2, dismissedIds: new Set(['2']) });
  assert.deepEqual(second.candidates.map(candidate => candidate.id), ['1']);
  assert.equal(second.status === 'ok' && second.nextCursor, 'opaque');
  const third = await provider.search({ limit: 2 });
  assert.deepEqual(third.candidates.map(candidate => candidate.id), ['1', '2']);
  assert.equal(third.candidates[1]!.tags.includes('mutated'), false); assert.equal(net.calls.length, 1);
});

test('TTL expiry, negative TTL, finite eviction and disabling cache', async () => {
  const clock = new Clock(); const net = fake(call => call.url.pathname.includes('QueryFiles') ? response([]) : response([item('1')]));
  const provider = new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher, clock, cacheMaxEntries: 2 });
  await provider.search(); await provider.details(['1']);
  clock.time += 900_000;
  await provider.search(); await provider.details(['1']); assert.equal(net.calls.length, 3);
  await provider.search({ text: 'other' }); // Evicts the older search entry, preserving the touched detail.
  await provider.search(); assert.equal(net.calls.length, 5);
  clock.time += 86_400_000;
  await provider.details(['1']); assert.equal(net.calls.length, 6);
  provider.clearCache(); await provider.details(['1']); assert.equal(net.calls.length, 7);
  const missingNet = fake(() => response([]));
  const missing = new SteamWorkshopProvider({ fetch: missingNet.fetcher, clock });
  await missing.details(['2']); await missing.details(['2']); assert.equal(missingNet.calls.length, 1);
  clock.time += 60_000; await missing.details(['2']); assert.equal(missingNet.calls.length, 2);
  const uncached = new SteamWorkshopProvider({ fetch: net.fetcher, clock, cacheMaxEntries: 0 });
  await uncached.details(['1']); await uncached.details(['1']); assert.equal(net.calls.length, 9);
});

test('429 and 503 honor seconds/date Retry-After with bounded retry; 403 is never retried', async () => {
  const clock = new Clock(); const starts: number[] = [];
  const net = fake((_, index) => {
    starts.push(clock.now());
    if (index === 0) return new Response('ignored', { status: 429, headers: { 'Retry-After': '2' } });
    if (index === 1) return new Response('ignored', { status: 503, headers: { 'Retry-After': new Date(clock.now() + 3000).toUTCString() } });
    return response([item('1')]);
  });
  await new SteamWorkshopProvider({ fetch: net.fetcher, clock }).details(['1']);
  assert.deepEqual(clock.sleeps, [2000, 3000]); assert.equal(starts.length, 3);
  const auth = fake(() => new Response(key, { status: 403 }));
  await assert.rejects(new SteamWorkshopProvider({ apiKey: key, fetch: auth.fetcher }).search(), code('credentials_rejected'));
  assert.equal(auth.calls.length, 1);
  const exhausted = fake(() => new Response('busy', { status: 503 }));
  const backoff = new Clock();
  await assert.rejects(new SteamWorkshopProvider({ fetch: exhausted.fetcher, clock: backoff }).details(['1']), code('service_unavailable'));
  assert.equal(exhausted.calls.length, 3); assert.deepEqual(backoff.sleeps, [1000, 2000]);
});

test('long Retry-After returns promptly and prevents subsequent requests during cooldown', async () => {
  const clock = new Clock(); const net = fake(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher, clock });
  await assert.rejects(provider.details(['1']), code('rate_limited'));
  await assert.rejects(provider.details(['2']), code('rate_limited'));
  assert.equal(net.calls.length, 1); assert.deepEqual(clock.sleeps, []);
});

test('untrusted exceptions and response bodies never appear in errors or returned metadata', async () => {
  const broken = fake(() => { throw new Error(`request URL?key=${key}`); });
  await assert.rejects(new SteamWorkshopProvider({ apiKey: key, fetch: broken.fetcher }).search(), code('network'));
  const echoes = fake(() => response([item('1', { title: key, description: `&#48;${key.slice(1)}`, tags: [{ tag: key }], preview_url: `https://images.steamusercontent.com/${key}` })]));
  const result = await new SteamWorkshopProvider({ apiKey: key, fetch: echoes.fetcher }).search();
  assert.equal(JSON.stringify(result).includes(key), false);
  const badCursor = fake(() => response([], { next_cursor: key }));
  await assert.rejects(new SteamWorkshopProvider({ apiKey: key, fetch: badCursor.fetcher }).search(), code('invalid_response'));
});

test('invalid JSON, malformed envelopes, oversized bodies and cursor failures are sanitized', async () => {
  for (const make of [() => new Response(`not JSON ${key}`), () => Response.json({ response: {} }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), () => response([], { next_cursor: 'x'.repeat(2049) }),
    () => response([], { result: 9 })]) {
    const net = fake(make);
    await assert.rejects(new SteamWorkshopProvider({ apiKey: key, fetch: net.fetcher }).search(), code('invalid_response'));
    assert.equal(net.calls.length, 1);
  }
});

test('pre-cancelled and active requests cancel promptly even when injected fetch ignores abort', async () => {
  const net = fake(() => new Promise<Response>(() => {}));
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher });
  const before = new AbortController(); before.abort(new Error(key));
  await assert.rejects(provider.details(['1'], before.signal), code('cancelled')); assert.equal(net.calls.length, 0);
  const active = new AbortController();
  const pending = provider.details(['1'], active.signal);
  await new Promise(resolve => setImmediate(resolve)); active.abort(new Error(key));
  await assert.rejects(pending, code('cancelled')); assert.equal(net.calls.length, 1);
});

test('timeouts include response body reads; network failures are not retried', async () => {
  const net = fake(() => new Promise<Response>(() => {}));
  await assert.rejects(new SteamWorkshopProvider({ fetch: net.fetcher, timeoutMs: 10 }).details(['1']), code('timeout'));
  assert.equal(net.calls.length, 1);
  const stalled = fake(() => new Response(new ReadableStream({ start() {} })));
  await assert.rejects(new SteamWorkshopProvider({ fetch: stalled.fetcher, timeoutMs: 10 }).details(['1']), code('timeout'));
  const cancelStalled = fake(() => new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 503 }));
  await assert.rejects(new SteamWorkshopProvider({ fetch: cancelStalled.fetcher, timeoutMs: 10 }).details(['1']), code('timeout'));
});

test('cancellation interrupts retry backoff and does not start another attempt', async () => {
  const abort = new AbortController(); const clock = new Clock();
  let sleeping!: () => void;
  const hasSlept = new Promise<void>(resolve => { sleeping = resolve; });
  clock.sleep = async (ms, signal) => {
    clock.sleeps.push(ms); sleeping();
    await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new WorkshopError('cancelled')), { once: true }));
  };
  const net = fake(() => new Response('', { status: 429, headers: { 'Retry-After': '5' } }));
  const pending = new SteamWorkshopProvider({ fetch: net.fetcher, clock }).details(['1'], abort.signal);
  await hasSlept; abort.abort(); await assert.rejects(pending, code('cancelled'));
  assert.equal(net.calls.length, 1); assert.deepEqual(clock.sleeps, [5000]);
});

test('serial queue rate limits, and cancelling a queued caller cannot overtake the active one', async () => {
  const clock = new Clock(); let finish!: (value: Response) => void;
  const starts: number[] = [];
  const net = fake((_, index) => {
    starts.push(clock.now());
    return index === 0 ? new Promise<Response>(resolve => { finish = resolve; }) : response([item(String(index + 2))]);
  });
  const provider = new SteamWorkshopProvider({ fetch: net.fetcher, clock });
  const first = provider.details(['1']);
  await new Promise(resolve => setImmediate(resolve));
  const abort = new AbortController(); const second = provider.details(['2'], abort.signal);
  const third = provider.details(['3']); abort.abort();
  await assert.rejects(second, code('cancelled'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(net.calls.length, 1);
  finish(response([item('1')])); await Promise.all([first, third]);
  assert.equal(net.calls.length, 2); assert.equal(starts[1]! - starts[0]!, 1000);
});
