import { useEffect, useState } from 'react';
import { getAnalysis, profileLabel, type AnalysisEnvelope, type TurnEvaluation } from '../api';
import { CostBars, EvalCurve } from './charts';

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** The ranked actions the engine considered on one turn, and what was actually played. */
function TurnDetail({ turn }: { turn: TurnEvaluation }) {
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <h2>Turn {turn.turn}</h2>
      <ul className="pills">
        <li>win probability {percent(turn.winProbability)}</li>
        <li>{turn.samplesUsed} opponent samples</li>
        {turn.playedAction !== null && <li>played {turn.playedAction}</li>}
        {turn.costOfPlayed !== null && <li>cost {turn.costOfPlayed.toFixed(4)}</li>}
        {!turn.gradable && <li>not gradable: {turn.ungradableReason ?? 'unknown'}</li>}
      </ul>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th className="num">Value</th>
              <th className="num">Visit share</th>
            </tr>
          </thead>
          <tbody>
            {turn.topActions.map((action) => (
              <tr
                key={action.action}
                style={action.action === turn.playedAction ? { background: 'var(--accent-soft)' } : undefined}
              >
                <td>
                  {action.action}
                  {action.action === turn.playedAction && <span className="muted"> · played</span>}
                </td>
                <td className="num">{action.value.toFixed(4)}</td>
                <td className="num">{(action.visitShare * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Visit share is how the search spent its budget, and value is what it concluded. They disagree often: a move
        can be explored heavily and score poorly, which is the search telling you the position is close.
      </p>
    </div>
  );
}

export function AnalysisView({ analysisId }: { analysisId: string }) {
  const [envelope, setEnvelope] = useState<AnalysisEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    let live = true;
    getAnalysis(analysisId)
      .then((next) => live && setEnvelope(next))
      .catch(() => live && setError('No analysis with that id.'));
    return () => {
      live = false;
    };
  }, [analysisId]);

  if (error !== null) return <p className="error">{error}</p>;
  if (envelope === null) return <p className="muted">Loading…</p>;

  const doc = envelope.document;
  const selectedTurn = selected === null ? null : doc.turns.find((t) => t.turn === selected) ?? null;

  return (
    <>
      <section className="card">
        <h2>
          {doc.players !== undefined && doc.players.length === 2
            ? `${doc.players[0]} vs ${doc.players[1]}`
            : doc.replayId}
        </h2>
        <ul className="pills">
          <li>{doc.format}</li>
          {doc.rating !== null && doc.rating !== undefined && <li>rating {doc.rating}</li>}
          <li>seen from {doc.perspective}</li>
          <li>{profileLabel(doc.engine.searchBudgetMsPerTurn, doc.engine.opponentSamples)}</li>
          <li>
            {doc.totalTurns} turns, {doc.gradableTurns} gradable
          </li>
          <li>poke-engine {doc.engine.pokeEngineTag}</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          <a href={`https://replay.pokemonshowdown.com/${doc.replayId}`} target="_blank" rel="noreferrer">
            Watch the replay on Showdown
          </a>{' '}
          · analyzed {new Date(envelope.createdAt).toLocaleString()} · {doc.engine.opponentSamples} opponent teams
          sampled per turn at {doc.engine.searchBudgetMsPerTurn} ms of search
        </p>
      </section>

      <section className="card">
        <EvalCurve turns={doc.turns} onSelect={setSelected} />
        <div style={{ height: 8 }} />
        <CostBars turns={doc.turns} onSelect={setSelected} />
        <button className="secondary" onClick={() => setShowTable((v) => !v)} style={{ marginTop: 6 }}>
          {showTable ? 'Hide the numbers' : 'Show the numbers'}
        </button>
        {showTable && (
          <div className="scroll-x" style={{ marginTop: 12, maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th className="num">Turn</th>
                  <th className="num">Win probability</th>
                  <th>Played</th>
                  <th className="num">Cost</th>
                  <th>Gradable</th>
                </tr>
              </thead>
              <tbody>
                {doc.turns.map((turn) => (
                  <tr key={turn.turn} onClick={() => setSelected(turn.turn)} style={{ cursor: 'pointer' }}>
                    <td className="num">{turn.turn}</td>
                    <td className="num">{percent(turn.winProbability)}</td>
                    <td>{turn.playedAction ?? '—'}</td>
                    <td className="num">{turn.costOfPlayed === null ? '—' : turn.costOfPlayed.toFixed(4)}</td>
                    <td>{turn.gradable ? 'yes' : (turn.ungradableReason ?? 'no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedTurn !== null ? (
        <TurnDetail turn={selectedTurn} />
      ) : (
        <p className="muted">Click a turn in either chart to see the actions the engine ranked for it.</p>
      )}
    </>
  );
}
