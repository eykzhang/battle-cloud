import { useEffect, useRef, useState } from 'react';
import { getJob, type Job } from '../api';

/**
 * A queued job, polled until it resolves.
 *
 * Polling rather than a socket or SSE: the engine exposes no progress callback, so there
 * is nothing to stream. What the API can say is which of five states the job is in and
 * how long the search is expected to take, and a request every two seconds carries that
 * as well as a held-open connection would, without the connection.
 */
export function JobView({ jobId, navigate }: { jobId: string; navigate: (route: string) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let live = true;
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 1000);

    async function poll() {
      try {
        const next = await getJob(jobId);
        if (!live) return;
        setJob(next);
        if (next.status === 'succeeded' && next.analysisId !== null) {
          navigate(`/a/${next.analysisId}`);
          return;
        }
        if (next.status === 'failed' || next.status === 'cancelled') return;
      } catch {
        if (live) setError('Lost contact with the API while waiting.');
        return;
      }
      if (live) setTimeout(() => void poll(), 2000);
    }
    void poll();

    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [jobId, navigate]);

  if (error !== null) return <p className="error">{error}</p>;
  if (job === null) return <p className="muted">Looking up the job…</p>;

  const searchSeconds = job.estimatedSearchMs === null ? null : Math.round(job.estimatedSearchMs / 1000);

  return (
    <section className="card">
      <h2>
        {job.status === 'queued' && 'Waiting for a worker'}
        {job.status === 'running' && 'Analyzing'}
        {job.status === 'failed' && 'The analysis failed'}
        {job.status === 'cancelled' && 'The analysis was cancelled'}
        {job.status === 'succeeded' && 'Done'}
      </h2>
      <ul className="pills">
        <li>{job.replayId}</li>
        <li>from {job.perspective}</li>
        <li>{job.profile}</li>
        {job.estimatedTurns !== null && <li>{job.estimatedTurns} turns</li>}
      </ul>
      {job.status === 'queued' && (
        <p className="muted">
          A worker starts on demand and takes about 17 seconds to schedule and pull its image, so the first job of a
          quiet period waits roughly that long before anything happens. Nothing is lost meanwhile: the job is a row
          in Postgres, and an hourly sweep picks up anything a trigger missed.
        </p>
      )}
      {job.status === 'running' && searchSeconds !== null && (
        <p className="muted">
          The engine expects about {searchSeconds} seconds of search for this replay. There is no progress bar because
          the engine reports no progress; this is an estimate from the turn count, not a measurement.
        </p>
      )}
      {job.status === 'failed' && <p className="error">Error kind: {job.errorKind ?? 'unknown'}</p>}
      <p className="muted" style={{ marginBottom: 0 }}>
        {elapsed}s elapsed · status <code>{job.status}</code>
      </p>
    </section>
  );
}
