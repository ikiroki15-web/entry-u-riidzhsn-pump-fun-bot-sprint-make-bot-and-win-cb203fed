// Momentum breakout bot for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea: buy a fresh coin early, only after real buyers show up (buy volume and
// buy trade count rising, price already up a little from its first print), in a
// small fixed size. Then get out fast: partial take-profit, full take-profit,
// stop-loss, a trailing exit off the peak, and a hard max-hold in slots.
// Memecoins die fast, so no position is ever held hoping for a recovery.
//
// Everything here is deterministic: every decision derives from the hello and
// batch messages the harness sends (seed, slot, events, marks, fills, account).
// No clock, no Math.random, no environment reads, so the two grading runs
// produce byte-identical action logs.
//
// Price is virtual_quote_reserves / virtual_token_reserves, kept as a scaled
// bigint (PRICE_SCALE) so all comparisons are exact integer math.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Named parameters: the whole strategy in one place, easy to reason about.
// ---------------------------------------------------------------------------

/** SOL per buy, before the per-coin reserve cap bites (0.08 SOL). */
export const BUY_SIZE_LAMPORTS = 80_000_000n;
/** Smallest buy we bother with: above the 0.01 SOL round-trip guardrail. */
export const MIN_BUY_LAMPORTS = 12_000_000n;
/** A coin must hold at least this much real SOL reserve to be buyable. */
export const MIN_REAL_RESERVE_LAMPORTS = 1_200_000_000n;
/** Keep this much cash uncommitted so sells/fees never starve. */
export const CASH_BUFFER_LAMPORTS = 200_000_000n;

/** Entry window, in slots since the coin was first seen. */
export const MIN_COIN_AGE_SLOTS = 2;
export const MAX_COIN_AGE_SLOTS = 600;
/** Entry needs at least this many trades, and this many of them buys. */
export const MIN_TRADES_TO_ENTER = 5;
export const MIN_BUY_TRADES_TO_ENTER = 4;
/** Entry needs at least this much buy volume (SOL) since first seen. */
export const MIN_BUY_VOLUME_LAMPORTS = 800_000_000n;
/** Buys must dominate: buy SOL at least this multiple of sell SOL. */
export const MIN_BUY_SELL_RATIO_NUM = 3;
export const MIN_BUY_SELL_RATIO_DEN = 2;
/** Buy only while the price is up this much vs its first print... */
export const MIN_ENTRY_GAIN_BPS = 300;
/** ...and never once it has already run this far (do not chase the top). */
export const MAX_ENTRY_GAIN_BPS = 4_000;

/** Sell half the position once it is up this much. */
export const TAKE_PROFIT_PARTIAL_BPS = 3_500;
/** Sell everything once it is up this much. */
export const TAKE_PROFIT_FULL_BPS = 8_000;
/** Sell everything once it is down this much from entry. */
export const STOP_LOSS_BPS = -2_000;
/** After the peak gain reaches this, a pullback of this much exits all. */
export const TRAILING_ARM_BPS = 2_000;
export const TRAILING_PULLBACK_BPS = 1_200;
/** Force-exit a position held longer than this many slots. */
export const MAX_HOLD_SLOTS = 900;

/** At most this many new buys in one batch (spreads entries across slots). */
export const MAX_BUYS_PER_BATCH = 2;
/** Slippage tolerance on every order. */
export const MAX_SLIPPAGE_BPS = 500;

/** Scale factor for fixed-point prices (lamports per token * PRICE_SCALE). */
const PRICE_SCALE = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Per-coin flow stats, built from the batch events as they arrive.
// ---------------------------------------------------------------------------

interface CoinFlow {
  firstPrice: bigint;
  firstSlot: number;
  buySol: bigint;
  sellSol: bigint;
  buyTrades: number;
  trades: number;
  lastSlot: number;
}

interface HeldInfo {
  entryPrice: bigint;
  entrySlot: number;
  peakGainBps: number;
  partialSold: boolean;
}

/** Scaled price of a curve: virtual quote per virtual token. 0n when unknown. */
export function scaledPrice(state: BotState, mint: string): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  if (curve.virtual_token_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

/** Gain of `price` vs `base`, in basis points (integer division, may be negative). */
export function gainBps(price: bigint, base: bigint): number {
  if (base <= 0n || price <= 0n) return 0;
  return Number(((price - base) * 10_000n) / base);
}

export class PumpMomentumStrategy {
  private readonly flows = new Map<string, CoinFlow>();
  private readonly held = new Map<string, HeldInfo>();
  /** Mints we already bought once: one entry per coin, diversify instead. */
  private readonly traded = new Set<string>();

  /** Fold one batch of events into the per-coin flow stats. */
  observe(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!this.flows.has(event.mint)) {
          const virtualToken = BigInt(event.virtual_token_reserves);
          const virtualQuote = BigInt(event.virtual_sol_reserves);
          const price = virtualToken > 0n ? (virtualQuote * PRICE_SCALE) / virtualToken : 0n;
          this.flows.set(event.mint, {
            firstPrice: price,
            firstSlot: event.slot,
            buySol: 0n,
            sellSol: 0n,
            buyTrades: 0,
            trades: 0,
            lastSlot: event.slot,
          });
        }
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      let flow = this.flows.get(event.mint);
      if (flow === undefined) {
        // First sighting was a trade, not a create: seed from post-trade reserves.
        const virtualToken = BigInt(event.virtual_token_reserves);
        const virtualQuote = BigInt(event.virtual_quote_reserves);
        const price = virtualToken > 0n ? (virtualQuote * PRICE_SCALE) / virtualToken : 0n;
        flow = {
          firstPrice: price,
          firstSlot: event.slot,
          buySol: 0n,
          sellSol: 0n,
          buyTrades: 0,
          trades: 0,
          lastSlot: event.slot,
        };
        this.flows.set(event.mint, flow);
      }
      flow.trades += 1;
      flow.lastSlot = event.slot;
      const sol = BigInt(event.sol_amount);
      if (event.is_buy) {
        flow.buySol += sol;
        flow.buyTrades += 1;
      } else {
        flow.sellSol += sol;
      }
    }
    // Forget coins that went quiet long ago, so the map stays small.
    if (this.flows.size > 20_000) {
      const cutoff = batch.slot - 5_000;
      for (const [mint, flow] of this.flows) {
        if (flow.lastSlot < cutoff && !this.held.has(mint)) this.flows.delete(mint);
      }
    }
  }

  /** Decide this batch's orders: exits first, then fresh entries. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.observe(batch);
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // --- exits for every open position -------------------------------------
    for (const [mint, holding] of state.positions) {
      const price = scaledPrice(state, mint);
      if (price <= 0n) continue;
      let info = this.held.get(mint);
      if (info === undefined) {
        // First time we see this position: cost basis is the entry price.
        const entryPrice =
          holding.token_amount > 0n
            ? (holding.cost_lamports * PRICE_SCALE) / holding.token_amount
            : 0n;
        info = { entryPrice, entrySlot: slot, peakGainBps: 0, partialSold: false };
        this.held.set(mint, info);
      }
      if (info.entryPrice <= 0n) continue;
      const gain = gainBps(price, info.entryPrice);
      if (gain > info.peakGainBps) info.peakGainBps = gain;

      const heldTooLong = slot - info.entrySlot >= MAX_HOLD_SLOTS;
      const stopLoss = gain <= STOP_LOSS_BPS;
      const fullTakeProfit = gain >= TAKE_PROFIT_FULL_BPS;
      const trailingExit =
        info.peakGainBps >= TRAILING_ARM_BPS &&
        gain <= info.peakGainBps - TRAILING_PULLBACK_BPS;

      if (stopLoss || fullTakeProfit || trailingExit || heldTooLong) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        continue;
      }
      if (!info.partialSold && gain >= TAKE_PROFIT_PARTIAL_BPS) {
        info.partialSold = true;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount / 2n,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // Drop bookkeeping for positions that are gone.
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint)) this.held.delete(mint);
    }

    // --- entries: fresh coins with early buying momentum --------------------
    const maxOrders = state.hello.caps.max_orders_per_batch;
    let buys = 0;
    if (
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      orders.length < maxOrders
    ) {
      for (const [mint, flow] of this.flows) {
        if (buys >= MAX_BUYS_PER_BATCH) break;
        if (orders.length >= maxOrders) break;
        if (state.committedPositionCount() + buys >= state.hello.caps.max_open_positions) break;
        if (this.traded.has(mint) || state.positions.has(mint)) continue;
        // A buy on this mint is already in flight (pending is keyed by
        // client_id, so scan its values): do not stack a second buy on it.
        let buyPending = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy' && p.order.mint === mint) {
            buyPending = true;
            break;
          }
        }
        if (buyPending) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;

        const age = slot - flow.firstSlot;
        if (age < MIN_COIN_AGE_SLOTS || age > MAX_COIN_AGE_SLOTS) continue;
        if (flow.trades < MIN_TRADES_TO_ENTER) continue;
        if (flow.buyTrades < MIN_BUY_TRADES_TO_ENTER) continue;
        if (flow.buySol < MIN_BUY_VOLUME_LAMPORTS) continue;
        // Buys must dominate sells by the required ratio.
        if (flow.buySol * BigInt(MIN_BUY_SELL_RATIO_DEN) < flow.sellSol * BigInt(MIN_BUY_SELL_RATIO_NUM)) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;

        const price = scaledPrice(state, mint);
        if (price <= 0n || flow.firstPrice <= 0n) continue;
        const gain = gainBps(price, flow.firstPrice);
        if (gain < MIN_ENTRY_GAIN_BPS || gain > MAX_ENTRY_GAIN_BPS) continue;

        // Size: fixed small size, capped at 100 bps of real reserve via the
        // harness cap, and never below the guardrail-sized minimum.
        const cap = state.maxBuyLamports(mint);
        let size = BUY_SIZE_LAMPORTS < cap ? BUY_SIZE_LAMPORTS : cap;
        const free = state.freeCashLamports() - CASH_BUFFER_LAMPORTS;
        if (size > free) size = free;
        if (size < MIN_BUY_LAMPORTS) continue;

        this.traded.add(mint);
        buys += 1;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    return orders;
  }
}
