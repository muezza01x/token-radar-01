// Token Radar — the value model and farm-plan generator.
//
// One sealed snapshot in, one ranked board out. Everything below is derived from the
// snapshot's own ten fields per protocol; no protocol name is ever special-cased, no
// network is touched, no randomness is used, so two runs write identical bytes.
//
// THE IMPLIED VALUE MODEL (version radar-2)
// -----------------------------------------
// A protocol's implied value is what its token would be worth if its record stayed as
// it is. We anchor it to the market's own revealed pricing of comparable protocols:
//
//   sectorMultiple = clamp( median(mcap_usd / tvl_usd) over the snapshot's ALREADY-TRADING
//                    protocols in the same category, 0.05, 2.0 )
//                    — used only when the category has >= 3 trading peers; otherwise the
//                    global median over every trading protocol with mcap > 0 and tvl > 0.
//   base           = tvl_usd * sectorMultiple
//   momentum       = 1 + clamp(change_7d, -50, +100)/100 * 0.6      (null growth -> 0)
//   seasoning      = 0.75 + min(age_days, 730)/730 * 0.45           (null age -> 365)
//   breadth        = 1 + min(chains.length - 1, 5) * 0.03
//   implied        = clamp(round(base * momentum * seasoning * breadth), 1, 1e14)
//
// Why each factor:
// - sectorMultiple: the snapshot itself tells us what the market pays per dollar of TVL
//   in each sector (e.g. Dexs trade richer than Lending). Using the peers' median mcap/TVL
//   makes the multiple follow from the data, not a guessed constant. The clamp stops one
//   thin or freak peer (a prediction market with tiny TVL and a huge cap) from dominating.
// - momentum: a protocol growing TVL this week is compounding its future fee base; one
//   bleeding TVL is worth less. Asymmetric clamp (-50..+100) keeps a single 4000% spike
//   from inventing value, and the 0.6 weight treats growth as a tilt, not the whole story.
// - seasoning: how long it has run with NO token. A long tokenless track record means more
//   accrued "airdrop debt" and a more proven product; a two-day-old protocol is unproven.
//   age_days = as_of - listed_at. The factor rises 0.75 -> 1.20 over two years, then flat.
// - breadth: a protocol live on more chains has a wider distribution surface for a future
//   token; small capped bonus (max +15%) so it never outranks real TVL.
//
// Pre-token = mcap_usd, gecko_id and symbol ALL null (the record carries no token). The
// board ranks ONLY pre-token protocols. Already-trading protocols are kept apart in a
// "live" set shown at the market's own mcap, never mixed into the ranked board.
//
// Board selection: every watchlist slug (the floor, never the ceiling) PLUS every rankable
// pre-token protocol below the floor, by TVL. "Rankable" applies the house's own hygiene so
// the early rows are genuine launches, not wrapped/staked products of a token that trades:
// not CEX, not a Bridge/Canonical Bridge/Liquid Staking/Liquid Restaking/Restaked BTC product,
// no version-marker name (a pool of a parent), no whole word wrapped/staked/staking.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants, stated in the dashboard and used by impliedValue. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  min_peers: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  seasoning_floor: number;
  seasoning_range: number;
  seasoning_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_cap: number;
  value_cap: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  min_peers: 3,
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.6,
  seasoning_floor: 0.75,
  seasoning_range: 0.45,
  seasoning_days: 730,
  unknown_age_days: 365,
  breadth_step: 0.03,
  breadth_cap: 5,
  value_cap: 100_000_000_000_000,
};

export const MODEL_VERSION = 'radar-2';

/** A category's sector multiple and how many trading peers produced it. */
export interface SectorStat {
  multiple: number;
  peers: number;
  fallback: boolean;
}

/** The market anchor computed once from the snapshot's trading protocols. */
export interface MarketAnchor {
  global_median: number;
  global_peers: number;
  sectors: Record<string, SectorStat>;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    sector_multiple: number;
    sector_peers: number;
    sector_fallback: boolean;
    base_usd: number;
    growth_pct: number;
    momentum: number;
    seasoning: number;
    breadth: number;
  };
  farm_steps: string[];
}

/** A live (already-trading) protocol shown at the market's own value, with a post-token plan. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  listed_at: string | null;
  symbol: string | null;
  mcap_tvl: number | null;
  farm_steps: string[];
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  anchor: MarketAnchor;
  watchlist: string[];
  stats: { protocols: number; watchlist: number; board: number; early: number; live: number };
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, else fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from listed_at to as_of, clamped at 0; null when either date is absent/bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of a parent. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORDS = /\b(wrapped|staked|staking)\b/i;
const PRODUCT_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol is a genuine pre-token launch the board may rank (house hygiene). */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !PRODUCT_CATS.has(p.category ?? '') && !VERSIONED.test(p.name) && !PRODUCT_WORDS.test(p.name);
}

/** Median of a numeric array (0 when empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The market anchor: for each category, the median mcap/TVL of its already-trading peers,
 * clamped; a global median fallback for thin categories. Computed once, deterministically.
 */
export function marketAnchor(snapshot: Snapshot, model: ModelConstants = MODEL): MarketAnchor {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const mcap = p.mcap_usd;
    if (mcap === null || mcap <= 0 || p.tvl_usd <= 0) continue;
    const ratio = mcap / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorized';
    const arr = byCat.get(key) ?? [];
    arr.push(ratio);
    byCat.set(key, arr);
  }
  const globalMedian = clamp(median(all), model.multiple_floor, model.multiple_cap);
  const sectors: Record<string, SectorStat> = {};
  for (const [cat, ratios] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const enough = ratios.length >= model.min_peers;
    const raw = enough ? median(ratios) : globalMedian;
    sectors[cat] = {
      multiple: round4(clamp(raw, model.multiple_floor, model.multiple_cap)),
      peers: ratios.length,
      fallback: !enough,
    };
  }
  return { global_median: round4(globalMedian), global_peers: all.length, sectors };
}

/** The sector stat for a protocol's category, falling back to the global median. */
function sectorFor(anchor: MarketAnchor, category: string | null, model: ModelConstants): SectorStat {
  const key = category ?? 'Uncategorized';
  const s = anchor.sectors[key];
  if (s !== undefined) return s;
  return { multiple: round4(clamp(anchor.global_median, model.multiple_floor, model.multiple_cap)), peers: 0, fallback: true };
}

/** The full breakdown and implied value one protocol gets under the model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  anchor: MarketAnchor,
  model: ModelConstants = MODEL,
): { implied: number; age: number | null; sector: SectorStat; base: number; growthPct: number; momentum: number; seasoning: number; breadth: number } {
  const age = ageDays(asOf, p.listed_at);
  const sector = sectorFor(anchor, p.category, model);
  const base = p.tvl_usd * sector.multiple;
  const growthPct = clamp(finite(p.change_7d, 0), model.growth_floor, model.growth_cap);
  const momentum = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const seasoning = model.seasoning_floor + (clamp(ageForModel, 0, model.seasoning_days) / model.seasoning_days) * model.seasoning_range;
  const breadth = 1 + clamp(p.chains.length - 1, 0, model.breadth_cap) * model.breadth_step;
  const implied = clamp(Math.round(base * momentum * seasoning * breadth), 1, model.value_cap);
  return { implied, age, sector, base, growthPct, momentum, seasoning, breadth };
}

// ---------------------------------------------------------------- farm plans
//
// A farm plan is concrete actions with what they cost and how long they take, derived from
// the protocol's category, chains, TVL and age — never a hand-written list of names. Each
// category family below describes the real on-chain actions a farmer performs for that kind
// of protocol. Capital scales with TVL (a bigger protocol warrants a bigger qualifying
// position); gas scales with the chain; the hold window scales with tokenless age.

/** Capital one qualifying position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** Rough gas per transaction on a chain, in dollars (Ethereum L1 dear, L2s/alt-L1s cheap). */
function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 6;
  if (c === 'bitcoin') return 3;
  if (['solana', 'sui', 'aptos', 'ton', 'tron'].includes(c)) return 0.5;
  if (['arbitrum', 'base', 'optimism', 'scroll', 'linea', 'blast', 'zksync', 'polygon', 'monad', 'hyperliquid l1', 'avalanche', 'binance', 'bsc', 'fantom', 'gnosis', 'celo', 'moonbeam', 'starknet', 'katana', 'unichain', 'hemi', 'flare', 'world chain', 'core', 'babylon genesis', 'bittensor', 'plasma', 'robinhood chain'].includes(c)) return 0.5;
  return 1;
}

/** How long to hold, from tokenless age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

const money = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

interface Step {
  text: string;
  cost: string;
  time: string;
}

/** Render a step as one gate-safe string: action + cost + time, trimmed to 20..600 chars. */
export function stepText(s: Step): string {
  let out = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`.trim();
  if (out.length > 600) out = `${out.slice(0, 597)}...`;
  if (out.length < 20) out = `${out} Keep the position open and re-check weekly.`;
  return out;
}

/**
 * The category-specific core actions (2-3 steps) for a protocol. Each family is a distinct
 * real workflow; the shared wallet/hold/claim steps wrap them in farmSteps below.
 */
function coreActions(p: SnapshotProtocol, capital: number, chain: string, gas: number, hold: number): Step[] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const g = money(gas);
  const g2 = money(gas * 2);
  const cap = money(capital);
  const half = money(Math.round(capital / 2));

  // Lending / CDP / collateral: supply, enable collateral, borrow small, keep healthy.
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return [
      { text: `Supply ${cap} of USDC to ${name} on ${chain} and switch on the collateral toggle so the deposit counts toward any points program.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
      { text: `Borrow a small amount (~${half}) of a stable asset against the collateral, keeping the health factor above 2, then repay it to show a full borrow/repay cycle.`, cost: `~${g2} gas + borrow interest for the days it is open`, time: '20 min, repeat once mid-window' },
      { text: `Top up or adjust the position once a week so the account stays active across more than one rewards snapshot.`, cost: `~${g} gas a week`, time: '10 min a week' },
    ];
  }
  // DEX / liquidity manager: LP both sides, keep in range, swap volume.
  if (c.includes('dex') || c.includes('liquidity manager') || c.includes('swap')) {
    return [
      { text: `Add ${cap} of liquidity to ${name}'s deepest pool on ${chain}, split evenly across the two sides (e.g. ${half} ETH + ${half} USDC), and keep the LP position open.`, cost: `${cap} capital + ~${g2} gas (approve + add)`, time: '20 min to set up' },
      { text: `If the pool is concentrated-liquidity, set a range around the current price and rebalance when price drifts out, so the position keeps earning fees.`, cost: `~${g} gas per rebalance`, time: '10 min, check twice a week' },
      { text: `Route one small swap (~${money(Math.round(capital / 5))}) through ${name} each week to register trading volume, not just passive liquidity.`, cost: `~${g} gas + the swap's price impact`, time: '5 min a week' },
    ];
  }
  // Yield / aggregator / farm / index / capital allocator / risk curator: deposit a vault.
  if (c.includes('yield') || c.includes('farm') || c.includes('index') || c.includes('allocator') || c.includes('curator') || c.includes('risk')) {
    return [
      { text: `Deposit ${cap} of USDC into a ${name} vault on ${chain} (pick the curated or flagship vault with the deepest TVL) and hold the receipt shares.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
      { text: `Leave the deposit to auto-compound; do not churn it, since most vault rewards weight time-in-position and net deposits.`, cost: `the ${cap} stays deployed; no extra fee`, time: `hold ${hold} days` },
      { text: `Check the vault's reported APY and any points dashboard once a week and add a small top-up if the strategy changes.`, cost: `~${g} gas if you top up`, time: '10 min a week' },
    ];
  }
  // Basis / derivatives / options / synthetics / leveraged: margin + one hedged position.
  if (c.includes('basis') || c.includes('derivative') || c.includes('option') || c.includes('synthetic') || c.includes('leveraged') || c.includes('perp')) {
    return [
      { text: `Deposit ${cap} of USDC as margin on ${name} on ${chain} and open one small delta-neutral position (e.g. long spot / short the perp) to register volume without directional risk.`, cost: `${cap} margin + ~${g2} gas + funding while open`, time: '25 min to set up' },
      { text: `Monitor funding and margin daily; roll or close the hedge before it drifts, keeping utilization low so you are never liquidated.`, cost: `funding payments + ~${g} gas per roll`, time: '5 min a day' },
      { text: `Close and re-open a fresh small position once a week so the account shows sustained activity, not a single trade.`, cost: `~${g2} gas a week`, time: '15 min a week' },
    ];
  }
  // Restaking / staking pool / BTC staking: stake the native asset, mind the lockup.
  if (c.includes('restak') || c.includes('staking') || c.includes('anchor btc') || c.includes('decentralized btc')) {
    return [
      { text: `Stake ${cap} worth of the chain's native staking asset (ETH on Ethereum, BTC on Bitcoin) through ${name} and keep the liquid receipt token.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
      { text: `Note any unbonding/lockup period before you stake; keep the receipt so you stay eligible for restaking or points multipliers.`, cost: `no fee to read; capital locked for the unbonding window`, time: '5 min to check' },
      { text: `If ${name} offers a restaking or delegation step, delegate the receipt to a listed operator to stack the extra reward layer.`, cost: `~${g} gas`, time: '10 min, once' },
    ];
  }
  // Bridge / cross-chain: move funds and actually use them on the destination.
  if (c.includes('bridge')) {
    return [
      { text: `Bridge ${cap} of USDC from Ethereum to ${chain} through ${name}, then use the bridged funds in a destination app (a swap or a deposit) so the transfer is not idle.`, cost: `${cap} capital + ~${g2} gas + the bridge fee`, time: '20 min plus bridge finality' },
      { text: `Bridge a portion back after a few days to show two-way volume, which many bridge reward programs weight more than one-way deposits.`, cost: `~${g2} gas + the return bridge fee`, time: '15 min, once mid-window' },
      { text: `Repeat a small bridge (~${money(Math.round(capital / 5))}) weekly to keep the route active across snapshots.`, cost: `~${g} gas + fee a week`, time: '10 min a week' },
    ];
  }
  // RWA: mint a yield-bearing real-world asset and hold to accrual.
  if (c.includes('rwa')) {
    return [
      { text: `Mint ${cap} of ${name}'s yield-bearing asset (a tokenized T-bill or credit vault) on ${chain}, completing any access/allowlist step the issuer requires.`, cost: `${cap} capital + ~${g} gas; some issuers require KYC`, time: '20 min, plus allowlist approval if any' },
      { text: `Hold the asset to accrue the underlying yield; RWA rewards usually weight held balance and time, not trading.`, cost: `the ${cap} stays minted; no extra fee`, time: `hold ${hold} days` },
      { text: `Test a small redemption once to confirm the exit works before committing more capital.`, cost: `~${g} gas + any redemption fee`, time: '15 min, once' },
    ];
  }
  // Chain (an L1/L2 itself): bridge in, use dapps, transact weekly.
  if (c.includes('chain')) {
    return [
      { text: `Bridge ${cap} of ETH/USDC onto ${name} (${chain}) through its canonical or a listed bridge, so you hold native gas and a stable balance on the chain.`, cost: `${cap} capital + ~${g2} gas + bridge fee`, time: '20 min plus finality' },
      { text: `Use two or three native dapps (a swap, a lend, an NFT mint) to spread activity across the ecosystem a future token would reward.`, cost: `~${g} gas per dapp`, time: '30 min, once' },
      { text: `Make one on-chain transaction a week (a swap or a transfer) to keep the wallet active across the chain's snapshots.`, cost: `~${g} gas a week`, time: '5 min a week' },
    ];
  }
  // Prediction market: fund and take positions across a few markets.
  if (c.includes('prediction')) {
    return [
      { text: `Fund ${cap} of USDC on ${name} on ${chain} and take small positions (~${money(Math.round(capital / 5))} each) across two or three live markets.`, cost: `${cap} capital + ~${g} gas per position`, time: '20 min to set up' },
      { text: `Let at least one market resolve and claim the outcome, so the account shows a full trade lifecycle, not just open orders.`, cost: `~${g} gas to claim; position risk is the stake`, time: 'wait for resolution, then 5 min' },
      { text: `Open a fresh small position weekly to keep volume accruing toward any rewards program.`, cost: `~${g} gas + the stake a week`, time: '10 min a week' },
    ];
  }
  // Launchpad: commit to a launch and claim the allocation.
  if (c.includes('launchpad')) {
    return [
      { text: `Connect a fresh wallet to ${name} on ${chain}, complete any registration/allowlist, and commit ${cap} to a live launch or sale.`, cost: `${cap} capital + ~${g} gas; some launches require KYC`, time: '20 min, plus sale window' },
      { text: `Claim the allocation when the sale settles and hold or stake it per the launch's vesting terms.`, cost: `~${g} gas to claim`, time: '10 min at settlement' },
      { text: `Participate in the next launch or a community task to stay eligible for the platform's own future token.`, cost: `~${g} gas per task`, time: '15 min per launch' },
    ];
  }
  // Privacy: shield, transfer privately, unshield a test amount.
  if (c.includes('privacy')) {
    return [
      { text: `Shield ${cap} of the supported asset into ${name} on ${chain}, generating a fresh private note and keeping its secret offline.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
      { text: `Make one private transfer to a second wallet you control, then unshield a small test amount to confirm the exit path works.`, cost: `~${g2} gas`, time: '20 min, once' },
      { text: `Keep a shielded balance over the window; privacy rewards weight shielded time and distinct private transfers.`, cost: `the ${cap} stays shielded`, time: `hold ${hold} days` },
    ];
  }
  // Payments / card: fund and spend.
  if (c.includes('payment') || c.includes('card')) {
    return [
      { text: `Fund ${cap} of stablecoin into a ${name} account on ${chain} and make one real payment or transfer to a second address you control.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
      { text: `If ${name} issues a card, order it and make one small purchase so the account shows spend, not just a balance.`, cost: `the purchase amount + any card fee`, time: '10 min, plus delivery' },
      { text: `Repeat a small payment weekly to keep the account active across rewards snapshots.`, cost: `~${g} gas + the payment a week`, time: '5 min a week' },
    ];
  }
  // Insurance: buy cover and keep the policy.
  if (c.includes('insurance')) {
    return [
      { text: `Buy ${cap} of cover from ${name} on ${chain} for a protocol or asset you actually hold, and keep the policy active.`, cost: `${cap} premium + ~${g} gas`, time: '15 min to set up' },
      { text: `Read the claim process and coverage terms so you know the trigger and payout before you need it.`, cost: 'no fee to read', time: '10 min, once' },
      { text: `Renew or extend the policy before it lapses so coverage (and any rewards) stay continuous.`, cost: `renewal premium + ~${g} gas`, time: '10 min at renewal' },
    ];
  }
  // Token locker / governance incentives: lock/bond and vote.
  if (c.includes('locker') || c.includes('governance')) {
    return [
      { text: `Lock or bond ${cap} of the supported asset through ${name} on ${chain} for the shortest qualifying term, keeping the lock receipt.`, cost: `${cap} capital locked + ~${g} gas`, time: '15 min to set up' },
      { text: `Vote on a live governance proposal or gauge so the account shows participation, which incentive programs weight alongside the lock.`, cost: `~${g} gas per vote`, time: '10 min per proposal' },
      { text: `Extend or re-lock before the term ends to keep the boost continuous across snapshots.`, cost: `~${g} gas`, time: '10 min at expiry' },
    ];
  }
  // Stablecoin / wrapper / algo-stables: mint, hold, redeem test.
  if (c.includes('stable') || c.includes('wrapper')) {
    return [
      { text: `Mint or deposit ${cap} of ${name}'s stable asset on ${chain} from the supported collateral, and hold the minted balance.`, cost: `${cap} collateral + ~${g} gas`, time: '15 min to set up' },
      { text: `Hold the stable balance over the window; wrapper/stable rewards weight held supply and time, not churn.`, cost: `the ${cap} stays minted`, time: `hold ${hold} days` },
      { text: `Test a small redemption back to the collateral once to confirm the peg exit works.`, cost: `~${g} gas + any redemption fee`, time: '15 min, once' },
    ];
  }
  // CeDeFi: deposit via the app, note custodial risk.
  if (c.includes('cedefi')) {
    return [
      { text: `Deposit ${cap} of USDC into ${name} through its app on ${chain}, completing any onboarding the platform requires.`, cost: `${cap} capital + ~${g} gas; custodial risk applies`, time: '20 min, plus onboarding' },
      { text: `Keep the deposit in the yield product and read the withdrawal terms so you know the exit before committing more.`, cost: `the ${cap} stays deployed`, time: `hold ${hold} days` },
      { text: `Check the account and any points dashboard weekly; make a small top-up to stay active.`, cost: `~${g} gas if you top up`, time: '10 min a week' },
    ];
  }
  // Fallback: a generic deposit + weekly action for any category not matched above.
  return [
    { text: `Deposit ${cap} of USDC into ${name} on ${chain} through its main app and keep the position open.`, cost: `${cap} capital + ~${g} gas`, time: '15 min to set up' },
    { text: `Make one qualifying action each week (a deposit, a swap, a borrow or a vote) so the wallet stays active across snapshots.`, cost: `~${g} gas a week`, time: '10 min a week' },
  ];
}

/**
 * A protocol's full farm plan: a fresh-wallet step, the category-specific core actions, a
 * hold window, and a claim/log step. 5-7 steps, each with a cost and a time, all derived
 * from the protocol's own record.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const core = coreActions(p, capital, chain, gas, hold);
  const steps: Step[] = [
    { text: `Use a fresh wallet holding only the funds you plan to farm, fund it with gas on ${chain}, and keep its seed phrase offline.`, cost: `under ${money(gas)} of gas to start`, time: '5 min' },
    ...core,
    { text: `Hold the position for at least ${hold} days so the activity lands in more than one rewards snapshot; younger protocols need a longer window to qualify.`, cost: `the ${money(capital)} stays in the position`, time: `${hold} days` },
    { text: `Before withdrawing, open ${p.name}'s own points/rewards page and claim only from the link it publishes; never pay to claim and never sign a blind approval.`, cost: 'no fee to check; never pay to claim', time: '10 min' },
    { text: `Log the wallet, dates and every transaction hash in a farm sheet so you can repeat the position or unwind it cleanly.`, cost: 'nothing but the log', time: '5 min' },
  ];
  return steps.map(stepText);
}

/** A post-token plan for an already-trading protocol: stake/LP/governance, not a launch farm. */
export function liveFarmSteps(p: SnapshotProtocol): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const g = money(gas);
  const cap = money(capital);
  const sym = p.symbol ?? 'the token';
  const steps: Step[] = [
    { text: `Buy ${cap} of ${sym} on a liquid venue and move it to a fresh wallet on ${chain}; this is a post-token position, not a launch farm.`, cost: `${cap} capital + ~${g} gas + trading fee`, time: '15 min' },
    { text: `Stake ${sym} in ${p.name}'s own staking or governance module (or lock it for the boost term) to earn the protocol's real yield.`, cost: `${cap} staked + ~${g} gas`, time: '15 min, mind any unbonding' },
    { text: `If ${p.name} has a deep liquidity pool, add ${cap} of ${sym}/stable liquidity to earn fees on top of the stake.`, cost: `${cap} capital + ~${money(gas * 2)} gas`, time: '20 min' },
    { text: `Vote on a live governance proposal so the position is active, and re-check the stake and any rewards weekly.`, cost: `~${g} gas per vote`, time: '10 min a week' },
    { text: `Claim accrued rewards only from ${p.name}'s published page, and log every transaction so you can unwind the position cleanly.`, cost: 'no fee to check; never pay to claim', time: '10 min' },
  ];
  return steps.map(stepText);
}

// ---------------------------------------------------------------- board assembly

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, anchor: MarketAnchor, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, always.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the floor, by TVL then slug.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, anchor, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      sector_multiple: s.v.sector.multiple,
      sector_peers: s.v.sector.peers,
      sector_fallback: s.v.sector.fallback,
      base_usd: Math.round(s.v.base),
      growth_pct: round4(s.v.growthPct),
      momentum: round4(s.v.momentum),
      seasoning: round4(s.v.seasoning),
      breadth: round4(s.v.breadth),
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The already-trading protocols, by market cap, for the dashboard's separate live view. */
export function liveRows(snapshot: Snapshot, limit = 60): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      symbol: p.symbol,
      mcap_tvl: p.tvl_usd > 0 && p.mcap_usd !== null ? round4(p.mcap_usd / p.tvl_usd) : null,
      farm_steps: liveFarmSteps(p),
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const anchor = marketAnchor(snapshot, model);
  const board = buildBoard(snapshot, anchor, model);
  const live = liveRows(snapshot);
  const wl = new Set(snapshot.watchlist);
  const early = board.filter((r) => !wl.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    anchor,
    watchlist: snapshot.watchlist,
    stats: { protocols: snapshot.protocols.length, watchlist: snapshot.watchlist.length, board: board.length, early, live: live.length },
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. Mirrors the scorer's board rules. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MODEL.value_cap) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} trimmed characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
