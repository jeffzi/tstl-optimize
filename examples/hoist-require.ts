// biome-ignore lint/suspicious/noExplicitAny: Lua require() returns untyped modules
declare function require(path: string): any;

// @inline helper wrapping a Lua-native library call.
// After inlining, each call site materializes `require("bit").band(...)`;
// hoist-require deduplicates the repeated `require("bit").band` chain into
// a single `local ____req_bit_band = require("bit").band`.

/** @inline */
// biome-ignore lint/suspicious/noExplicitAny: Lua module cast
const band = (a: number, b: number): number => (require("bit") as any).band(a, b);

const flags = 0xff0f;
const mask = 0x00ff;

const low = band(flags, mask);
const high = band(flags, 0xf000);

print(low, high);

// --- Limitations ---

// Not hoisted: only one call site — the threshold is 2+ occurrences.
/** @inline */
// biome-ignore lint/suspicious/noExplicitAny: Lua module cast
const bor = (a: number, b: number): number => (require("bit") as any).bor(a, b);

const combined = bor(flags, mask);
print(combined);
