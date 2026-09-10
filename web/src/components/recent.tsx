import { useEffect, useState } from 'react';
import { listAnalyses, profileLabel, type AnalysisSummary } from '../api';

function when(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** What a visitor with no replay id of their own has to look at. */
export function RecentAnalyses({ navigate }: { navigate: (route: string) => void }) {
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(from?: string) {
    setLoading(true);
    try {
      const page = await listAnalyses(from === undefined ? { limit: 20 } : { limit: 20, cursor: from });
      setAnalyses((previous) => [...previous, ...page.analyses]);
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      setError('Could not load recent analyses.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="card">
      <h2>Recent analyses</h2>
      {error !== null && <p className="error">{error}</p>}
      {analyses.length === 0 && !loading && error === null && (
        <p className="muted">Nothing analyzed yet. Submit a replay above.</p>
      )}
      {analyses.map((a) => (
        <div className="list-item" key={a.analysisId}>
          <div>
            <a className="who" href={`#/a/${a.analysisId}`} onClick={() => navigate(`/a/${a.analysisId}`)}>
              {a.players.length === 2 ? `${a.players[0]} vs ${a.players[1]}` : a.replayId}
            </a>
            <div className="muted">
              {a.format}
              {a.rating !== null && ` · ${a.rating}`} · {a.totalTurns} turns, {a.gradableTurns} gradable · seen from{' '}
              {a.perspective}
            </div>
          </div>
          <div className="muted" style={{ textAlign: 'right' }}>
            {profileLabel(a.searchBudgetMsPerTurn, a.opponentSamples)}
            <br />
            {when(a.createdAt)}
          </div>
        </div>
      ))}
      {cursor !== null && (
        <button className="secondary" style={{ marginTop: 14 }} disabled={loading} onClick={() => void load(cursor)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
