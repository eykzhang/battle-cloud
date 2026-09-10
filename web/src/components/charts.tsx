import { useState } from 'react';
import type { TurnEvaluation } from '../api';

/**
 * Two charts of one battle, stacked on a shared turn axis.
 *
 * Deliberately two charts rather than one with two y-scales. Win probability is a
 * probability and cost is a difference between two values; drawing them against a common
 * axis would invite reading a crossing point that means nothing, and giving them separate
 * scales in one frame is the dual-axis chart, which makes any relationship the author
 * chooses appear by picking the scales. Small multiples say the same thing honestly.
 */

const W = 900;
const H = 220;
const PAD = { top: 14, right: 14, bottom: 26, left: 38 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface Hover {
  turn: number;
  x: number;
  y: number;
}

function useTurnHover(turns: TurnEvaluation[]) {
  const [hover, setHover] = useState<Hover | null>(null);
  const first = turns[0]?.turn ?? 1;
  const last = turns[turns.length - 1]?.turn ?? 1;
  const span = Math.max(1, last - first);

  const xOf = (turn: number) => PAD.left + ((turn - first) / span) * PLOT_W;

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    // The svg is scaled by CSS, so a client x has to come back through the viewBox.
    const svgX = ((event.clientX - box.left) / box.width) * W;
    const ratio = (svgX - PAD.left) / PLOT_W;
    const turn = Math.round(first + ratio * span);
    const clamped = Math.min(last, Math.max(first, turn));
    setHover({ turn: clamped, x: event.clientX - box.left, y: event.clientY - box.top });
  }

  return { hover, setHover, xOf, onMove, first, last };
}

function Grid({ ticks, label }: { ticks: { value: number; y: number }[]; label: string }) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick.value}>
          <line x1={PAD.left} x2={W - PAD.right} y1={tick.y} y2={tick.y} stroke="var(--grid)" strokeWidth={1} />
          <text x={PAD.left - 8} y={tick.y + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">
            {tick.value}
          </text>
        </g>
      ))}
      <text x={PAD.left} y={12} fontSize={11} fill="var(--text-muted)">
        {label}
      </text>
    </g>
  );
}

function TurnAxis({ first, last, xOf }: { first: number; last: number; xOf: (t: number) => number }) {
  const step = Math.max(1, Math.ceil((last - first) / 12));
  const ticks: number[] = [];
  for (let t = first; t <= last; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  return (
    <g>
      {ticks.map((t) => (
        <text key={t} x={xOf(t)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
          {t}
        </text>
      ))}
    </g>
  );
}

/**
 * Win probability per turn, from the analyzed player's side.
 *
 * Null win probabilities break the line rather than interpolating across the gap: a
 * straight segment through a turn the engine could not evaluate is a claim the data does
 * not make.
 */
export function EvalCurve({
  turns,
  onSelect,
}: {
  turns: TurnEvaluation[];
  onSelect: (turn: number) => void;
}) {
  const { hover, setHover, xOf, onMove, first, last } = useTurnHover(turns);
  const yOf = (p: number) => PAD.top + (1 - p) * PLOT_H;

  const segments: string[] = [];
  let current: string[] = [];
  for (const turn of turns) {
    if (turn.winProbability === null || turn.winProbability === undefined) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${xOf(turn.turn).toFixed(1)},${yOf(turn.winProbability).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));

  const hovered = hover === null ? null : turns.find((t) => t.turn === hover.turn) ?? null;

  return (
    <figure className="chart-figure">
      <figcaption>
        Win probability for the analyzed player, per turn. A gap is a turn the engine could not evaluate.
      </figcaption>
      <div className="chart-wrap">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={() => hover !== null && onSelect(hover.turn)}
          role="img"
          aria-label={`Win probability across ${turns.length} turns. The table below carries the same values.`}
        >
          <Grid
            ticks={[0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, y: yOf(v) }))}
            label="win probability"
          />
          {/* Even odds, drawn heavier than the grid: it is the line the curve is read against. */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yOf(0.5)}
            y2={yOf(0.5)}
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          {segments.map((d) => (
            <path key={d.slice(0, 24)} d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
          ))}
          {hovered?.winProbability != null && (
            <g>
              <line
                x1={xOf(hovered.turn)}
                x2={xOf(hovered.turn)}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                stroke="var(--text-muted)"
                strokeWidth={1}
              />
              <circle
                cx={xOf(hovered.turn)}
                cy={yOf(hovered.winProbability)}
                r={5}
                fill="var(--series-1)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            </g>
          )}
          <TurnAxis first={first} last={last} xOf={xOf} />
        </svg>
        {hover !== null && hovered !== null && (
          <div className="tooltip" style={{ left: Math.min(hover.x + 12, 640), top: 8 }}>
            <strong>Turn {hovered.turn}</strong>
            <br />
            {hovered.winProbability == null
              ? `not evaluated (${hovered.ungradableReason ?? 'unknown'})`
              : `win probability ${(hovered.winProbability * 100).toFixed(1)}%`}
            {hovered.playedAction !== null && (
              <>
                <br />
                played {hovered.playedAction}
              </>
            )}
            <br />
            <span className="muted">click to see the ranked actions</span>
          </div>
        )}
      </div>
    </figure>
  );
}

/**
 * How much the played move cost, per gradable turn: the value of the best action minus the
 * value of the one played. Zero means the engine would have done the same thing.
 */
export function CostBars({ turns, onSelect }: { turns: TurnEvaluation[]; onSelect: (turn: number) => void }) {
  const { hover, setHover, xOf, onMove, first, last } = useTurnHover(turns);
  const worst = Math.max(0.05, ...turns.map((t) => t.costOfPlayed ?? 0));
  const yOf = (cost: number) => PAD.top + (1 - cost / worst) * PLOT_H;
  const baseline = PAD.top + PLOT_H;
  const span = Math.max(1, last - first);
  // A 2px gap between neighbours, which is what keeps adjacent bars from reading as one.
  const barWidth = Math.max(3, Math.min(22, PLOT_W / (span + 1) - 2));

  const hovered = hover === null ? null : turns.find((t) => t.turn === hover.turn) ?? null;

  return (
    <figure className="chart-figure">
      <figcaption>
        Cost of the move actually played, per gradable turn: the best action's value minus the played action's.
      </figcaption>
      <div className="chart-wrap">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={() => hover !== null && onSelect(hover.turn)}
          role="img"
          aria-label="Cost of the played move per turn. The table below carries the same values."
        >
          <Grid
            ticks={[0, worst / 2, worst].map((v) => ({ value: Number(v.toFixed(2)), y: yOf(v) }))}
            label="cost"
          />
          {turns.map((turn) => {
            const cost = turn.costOfPlayed;
            if (cost === null || cost === undefined) return null;
            const height = Math.max(1, baseline - yOf(cost));
            return (
              <rect
                key={turn.turn}
                x={xOf(turn.turn) - barWidth / 2}
                y={baseline - height}
                width={barWidth}
                height={height}
                rx={Math.min(4, barWidth / 2)}
                fill="var(--series-2)"
                opacity={hovered === null || hovered.turn === turn.turn ? 1 : 0.55}
              />
            );
          })}
          <TurnAxis first={first} last={last} xOf={xOf} />
        </svg>
        {hovered !== null && (
          <div className="tooltip" style={{ left: Math.min(hover!.x + 12, 640), top: 8 }}>
            <strong>Turn {hovered.turn}</strong>
            <br />
            {hovered.costOfPlayed == null
              ? 'not gradable'
              : hovered.costOfPlayed === 0
                ? 'played the engine’s top action'
                : `cost ${hovered.costOfPlayed.toFixed(4)}`}
          </div>
        )}
      </div>
    </figure>
  );
}
