// Entrypoint: pump.fun momentum bot (agent-fun/replay/v2).
//
// The harness speaks first with a hello, then sends one batch per slot and
// expects exactly one reply per batch, echoing that batch's seq, carrying
// this batch's orders. The vendor shim (vendor/makefun-bot.ts) owns that wire:
// it reads stdin line by line, keeps BotState current (cash, positions, every
// curve's latest reserves, orders still in flight), and writes the reply to
// stdout. All trading logic lives in strategy.ts; this file only wires the
// strategy to the shim, so the entrypoint stays small and every authored line
// of the strategy is easy to trace in the transcripts.
//
// Determinism: the strategy uses only hello/batch state, never the clock or
// randomness, so the two grading executions produce identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { PumpMomentumStrategy } from './strategy.ts';

const strategy = new PumpMomentumStrategy();

await runBot({
  onHello(state) {
    // Nothing to seed: the strategy derives everything from the batches.
    // (The hello seed is available as state.hello.seed if a future revision
    // ever needs deterministic tie-breaking.)
    console.error(`hello: seed=${state.hello.seed} capital=${state.hello.capital.lamports}`);
  },
  onBatch(state, batch) {
    return strategy.decide(state, batch);
  },
  onDone(state, done) {
    console.error(
      `done: reason=${done.reason} cash=${state.cash} positions=${state.positions.size}`,
    );
  },
});
