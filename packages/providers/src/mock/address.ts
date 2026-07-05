// FlowRadar — deterministic fake-address generators for the mock world.
//
// These are NOT real base58-encoded ed25519 public keys or checksummed EVM
// addresses — they only need to LOOK like the right shape (base58 alphabet,
// 32-44 chars for Solana; 0x + 40 hex chars for BSC) so downstream address
// classifiers/CSV validators exercise their format checks against
// realistic-looking strings. Generation is fully driven by the injected Rng.

import type { Rng } from './prng.js';
import { rngInt, rngPick } from './prng.js';

// Base58 alphabet (Bitcoin/Solana variant): excludes 0, O, I, l.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.split('');
const HEX_CHARS = '0123456789abcdef'.split('');

/** Deterministic base58-alphabet string, length in [32, 44], for a fake Solana address. */
export function fakeSolanaAddress(rng: Rng): string {
  const length = rngInt(rng, 32, 44);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += rngPick(rng, BASE58_ALPHABET);
  }
  return out;
}

/** Deterministic 0x-prefixed 40-hex-char string, for a fake BSC address. */
export function fakeBscAddress(rng: Rng): string {
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += rngPick(rng, HEX_CHARS);
  }
  return out;
}

/** Deterministic fake tx hash (64 hex chars, chain-agnostic shape). */
export function fakeTxHash(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 64; i++) {
    out += rngPick(rng, HEX_CHARS);
  }
  return out;
}
