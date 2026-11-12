// BTC trend-catcher for the make.fun btc-race-24h bounty.
//
// Strategy (long only, cbBTC/USDC, 1-minute bars):
//   - Entry: the close has risen at least ENTRY_BPS over the last LOOKBACK bars
//     (a 75-minute momentum burst). The first entry of the window needs 50 bps;
//     any re-entry needs 100 bps (a genuinely strong second move) and a 120-bar
//     cooldown after the previous exit. At most MAX_TRIPS round trips per window.
//   - Exit: take-profit at +TP_BPS from the entry close, a trailing stop of
//     TRAIL_BPS from the highest close since entry, or a MAX_HOLD_BARS cap.
//   - No new entries in the last 2 hours of the window (seq > NO_ENTRY_AFTER_SEQ):
//     a late entry has no time to develop and would just pay the round-trip cost.
//   - Sizing: all cash on each buy (max weight is 100% of equity), sells empty
//     the whole position. One position at a time.
//
// Why this shape: BTC 1-minute bars are mostly noise (5 bps stdev on the dev
// window) and a full round trip costs ~28 bps, so frequent trading loses. The
// dev window's only tradeable move was a +1.1% rise over hours 0-4; this bot
// catches that kind of multi-hour trend and otherwise sits in cash. Every
// parameter was checked for sensitivity on the dev window: the whole
// lookback 60-90 / entry 40-60 / trail 30-50 / TP 60-80 region is profitable,
// so no single value is load-bearing.
//
// Determinism: BigInt arithmetic only (bps comparisons on integer closes), no
// randomness, no wall clock, no environment reads. Two runs on the same bars
// produce byte-identical replies.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Strategy parameters (bps unless noted) ---
const LOOKBACK = 75; // bars of momentum history for the entry signal
const ENTRY_BPS = 50n; // first-entry threshold: close up >= 50 bps over LOOKBACK bars
const REENTRY_BPS = 100n; // re-entry threshold (must be a much stronger move)
const TRAIL_BPS = 40n; // trailing stop: sell if close falls 40 bps from the peak
const TP_BPS = 70n; // take-profit: sell if close gains 70 bps from the entry close
const MAX_TRIPS = 2; // at most 2 round trips per window
const COOLDOWN_BARS = 120; // bars to wait after an exit before a re-entry is allowed
const NO_ENTRY_AFTER_SEQ = 1320; // no new entries in the last 120 batches (~2 hours)
const MAX_HOLD_BARS = 480; // force an exit after 8 hours in a position
const MAX_SLIPPAGE_BPS = 100; // 1% slippage cap on every order (same as the kit baselines)

const BPS = 10_000n;

// Closes of the bars seen so far (bigints, price_scale 5). A gap adds nothing.
const closes: bigint[] = [];
// Entry reference: the close of the bar on which the buy was decided.
let entryClose: bigint | null = null;
// Highest close seen since the entry (trailing-stop reference).
let peakClose: bigint | null = null;
// Bar index (count of bars seen) at which the position was entered.
let entryBar: number | null = null;
// Bar index at which the last position was exited (cooldown reference).
let lastExitBar = -1_000_000_000;
// Completed round trips this window.
let trips = 0;
// True between sending a buy and seeing it fill (or learning it failed).
let buyPending = false;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in this batch's bar, if CBBTC has one. A gap batch carries no bar
    // and no trade is possible on it (no fresh close to decide on).
    const bar = batch.bars.find((b) => b.symbol === SYMBOL) ?? null;
    if (bar === null) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    const barIdx = closes.length - 1;

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // A buy sent on the previous batch either filled (position appeared) or
    // was rejected (no position). Clear the pending flag either way; if it
    // was rejected, drop the entry reference so a fresh signal can re-enter.
    if (buyPending) {
      buyPending = false;
      if (!holding) {
        entryClose = null;
        peakClose = null;
        entryBar = null;
      }
    }

    // Not holding but an entry reference is still set: the sell sent on an
    // earlier batch has filled. Only now does the round trip count (a sell
    // the market refused leaves the position held, so this never fires on
    // a rejection).
    if (!holding && entryClose !== null) {
      trips += 1;
      lastExitBar = barIdx;
      entryClose = null;
      peakClose = null;
      entryBar = null;
    }

    if (holding) {
      // First batch with the position: anchor the entry reference on the
      // close the buy was decided on (kept from the buy bar), or on this
      // close if the buy was decided before this bot saw a bar for it.
      if (entryClose === null) {
        entryClose = close;
        peakClose = close;
        entryBar = barIdx;
      }
      if (peakClose !== null && close > peakClose) peakClose = close;
      // Exit checks, all in integer bps against integer closes.
      const gainBps = ((close - entryClose) * BPS) / entryClose;
      const drawBps = peakClose !== null ? ((peakClose - close) * BPS) / peakClose : 0n;
      const heldBars = entryBar !== null ? barIdx - entryBar : 0;
      if (drawBps >= TRAIL_BPS || gainBps >= TP_BPS || heldBars >= MAX_HOLD_BARS) {
        // Sell the whole position. If the market refuses it (e.g. a price
        // past the slippage cap at the next open), the exit condition still
        // holds next bar and the sell is sent again; the trip is counted
        // only once the position is actually gone.
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Not holding: consider an entry.
    if (trips >= MAX_TRIPS) return [];
    if (state.seq > NO_ENTRY_AFTER_SEQ) return [];
    if (barIdx - lastExitBar < COOLDOWN_BARS) return [];
    if (closes.length <= LOOKBACK) return [];
    const back = closes[barIdx - LOOKBACK]!;
    const momentumBps = ((close - back) * BPS) / back;
    const threshold = trips > 0 ? REENTRY_BPS : ENTRY_BPS;
    if (momentumBps < threshold) return [];

    // Buy with all available cash, capped by the weight room (100% of equity
    // here, so the binding constraint is cash). The fee comes out of the
    // notional, so spending all cash is safe.
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (notional < minNotional) return [];
    entryClose = close;
    peakClose = close;
    entryBar = barIdx;
    buyPending = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
