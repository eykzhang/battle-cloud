import { z } from 'zod';
import { PROFILE_NAMES } from './profiles.ts';
import { PERSPECTIVES, SAFE_REPLAY_ID } from './identity.ts';

/** The only schema version battle-brain's decoder accepts. */
export const SUPPORTED_SCHEMA_VERSION = 1;

const int = z.number().int();
const finite = z.number().finite();

/**
 * A ranked root action. `visitShare` and `value` are checked for finiteness because a
 * non-finite value here is the exact failure the engine's own `_search_turn` guards
 * against, and because `JSON.parse` accepts no NaN token but a hand-built document could
 * still carry one through a different path.
 */
const RankedActionSchema = z
  .object({
    action: z.string(),
    visitShare: finite,
    value: finite,
  })
  .passthrough();

const TurnEvaluationSchema = z
  .object({
    turn: int,
    winProbability: finite.nullable().optional(),
    gradable: z.boolean(),
    ungradableReason: z.string().nullable().optional(),
    samplesUsed: int,
    playedAction: z.string().nullable().optional(),
    playedActionValue: finite.nullable().optional(),
    costOfPlayed: finite.nullable().optional(),
    topActions: z.array(RankedActionSchema),
  })
  .passthrough();

const EngineConfigurationSchema = z
  .object({
    searchBudgetMsPerTurn: int,
    opponentSamples: int,
    threads: int,
    usageStatsCutoff: int,
    pokeEngineTag: z.string(),
  })
  .passthrough();

/**
 * The engine's schema-v1 analysis document.
 *
 * Every object is `passthrough`, which is load-bearing rather than lax. The API serves
 * this document byte-faithfully, and zod's default is to strip unknown keys: stripping
 * would silently drop `rating` and `players`, which the real fixtures carry and the web
 * client wants, purely because battle-brain's Swift struct happens not to decode them.
 * Validation here answers "can the iOS client decode this", and it must not rewrite the
 * document while answering.
 */
export const SchemaV1DocumentSchema = z
  .object({
    schemaVersion: z.unknown(),
    replayId: z.string(),
    format: z.string(),
    perspective: z.enum(PERSPECTIVES),
    engine: EngineConfigurationSchema,
    totalTurns: int,
    gradableTurns: int,
    turns: z.array(TurnEvaluationSchema),
  })
  .passthrough()
  .superRefine((doc, ctx) => {
    if (doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemaVersion'],
        message:
          `unsupported schema version: expected ${SUPPORTED_SCHEMA_VERSION}, ` +
          `found ${JSON.stringify(doc.schemaVersion)}`,
      });
    }
  });

export type SchemaV1Document = z.infer<typeof SchemaV1DocumentSchema>;

/** `POST /v1/analyses`. */
export const SubmitRequestSchema = z
  .object({
    replayId: z
      .string()
      .regex(SAFE_REPLAY_ID, 'replay id contains unsafe characters')
      .refine((id) => !id.includes('..'), 'replay id must not contain ".."'),
    perspective: z.enum(PERSPECTIVES),
    profile: z.enum(PROFILE_NAMES).default('ladder-parity'),
  })
  .strict();

export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * A job as a client sees it. `estimatedTurns` and `estimatedSearchMs` are named as
 * estimates because that is what they are: the turn count comes from counting `|turn|`
 * lines in the log before any search runs, and the engine exposes no progress callback,
 * so nothing here is measured progress.
 */
export const JobSchema = z
  .object({
    jobId: z.string(),
    status: z.enum(JOB_STATUSES),
    replayId: z.string(),
    perspective: z.enum(PERSPECTIVES),
    profile: z.enum(PROFILE_NAMES),
    estimatedTurns: int.nullable(),
    estimatedSearchMs: int.nullable(),
    elapsedMs: int.nullable(),
    analysisId: z.string().nullable(),
    errorKind: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export type Job = z.infer<typeof JobSchema>;

/**
 * The envelope. The document is nested rather than spread at the top level so it stays
 * byte-identical to what the engine emitted, and so the fields schema v1 omits — `seed`
 * above all — have somewhere to live that is not inside the document.
 */
export const AnalysisEnvelopeSchema = z
  .object({
    analysisId: z.string(),
    seed: int,
    createdAt: z.string(),
    document: SchemaV1DocumentSchema,
  })
  .strict();

export type AnalysisEnvelope = z.infer<typeof AnalysisEnvelopeSchema>;
