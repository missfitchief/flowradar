// FlowRadar — mulberry32 PRNG (no external libs; deterministic mock-world
// content per Task 4 brief: "mulberry32 PRNG, seed 20260705").
//
// mulberry32 is a small, fast, well-known 32-bit PRNG. Reference algorithm:
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
// (public-domain one-liner attributed to Tommy Ettinger); reimplemented here
// from the published algorithm description, not copy-pasted from a library.

/** A deterministic PRNG returning floats in [0, 1). */
export type Rng = () => number;

/**
 * Creates a mulberry32 generator from a 32-bit unsigned seed. Same seed
 * always produces the same sequence.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive, drawn from `rng`. */
export function rngInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Float in [min, max), drawn from `rng`. */
export function rngFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

/** Picks one element from `arr`, drawn from `rng`. Throws on an empty array. */
export function rngPick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error('rngPick: cannot pick from an empty array');
  }
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * Fisher-Yates shuffle of a copy of `arr`, using `rng`. Does not mutate the
 * input array.
 */
export function rngShuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Mixes a seed number and a millisecond timestamp into a single 32-bit
 * unsigned integer, for deriving independent-but-deterministic sub-seeds
 * (e.g. one seed for wallet generation, another for token generation) from
 * one (seed, genesis) pair without correlating their sequences.
 */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ salt, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}
