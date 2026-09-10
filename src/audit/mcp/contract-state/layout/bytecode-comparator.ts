/**
 * Compare on-chain bytecode against locally-compiled bytecode.
 *
 * We can't expect byte-equality because:
 *   - solc embeds the metadata hash (CBOR-encoded) in the last bytes
 *   - immutable values are written into the deployed bytecode at deploy time
 *   - library addresses are linked at deploy time
 *
 * Strategy: strip the trailing metadata hash and immutable regions, then
 * compare the remaining "code hash". This gives us a confidence signal:
 *
 *   - exact              : full match (rare; only without metadata)
 *   - metadata-difference: code matches but metadata hash differs
 *   - partial-match      : substantial overlap but not exact
 *   - unverified         : very different, probably wrong source/version
 */

import type { BytecodeComparison, LayoutConfidence } from "../storage/types";

const METADATA_HASH_LENGTHS = new Set([33, 43, 53, 63, 73]); // common CBOR tail lengths

/** Strip trailing zeros and metadata hash from deployed bytecode. */
function stripMetadata(bytecode: `0x${string}`): string {
  const hex = bytecode.slice(2).toLowerCase();
  if (hex.length < 4) return "";
  const lastTwoBytes = parseInt(hex.slice(-4), 16); // not quite right; metadata length is at the very end
  // Actually solc encodes the last 2 bytes as the metadata length. Read them:
  const metaLenBytes = lastTwoBytes;
  let stripped = hex;
  if (
    metaLenBytes > 0 &&
    metaLenBytes * 2 < hex.length &&
    METADATA_HASH_LENGTHS.has(metaLenBytes)
  ) {
    stripped = hex.slice(0, -(metaLenBytes * 2 + 4));
  } else {
    // Strip just the length+magic tail (2 bytes for length)
    stripped = hex.slice(0, -4);
  }
  // Trim trailing zeros (immutable/literal tail) up to 32 bytes max.
  return stripped.replace(/0+$/, "");
}

/** Naive similarity ratio (0..1) using a rolling byte-set comparison. */
function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  // Use a sliding window of 64 hex chars (32 bytes) and count shared windows.
  const windows = new Set<string>();
  const winA = new Set<string>();
  for (let i = 0; i + 64 <= a.length; i += 32) winA.add(a.slice(i, i + 64));
  for (let i = 0; i + 64 <= b.length; i += 32) windows.add(b.slice(i, i + 64));
  let shared = 0;
  for (const w of winA) if (windows.has(w)) shared++;
  return winA.size === 0 ? 0 : shared / winA.size;
}

export function compareBytecode(
  onChain: `0x${string}`,
  compiled: `0x${string}`,
): BytecodeComparison {
  const onChainLen = onChain === "0x" ? 0 : (onChain.length - 2) / 2;
  const compiledLen = compiled === "0x" ? 0 : (compiled.length - 2) / 2;
  const reasons: string[] = [];

  if (onChainLen === 0) {
    return {
      confidence: "unverified",
      onChainLength: 0,
      compiledLength: compiledLen,
      reasons: ["no on-chain bytecode"],
    };
  }

  const a = stripMetadata(onChain);
  const b = stripMetadata(compiled);

  if (a === b) {
    return {
      confidence: "exact",
      onChainLength: onChainLen,
      compiledLength: compiledLen,
      reasons: [],
    };
  }

  const sim = similarity(a, b);
  let confidence: LayoutConfidence;
  if (sim >= 0.99) {
    confidence = "metadata-difference";
  } else if (sim >= 0.6) {
    confidence = "partial-match";
    reasons.push(
      `bytecode similarity ${sim.toFixed(2)} (likely immutable/library differences)`,
    );
  } else {
    confidence = "unverified";
    reasons.push(
      `bytecode similarity ${sim.toFixed(2)} (source/version mismatch likely)`,
    );
  }

  // Length delta is also informative.
  const lenDelta = Math.abs(onChainLen - compiledLen);
  if (lenDelta > 64 && confidence === "metadata-difference") {
    confidence = "partial-match";
    reasons.push(`bytecode length delta ${lenDelta} bytes`);
  }

  return {
    confidence,
    onChainLength: onChainLen,
    compiledLength: compiledLen,
    reasons,
  };
}
