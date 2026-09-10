import { useEffect, useState } from 'react';
import { AnalysisView } from './components/analysis';
import { JobView } from './components/job';
import { RecentAnalyses } from './components/recent';
import { SubmitForm } from './components/submit';

/**
 * Hash routing, hand-rolled.
 *
 * Three routes and no nesting, against a router that is 20 KB and a build-time decision
 * about server rewrites. Hash routes also mean a static host serves one file for every
 * URL with no redirect rules, which is what Cloudflare Pages does by default anyway.
 */
function useRoute(): [string, (next: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = (next: string) => {
    window.location.hash = next;
    window.scrollTo({ top: 0 });
  };
  return [route, navigate];
}

export function App() {
  const [route, navigate] = useRoute();
  const analysisMatch = /^\/a\/([\w-]+)$/.exec(route);
  const jobMatch = /^\/j\/([\w-]+)$/.exec(route);

  return (
    <div className="shell">
      <header className="masthead">
        <h1>
          <a href="#/" style={{ color: 'inherit' }}>
            battle-cloud
          </a>
        </h1>
        <p>Per-turn win probability for Pokémon Showdown replays, from a real search engine rather than a heuristic.</p>
      </header>

      {analysisMatch !== null && analysisMatch[1] !== undefined ? (
        <>
          <p style={{ marginTop: 0 }}>
            <a href="#/">← everything else</a>
          </p>
          <AnalysisView analysisId={analysisMatch[1]} />
        </>
      ) : jobMatch !== null && jobMatch[1] !== undefined ? (
        <>
          <p style={{ marginTop: 0 }}>
            <a href="#/">← everything else</a>
          </p>
          <JobView jobId={jobMatch[1]} navigate={navigate} />
        </>
      ) : (
        <>
          <SubmitForm navigate={navigate} />
          <RecentAnalyses navigate={navigate} />
          <p className="muted">
            Each analysis runs the same engine the desktop tool does, in an isolated process on a four-core worker
            that starts when there is work and exits when the queue is empty. The search is budgeted in wall-clock
            time per turn, so an overloaded worker would return a weaker analysis rather than a slower one — which is
            why one search runs per process and the parameters are part of an analysis's identity.
          </p>
        </>
      )}
    </div>
  );
}
