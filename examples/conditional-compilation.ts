// Constants resolved at compile time from env vars (see .opts.json).
// Defaults: DEBUG=false, PLATFORM="desktop", LOG_LEVEL=0
declare const DEBUG: boolean;
declare const PLATFORM: string;
declare const LOG_LEVEL: number;
declare const hp: number;
declare const baseSpeed: number;

// Boolean constant — falsy branch stripped entirely
if (DEBUG) {
  print("hp:", hp);
}
const playerHp = hp;

// === comparison in if/else — dead branch removed
declare function initWebRenderer(): void;
declare function initDesktopRenderer(): void;
if (PLATFORM === "web") {
  initWebRenderer();
} else {
  initDesktopRenderer();
}

// Else-if chain — only the matching branch survives
declare function setupWeb(): void;
declare function setupDesktop(): void;
declare function setupMobile(): void;
if (PLATFORM === "web") {
  setupWeb();
} else if (PLATFORM === "desktop") {
  setupDesktop();
} else {
  setupMobile();
}

// Ternary — folds to the surviving expression
const speed = DEBUG ? baseSpeed * 0.5 : baseSpeed;

// Nested ternary — evaluates the chain
const label = PLATFORM === "web" ? "Web" : PLATFORM === "desktop" ? "Desktop" : "Mobile";

// ! negation in condition
if (!DEBUG) {
  const safeHp = hp;
}

// && short-circuit — false && anything → stripped
if (DEBUG && LOG_LEVEL > 0) {
  print("verbose");
}

// || short-circuit — truthy left skips right evaluation
declare const VERBOSE: boolean;
if (PLATFORM === "desktop" || VERBOSE) {
  const x = hp + 1;
}

// !== comparison in if/else
if (PLATFORM !== "web") {
  const offline = true;
} else {
  const online = true;
}

// Parenthesized grouping
if (!(DEBUG && PLATFORM === "web")) {
  const ok = true;
}

// Switch — only the matching case survives
switch (PLATFORM) {
  case "web":
    setupWeb();
    break;
  case "desktop":
    setupDesktop();
    break;
  default:
    setupMobile();
    break;
}

// --- Limitations ---

// Conditions with runtime variables can't be resolved
declare const isAlive: boolean;
if (isAlive) {
  print("alive");
}

// Mixed known/unknown — unknown side prevents folding (emits a warning)
declare const connected: boolean;
if (PLATFORM === "desktop" && connected) {
  print("desktop + connected");
}

// Switch on runtime variable — can't resolve
declare const mode: number;
switch (mode) {
  case 1:
    print("one");
    break;
  default:
    print("other");
    break;
}

// Standalone expressions are also substituted
const isDebug = DEBUG;
const isWeb = PLATFORM === "web";

print(playerHp);
print(speed);
print(label);
print(isDebug);
print(isWeb);
