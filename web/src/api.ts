/**
 * The typed client for the battle-cloud API.
 *
 * The types below mirror `docs/contract.md`, which is the source of truth for both tiers.
 * They are duplicated rather than imported from `api/src/contract/`: that package is a
 * server built for Node's type stripping, and pulling it into a browser bundle to reuse
 * five interfaces would drag zod and pg's type surface across a boundary that exists on
 * purpose. If a field here disagrees with the contract, the contract is right.
 */

const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? 'https://m6tky2d13e.execute-api.us-east-2.amazonaws.com').replace(/\/+$/, '');

export type Perspective = 'p1' | 'p2';
export type Profile = 'ladder-parity' | 'quick';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Profile expansions, needed here because an analysis does not record which profile
 * produced it -- the profile is shorthand for these parameters, and two profiles that
 * expand identically share one analysis. A list row is labeled by matching backwards, and
 * an analysis produced under parameters no current profile names shows as "custom".
 */
export const PROFILES: Record<Profile, { searchBudgetMsPerTurn: number; opponentSamples: number }> = {
  'ladder-parity': { searchBudgetMsPerTurn: 1000, opponentSamples: 8 },
  quick: { searchBudgetMsPerTurn: 200, opponentSamples: 2 },
};

export function profileLabel(searchBudgetMsPerTurn: number, opponentSamples: number): string {
  for (const [name, params] of Object.entries(PROFILES)) {
    if (params.searchBudgetMsPerTurn === searchBudgetMsPerTurn && params.opponentSamples === opponentSamples) {
      return name;
    }
  }
  return 'custom';
}

export interface RankedAction {
  action: string;
  visitShare: number;
  value: number;
}

export interface TurnEvaluation {
  turn: number;
  winProbability: number | null;
  gradable: boolean;
  ungradableReason: string | null;
  samplesUsed: number;
  playedAction: string | null;
  playedActionValue: number | null;
  costOfPlayed: number | null;
  topActions: RankedAction[];
}

export interface AnalysisDocument {
  schemaVersion: number;
  replayId: string;
  format: string;
  perspective: Perspective;
  rating?: number | null;
  players?: string[];
  totalTurns: number;
  gradableTurns: number;
  engine: {
    searchBudgetMsPerTurn: number;
    opponentSamples: number;
    threads: number;
    usageStatsCutoff: number;
    pokeEngineTag: string;
  };
  turns: TurnEvaluation[];
}

export interface AnalysisEnvelope {
  analysisId: string;
  seed: number;
  createdAt: string;
  document: AnalysisDocument;
}

export interface AnalysisSummary {
  analysisId: string;
  replayId: string;
  format: string;
  rating: number | null;
  players: string[];
  perspective: Perspective;
  totalTurns: number;
  gradableTurns: number;
  searchBudgetMsPerTurn: number;
  opponentSamples: number;
  createdAt: string;
}

export interface AnalysisPage {
  analyses: AnalysisSummary[];
  nextCursor: string | null;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  replayId: string;
  perspective: Perspective;
  profile: Profile;
  estimatedTurns: number | null;
  estimatedSearchMs: number | null;
  elapsedMs: number | null;
  analysisId: string | null;
  errorKind: string | null;
  createdAt: string;
}

/** A submission either joins a job or returns an analysis that already exists. */
export type SubmitResult = { kind: 'job'; job: Job } | { kind: 'analysis'; analysis: AnalysisEnvelope };

/**
 * Carries the server's error kind, because the UI reacts to some of them specifically:
 * `rate_limited` is the caller's own doing and says to wait, `replay_not_found` is a typo
 * in the id, and everything else is ours to apologize for.
 */
export class ApiError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch (cause) {
    // A network failure and a 500 are different things to a reader: one says check your
    // connection, the other says the service is broken.
    throw new ApiError('unreachable', 'the API could not be reached', 0);
  }
  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    const error = (payload as { error?: { kind?: string; message?: string } } | null)?.error;
    throw new ApiError(error?.kind ?? 'unknown', error?.message ?? response.statusText, response.status);
  }
  return payload as T;
}

export function listAnalyses(options: { limit?: number; cursor?: string } = {}): Promise<AnalysisPage> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  const suffix = query.toString();
  return request<AnalysisPage>(`/v1/analyses${suffix === '' ? '' : `?${suffix}`}`);
}

export function getAnalysis(analysisId: string): Promise<AnalysisEnvelope> {
  return request<AnalysisEnvelope>(`/v1/analyses/${encodeURIComponent(analysisId)}`);
}

export function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`);
}

export async function submit(body: {
  replayId: string;
  perspective: Perspective;
  profile: Profile;
}): Promise<SubmitResult> {
  const response = await fetch(`${BASE_URL}/v1/analyses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new ApiError('unreachable', 'the API could not be reached', 0);
  });
  const payload: unknown = JSON.parse(await response.text());
  if (!response.ok) {
    const error = (payload as { error?: { kind?: string; message?: string } }).error;
    throw new ApiError(error?.kind ?? 'unknown', error?.message ?? response.statusText, response.status);
  }
  // 200 is a cached analysis, 202 is a job. The status is what distinguishes them, since
  // both are objects with an `analysisId` field and only one of them has a document.
  return response.status === 200
    ? { kind: 'analysis', analysis: payload as AnalysisEnvelope }
    : { kind: 'job', job: payload as Job };
}

/**
 * Pulls a replay id out of whatever a person pastes: an id, a replay URL, one with a
 * `?p2` suffix or a trailing slash. Showdown ids are `<format>-<number>`, optionally
 * with a `-<hash>` suffix on private replays.
 */
export function parseReplayId(input: string): string {
  const trimmed = input.trim();
  const withoutQuery = trimmed.split('?')[0] ?? trimmed;
  const lastSegment = withoutQuery.replace(/\/+$/, '').split('/').pop() ?? '';
  return lastSegment;
}
