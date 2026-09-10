import { useState } from 'react';
import { ApiError, parseReplayId, submit, type Perspective, type Profile } from '../api';

/**
 * The submit form. A replay id or a pasted replay URL; a side; a profile.
 *
 * `profile` is a named choice rather than a search budget, because the budget is CPU time
 * on the server and a caller does not get to set that. The two names are what the contract
 * exposes.
 */
export function SubmitForm({ navigate }: { navigate: (route: string) => void }) {
  const [input, setInput] = useState('');
  const [perspective, setPerspective] = useState<Perspective>('p1');
  const [profile, setProfile] = useState<Profile>('quick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const replayId = parseReplayId(input);
    if (replayId === '') {
      setError('Paste a Showdown replay link, or the id at the end of one.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submit({ replayId, perspective, profile });
      // A cached identity skips the queue entirely, which is the id-keyed design paying
      // off: two people asking about the same battle spend one core-minute, not two.
      navigate(result.kind === 'analysis' ? `/a/${result.analysis.analysisId}` : `/j/${result.job.jobId}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.kind === 'rate_limited'
            ? 'That is 20 submissions this hour from your address, which is the limit. Each one costs a couple of CPU-minutes, so the cap is real rather than decorative.'
            : cause.message
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Analyze a replay</h2>
      <form onSubmit={onSubmit}>
        <div className="row">
          <div style={{ flex: '1 1 260px' }}>
            <label htmlFor="replay">Showdown replay link or id</label>
            <input
              id="replay"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://replay.pokemonshowdown.com/gen9ou-2672927429"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="side">Side</label>
            <select id="side" value={perspective} onChange={(e) => setPerspective(e.target.value as Perspective)}>
              <option value="p1">p1</option>
              <option value="p2">p2</option>
            </select>
          </div>
          <div>
            <label htmlFor="profile">Profile</label>
            <select id="profile" value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
              <option value="quick">quick — 200ms/turn, 2 samples</option>
              <option value="ladder-parity">ladder-parity — 1s/turn, 8 samples</option>
            </select>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Analyze'}
          </button>
        </div>
      </form>
      <p className="muted" style={{ marginBottom: 0 }}>
        A <code>quick</code> analysis of a 24-turn battle takes about 25 seconds end to end, most of it waiting for
        a worker to start. <code>ladder-parity</code> matches the settings the iOS app's bundled analyses were
        generated under and takes about five times the engine time.
      </p>
      {error !== null && (
        <p className="error" style={{ marginBottom: 0, marginTop: 12 }}>
          {error}
        </p>
      )}
    </section>
  );
}
