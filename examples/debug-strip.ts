// Note: every print/assert/debug.* call in this file is stripped, so
// running the output produces no visible output. Inspect the generated
// .lua to see what survives.
declare const hp: number;
declare const name: string;
declare function assert(value: unknown, ...messages: unknown[]): void;
declare const debug: { traceback(this: void): string };

// Statement-position calls to configured functions — stripped
print("player health:", hp);
print(name, hp);
assert(hp > 0);

// Namespace calls — stripped (debug.* by default)
debug.traceback();

// Not stripped: return value is assigned to a variable — removing the call
// would leave traceback uninitialized.
// Note: debug.traceback is called twice below, so localizer hoists it as a local in the output
const traceback = debug.traceback();

// Not stripped: return value feeds a return statement — the caller depends
// on the result
function getInfo(): string {
  return debug.traceback();
}

print(traceback);
print(getInfo());
