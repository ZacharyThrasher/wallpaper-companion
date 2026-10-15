import { useEffect, useState } from 'react';
import type { Playlist } from '../../src/domain';
import type { WorkflowService } from '../../src/workflow/service';
import type { Preferences, PreferenceRecord } from '../../src/workflow/preferences';
import type { WorkshopCandidate, WorkshopDetail } from '../../src/workshop/types';
import { action, request } from './api';

type Context = ReturnType<WorkflowService['context']>;
type Discovery = Awaited<ReturnType<WorkflowService['discover']>>;
type Candidate = WorkshopCandidate & { match?: { explicitQueryTerms: string[]; referenceTags: string[]; explanation: string } };
const split = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Retry when the local server is available.';
export function Discover({ playlists, initialReference }: { playlists: Playlist[]; initialReference: string }) {
  const [reference, setReference] = useState(initialReference || 'global');
  return <>
    <div className="library-heading"><h1>Discover wallpapers</h1><p className="muted">Start with a saved playlist and describe what you want next.</p></div>
    <label className="reference-label">Reference playlist
      <select value={reference} onChange={e => setReference(e.target.value)}>
        <option value="global">No playlist reference</option>
        {playlists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    <DiscoveryProfile key={reference} reference={reference} />
  </>;
}
function DiscoveryProfile({ reference }: { reference: string }) {
  const [context, setContext] = useState<Context>();
  const [draft, setDraft] = useState<Preferences>();
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [results, setResults] = useState<Discovery>();
  const [inspected, setInspected] = useState<Candidate>();
  const [shortlist, setShortlist] = useState<WorkshopDetail[]>();
  const [item, setItem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<Context>(`/api/discovery-context?reference=${encodeURIComponent(reference)}`, controller.signal).then(value => {
      setContext(value); setDraft(value.preferences); setQuery(value.preferences.query || value.suggestions.query);
      setTags((value.revision ? value.preferences.tags : value.suggestions.tags).join(', ')); setExclusions(value.preferences.exclusions.join(', '));
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [reference, reload]);
  async function execute(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function save(next = draft!) {
    const preferences = { ...next, query, tags: split(tags), exclusions: split(exclusions) };
    const value = await action<PreferenceRecord>('/api/preferences', { reference, expectedRevision: context!.revision, preferences });
    setContext(current => current && ({ ...current, ...value })); setDraft(value.preferences);
    return value;
  }
  async function collect(id: string, kind: 'shortlist' | 'dismissed') {
    const included = draft![kind].includes(id);
    const next = { ...draft!, [kind]: included ? draft![kind].filter(value => value !== id) : [...draft![kind], id] };
    if (kind === 'shortlist' && !included) next.dismissed = next.dismissed.filter(value => value !== id);
    await save(next); setShortlist(undefined);
    if (kind === 'dismissed') { setResults(current => current && ({ ...current, candidates: current.candidates.filter(c => c.id !== id) })); setInspected(undefined); }
    setNotice(kind === 'shortlist' ? included ? 'Removed from companion shortlist.' : 'Saved to companion shortlist.' : 'Dismissed for this reference.');
  }
  if (!context || !draft) return <section aria-busy={!error}>
    {error ? <div role="alert" className="error-state"><p>{error}</p><button onClick={() => { setError(''); setReload(n => n + 1); }}>Reload preferences</button></div> : <p role="status">Loading discovery preferences…</p>}
  </section>;
  const candidates = [...(inspected ? [inspected] : []), ...(results?.candidates ?? []).filter(c => c.id !== inspected?.id)];
  return <div className="discovery">
    <form className="discovery-form" onSubmit={e => { e.preventDefault(); void execute(async () => {
      await save(); const value = await action<Discovery>('/api/discover', { reference, query, tags: split(tags) });
      setResults(value); setInspected(undefined); setNotice(value.status === 'ok' ? `${value.candidates.length} new candidates returned.` : 'API search needs Steam credentials. Open the search in Steam or inspect a pasted item below.');
    }); }}>
      <label>What are you looking for?
        <textarea maxLength={2000} rows={3} value={draft.guidance} onChange={e => setDraft({ ...draft, guidance: e.target.value })} placeholder="For example: quieter scenes for evening, with very little movement" />
      </label>
      <p className="field-note">Saved guidance is shared with your AI chat. This app uses the query and tags below; it does not interpret your prose or analyze images.</p>
      <details className="evidence"><summary>What informed these suggestions?</summary>
        <p>{reference === 'global' ? 'No reference playlist selected.' : `${context.evidence.resolvedMembers} indexed playlist wallpapers; ${context.evidence.unresolvedMembers} unresolved entries.`} Suggestions count words in titles and existing tags.</p>
        <p>Frequent tags: {context.evidence.tags.map(t => `${t.value} (${t.count})`).join(', ') || 'none'}. Title words: {context.evidence.titleWords.map(t => t.value).join(', ') || 'none'}.</p>
        <button type="button" className="text-button" onClick={() => { setQuery(context.suggestions.query); setTags(context.suggestions.tags.join(', ')); }}>Use reference suggestions</button>
      </details>
      <div className="discovery-fields">
        <label>Search query<input maxLength={512} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <label>Required tags <span className="muted">(comma separated)</span><input maxLength={2579} value={tags} onChange={e => setTags(e.target.value)} /></label>
        <label>Exclude words or tags <span className="muted">(comma separated)</span><input maxLength={2579} value={exclusions} onChange={e => setExclusions(e.target.value)} /></label>
      </div>
      <div className="action-row"><button disabled={busy} type="submit">{busy ? 'Working…' : 'Find wallpapers'}</button>
        <button disabled={busy} type="button" onClick={() => void execute(async () => { await save(); setNotice('Preferences saved for this reference.'); })}>Save guidance</button>
      </div>
    </form>
    {error && <div role="alert" className="error-state"><p>{error}</p><button disabled={busy} onClick={() => { setError(''); setResults(undefined); setInspected(undefined); setShortlist(undefined); setReload(n => n + 1); }}>Reload preferences</button><p className="field-note">Reload discards unsaved edits. If another session changed preferences, review the latest values before saving again.</p></div>}
    {notice && <p role="status" className="workflow-notice">{notice}</p>}
    {results && <section className="discovery-results">
      <h2>{results.status === 'credentials_required' ? 'Continue your search in Steam' : 'Workshop candidates'}</h2>
      <p className="muted">{results.status === 'credentials_required' ? 'API search requires STEAM_WEB_API_KEY in the server environment. No key is stored here. Anonymous item inspection works below.' : 'Installed and dismissed items are excluded. Matches use title words and tags only.'}</p>
      <a className="steam-link" href={results.searchUrl} target="_blank" rel="noreferrer">Open Steam search</a>
      {results.status === 'ok' && !results.candidates.length && <p>No new matches on this page. Edit the query or continue in Steam.</p>}
      {results.status === 'ok' && results.nextCursor && <button disabled={busy} onClick={() => void execute(async () => {
        const value = await action<Discovery>('/api/discover', { reference, query, tags: split(tags), cursor: results.nextCursor }); setResults(value);
      })}>Next page</button>}
    </section>}
    <section className="inspect-workshop"><h2>Inspect a Workshop item</h2><p className="muted">Paste a public Steam Workshop item URL or positive ID. Metadata is available without a key.</p>
      <form className="inspect-form" onSubmit={e => { e.preventDefault(); void execute(async () => {
        const value = await action<Awaited<ReturnType<WorkflowService['inspect']>>>('/api/inspect', { reference, item: item.trim() });
        if (value.status === 'available') { setInspected(value.candidate); setNotice(`${value.installed ? 'Already present in the local index. ' : ''}${value.dismissed ? 'Previously dismissed. ' : ''}Steam metadata loaded; subscription and download state are unknown.`); }
        else { setInspected(undefined); setNotice(`This item is unavailable (${value.reason}). Check its visibility and app in Steam.`); }
      }); }}><label>Workshop URL or ID<input required maxLength={256} value={item} onChange={e => setItem(e.target.value)} placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…" /></label><button disabled={busy}>Inspect item</button></form>
    </section>
    {!!candidates.length && <div className="wallpaper-grid discovery-grid">{candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} saved={draft.shortlist.includes(candidate.id)} busy={busy}
      onShortlist={() => void execute(() => collect(candidate.id, 'shortlist'))} onDismiss={() => void execute(() => collect(candidate.id, 'dismissed'))} />)}</div>}
    <section className="shortlist-section"><h2>Companion shortlist <span className="muted">({draft.shortlist.length})</span></h2>
      <p className="muted">A collection for this reference. Subscribe or add to a Wallpaper Engine playlist in Steam / Wallpaper Engine, then Refresh library after download.</p>
      <button disabled={busy} onClick={() => void execute(async () => { const value = await request<{ details: WorkshopDetail[] }>('/api/shortlist?reference=' + encodeURIComponent(reference), new AbortController().signal); setShortlist(value.details); })}>Show shortlist</button>
      {shortlist && !shortlist.length && <p>No shortlisted items yet. Inspect an item or search Steam to start.</p>}
      {shortlist && <div className="wallpaper-grid discovery-grid">{shortlist.map(detail => detail.status === 'available' ? <CandidateCard key={detail.id} candidate={detail.candidate} saved busy={busy} onShortlist={() => void execute(() => collect(detail.id, 'shortlist'))} /> : <article key={detail.id}><p>Item {detail.id}: {detail.reason}</p><a href={detail.steamUrl} target="_blank" rel="noreferrer">Open in Steam</a><button disabled={busy} onClick={() => void execute(() => collect(detail.id, 'shortlist'))}>Remove from shortlist</button></article>)}</div>}
      {!!draft.dismissed.length && <details className="dismissed"><summary>{draft.dismissed.length} dismissed items</summary><p>{draft.dismissed.join(', ')}</p><button disabled={busy} onClick={() => void execute(async () => { await save({ ...draft, dismissed: [] }); setNotice('Dismissed items cleared for this reference.'); })}>Clear dismissed items</button></details>}
    </section>
  </div>;
}
function CandidateCard({ candidate, saved, busy, onShortlist, onDismiss }: { candidate: Candidate; saved: boolean; busy: boolean; onShortlist: () => void; onDismiss?: () => void }) {
  const [failed, setFailed] = useState(false);
  return <article className="candidate"><div className="preview">{candidate.previewUrl && !failed ? <img src={candidate.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="preview-unavailable">Preview unavailable</span>}</div>
    <h3>{candidate.title}</h3>
    {candidate.match && <p className="match-reason">{candidate.match.explicitQueryTerms.length ? `Query overlap: ${candidate.match.explicitQueryTerms.join(', ')}. ` : ''}{candidate.match.referenceTags.length ? `Reference tags: ${candidate.match.referenceTags.join(', ')}. ` : ''}{candidate.match.explanation}</p>}
    <div className="action-row"><a href={candidate.steamUrl} target="_blank" rel="noreferrer">Open in Steam</a><button className="quiet-button" disabled={busy} onClick={onShortlist}>{saved ? 'Remove from shortlist' : 'Shortlist'}</button>{onDismiss && <button className="quiet-button" disabled={busy} onClick={onDismiss}>Dismiss</button>}</div>
  </article>;
}
