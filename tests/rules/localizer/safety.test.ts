// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import {
  hasCallExpression,
  hasEarlyExit,
  hasInterveningCallForChain,
  isNonStdlibCall,
  statementAssignsToChain,
  statementHasUnsafeCallAfterFirstChainAccess,
  statementHasUnsafeCallBeforeFirstChainAccess,
  statementTouchesChain,
} from "../../../src/rules/localizer/safety";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function id(name: string): tstl.Identifier {
  return tstl.createIdentifier(name);
}

function num(value: number): tstl.NumericLiteral {
  return tstl.createNumericLiteral(value);
}

/**
 * Build a dotted TableIndexExpression using StringLiteral keys so that
 * luaPropertyChain() can reconstruct the "a.b.c" string from the node.
 */
function chain(...parts: string[]): tstl.TableIndexExpression {
  // biome-ignore lint/style/noNonNullAssertion: variadic args, caller always passes ≥1 string
  let expr: tstl.Expression = id(parts[0]!);
  for (let i = 1; i < parts.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounds guarantee valid index
    expr = tstl.createTableIndexExpression(expr, tstl.createStringLiteral(parts[i]!));
  }
  return expr as tstl.TableIndexExpression;
}

function exprStmt(expr: tstl.Expression): tstl.ExpressionStatement {
  return tstl.createExpressionStatement(expr);
}

function callStmt(callee: tstl.Expression, ...args: tstl.Expression[]): tstl.ExpressionStatement {
  return exprStmt(tstl.createCallExpression(callee, args));
}

function methodCallStmt(
  obj: tstl.Expression,
  method: string,
  ...args: tstl.Expression[]
): tstl.ExpressionStatement {
  return exprStmt(tstl.createMethodCallExpression(obj, id(method), args));
}

// ---------------------------------------------------------------------------
// isNonStdlibCall
// ---------------------------------------------------------------------------

describe("isNonStdlibCall", () => {
  it("returns false for stdlib table index (math.ceil)", () => {
    expect(isNonStdlibCall(chain("math", "ceil"))).toBe(false);
  });

  it("returns true for non-stdlib table index (obj.method)", () => {
    expect(isNonStdlibCall(chain("obj", "method"))).toBe(true);
  });

  it("returns false for stdlib identifier (math)", () => {
    expect(isNonStdlibCall(id("math"))).toBe(false);
  });

  it("returns true for non-stdlib identifier (myFunc)", () => {
    expect(isNonStdlibCall(id("myFunc"))).toBe(true);
  });

  it("returns true for complex callee (nested table index, not flat identifier)", () => {
    // a.b.c is a table index whose .table is itself a table index — not a plain identifier
    const complex = chain("a", "b", "c");
    expect(isNonStdlibCall(complex)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasCallExpression
// ---------------------------------------------------------------------------

describe("hasCallExpression", () => {
  it("returns false for empty statements", () => {
    expect(hasCallExpression([])).toBe(false);
  });

  it("returns true when a call expression is present", () => {
    expect(hasCallExpression([callStmt(id("foo"))])).toBe(true);
  });

  it("returns true for method call expression", () => {
    expect(hasCallExpression([methodCallStmt(id("obj"), "method")])).toBe(true);
  });

  it("returns false for assignment with no calls", () => {
    const stmt = tstl.createAssignmentStatement([id("x")], [num(1)]);
    expect(hasCallExpression([stmt])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statementTouchesChain
// ---------------------------------------------------------------------------

describe("statementTouchesChain", () => {
  it("returns true when statement contains the exact chain", () => {
    const stmt = exprStmt(chain("math", "floor"));
    expect(statementTouchesChain(stmt, "math.floor", false)).toBe(true);
  });

  it("returns false when statement does not contain the chain", () => {
    const stmt = exprStmt(id("x"));
    expect(statementTouchesChain(stmt, "math.floor", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statementHasUnsafeCallBeforeFirstChainAccess
// ---------------------------------------------------------------------------

describe("statementHasUnsafeCallBeforeFirstChainAccess", () => {
  it("returns false with no call at all", () => {
    const stmt = exprStmt(chain("a", "b"));
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("returns true when unsafe call precedes chain access", () => {
    // DoStatement: { foo(); a.b }
    const stmt = tstl.createDoStatement([callStmt(id("foo")), exprStmt(chain("a", "b"))]);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("DoStatement: returns false when chain appears before call", () => {
    const stmt = tstl.createDoStatement([exprStmt(chain("a", "b")), callStmt(id("foo"))]);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("WhileStatement: detects unsafe call before chain in body", () => {
    const stmt = tstl.createWhileStatement(
      tstl.createBlock([callStmt(id("unsafe")), exprStmt(chain("a", "b"))]),
      tstl.createBooleanLiteral(true),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("RepeatStatement: detects unsafe call before chain in body", () => {
    const stmt = tstl.createRepeatStatement(
      tstl.createBlock([callStmt(id("unsafe")), exprStmt(chain("a", "b"))]),
      tstl.createBooleanLiteral(false),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("ForStatement without stepExpression: detects chain in body", () => {
    const stmt = tstl.createForStatement(
      tstl.createBlock([exprStmt(chain("a", "b"))]),
      id("i"),
      num(1),
      num(10),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ForStatement with stepExpression: handles step before body", () => {
    // step = chain access, body is empty — no unsafe call
    const stmt = tstl.createForStatement(
      tstl.createBlock([exprStmt(chain("a", "b"))]),
      id("i"),
      num(1),
      num(10),
      num(1),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ForInStatement: detects chain access", () => {
    const stmt = tstl.createForInStatement(
      tstl.createBlock([exprStmt(chain("a", "b"))]),
      [id("v")],
      [id("t")],
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ReturnStatement: detects unsafe call before chain in return expressions", () => {
    // return with a binary: unsafe() + a.b  — call comes before chain access
    const call = tstl.createCallExpression(id("unsafe"), []);
    const chainExpr = chain("a", "b");
    const binExpr = tstl.createBinaryExpression(call, chainExpr, tstl.SyntaxKind.AdditionOperator);
    const stmt = tstl.createReturnStatement([binExpr]);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("ExpressionStatement with TableExpression: visits field keys and values", () => {
    // { key = a.b } — chain access in a table field value
    const tableExpr = tstl.createTableExpression([
      tstl.createTableFieldExpression(chain("a", "b"), id("key")),
    ]);
    const stmt = exprStmt(tableExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ExpressionStatement with TableExpression field with no key visits value", () => {
    // { a.b } — table field without key
    const tableExpr = tstl.createTableExpression([
      tstl.createTableFieldExpression(chain("a", "b")),
    ]);
    const stmt = exprStmt(tableExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ParenthesizedExpression: visits inner expression", () => {
    const parenExpr = tstl.createParenthesizedExpression(chain("a", "b"));
    const stmt = exprStmt(parenExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("ConditionalExpression: visits condition/whenTrue/whenFalse", () => {
    // cond ? a.b : 0
    const condExpr = tstl.createConditionalExpression(
      tstl.createBooleanLiteral(true),
      chain("a", "b"),
      num(0),
    );
    const stmt = exprStmt(condExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("FunctionExpression: skips body when shallow=true", () => {
    // function() unsafe(); a.b end — shallow, so body is skipped, no detection
    const funcExpr = tstl.createFunctionExpression(
      tstl.createBlock([callStmt(id("unsafe")), exprStmt(chain("a", "b"))]),
    );
    const stmt = exprStmt(funcExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", true)).toBe(false);
  });

  it("MethodCallExpression: treated as always unsafe", () => {
    // obj:method() before a.b
    const expr = tstl.createBinaryExpression(
      tstl.createMethodCallExpression(id("obj"), id("method"), []),
      chain("a", "b"),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt = exprStmt(expr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("stdlib call before chain is NOT unsafe (safe call)", () => {
    // math.floor() before a.b — stdlib call, should be safe
    const mathCall = tstl.createCallExpression(chain("math", "floor"), [num(1)]);
    const expr = tstl.createBinaryExpression(
      mathCall,
      chain("a", "b"),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt = exprStmt(expr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("VariableDeclarationStatement: inspects RHS for chain access", () => {
    const decl = tstl.createVariableDeclarationStatement(id("x"), chain("a", "b"));
    expect(statementHasUnsafeCallBeforeFirstChainAccess(decl, "a.b", false)).toBe(false);
  });

  it("AssignmentStatement: inspects RHS for chain access", () => {
    const stmt = tstl.createAssignmentStatement([id("x")], [chain("a", "b")]);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("IfStatement: detects unsafe call in condition before chain in body", () => {
    const ifStmt = tstl.createIfStatement(
      tstl.createCallExpression(id("unsafe"), []),
      tstl.createBlock([exprStmt(chain("a", "b"))]),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(ifStmt, "a.b", false)).toBe(true);
  });

  it("IfStatement with elseBlock: visits else branch", () => {
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([]),
      tstl.createBlock([exprStmt(chain("a", "b"))]),
    );
    expect(statementHasUnsafeCallBeforeFirstChainAccess(ifStmt, "a.b", false)).toBe(false);
  });

  it("UnaryExpression: visits operand (call in operand precedes chain read)", () => {
    // return -foo(), a.b  — call in unary operand marks unsafe; then chain read triggers flag.
    const unary = tstl.createUnaryExpression(
      tstl.createCallExpression(id("foo"), []),
      tstl.SyntaxKind.NegationOperator,
    );
    const stmt = tstl.createReturnStatement([unary, chain("a", "b")]);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(true);
  });

  it("VariableDeclarationStatement with no right: handles undefined RHS", () => {
    // local x   (no initializer)
    const stmt = tstl.createVariableDeclarationStatement(id("x"));
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("non-matching chain access does not arm sawFirstChainAccess", () => {
    // a.b read target; stmt reads other.c — no match → false
    const stmt = exprStmt(chain("other", "c"));
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
  });

  it("FunctionExpression body is always skipped — closures execute later, not inline", () => {
    // Chain access inside a nested function body must not count: the closure runs later,
    // so it cannot influence the current statement's evaluation.
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([exprStmt(chain("a", "b"))]));
    const stmt = tstl.createVariableDeclarationStatement(id("f"), funcExpr);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", false)).toBe(false);
    expect(statementHasUnsafeCallBeforeFirstChainAccess(stmt, "a.b", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statementHasUnsafeCallAfterFirstChainAccess
// ---------------------------------------------------------------------------

describe("statementHasUnsafeCallAfterFirstChainAccess", () => {
  it("returns both flags false when only call present (no chain access)", () => {
    const stmt = callStmt(id("foo"));
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("returns both flags false when only chain access present (no calls)", () => {
    const stmt = exprStmt(chain("a", "b"));
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("returns both false when call precedes chain access (pre-order)", () => {
    // foo() + a.b — call before chain
    const expr = tstl.createBinaryExpression(
      tstl.createCallExpression(id("foo"), []),
      chain("a", "b"),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt = exprStmt(expr);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("returns afterFirst=true, betweenAccesses=false when chain then call (one statement)", () => {
    // DoStatement: { a.b; foo() } — read then call
    const stmt = tstl.createDoStatement([exprStmt(chain("a", "b")), callStmt(id("foo"))]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: false });
  });

  it("returns both true when read-call-read in sequence (same statement)", () => {
    // DoStatement: { a.b; foo(); a.b }
    const stmt = tstl.createDoStatement([
      exprStmt(chain("a", "b")),
      callStmt(id("foo")),
      exprStmt(chain("a", "b")),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("returns both false when stdlib call (math.floor) appears after chain", () => {
    // a.b; math.floor(1); a.b — stdlib call is safe
    const stmt = tstl.createDoStatement([
      exprStmt(chain("a", "b")),
      callStmt(chain("math", "floor"), num(1)),
      exprStmt(chain("a", "b")),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("returns afterFirst=true when chain in args, call marked after (core bug case)", () => {
    // foo(a.b) — chain visited during arg traversal, call marked after
    const callExpr = tstl.createCallExpression(id("foo"), [chain("a", "b")]);
    const stmt = exprStmt(callExpr);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: false });
  });

  it("returns both false when chain buried inside FunctionExpression body", () => {
    // function() a.b; foo(); a.b end — function body is skipped
    const funcExpr = tstl.createFunctionExpression(
      tstl.createBlock([exprStmt(chain("a", "b")), callStmt(id("foo")), exprStmt(chain("a", "b"))]),
    );
    const stmt = exprStmt(funcExpr);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("returns afterFirst=true for method call after chain", () => {
    // a.b; obj:method(); a.b — method calls are always unsafe
    const stmt = tstl.createDoStatement([
      exprStmt(chain("a", "b")),
      methodCallStmt(id("obj"), "method"),
      exprStmt(chain("a", "b")),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("returns both false when stdlib call appears after chain (to verify non-stdlib filtering)", () => {
    // string.len is stdlib, so it should NOT arm afterFirst
    const stmt = tstl.createDoStatement([
      exprStmt(chain("a", "b")),
      exprStmt(tstl.createCallExpression(chain("string", "len"), [num(1)])),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it.each([
    {
      name: "DoStatement",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createDoStatement([exprStmt(read), exprStmt(call), exprStmt(read2)]),
    },
    {
      name: "IfStatement ifBlock",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createIfStatement(
          tstl.createBooleanLiteral(true),
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
        ),
    },
    {
      name: "IfStatement elseBlock",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createIfStatement(
          tstl.createBooleanLiteral(true),
          tstl.createBlock([]),
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
        ),
    },
    {
      name: "WhileStatement",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createWhileStatement(
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
          tstl.createBooleanLiteral(true),
        ),
    },
    {
      name: "RepeatStatement",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createRepeatStatement(
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
          tstl.createBooleanLiteral(false),
        ),
    },
    {
      name: "ForStatement",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createForStatement(
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
          id("i"),
          num(1),
          num(10),
        ),
    },
    {
      name: "ForInStatement",
      createStmt: (read: tstl.Expression, call: tstl.Expression, read2: tstl.Expression) =>
        tstl.createForInStatement(
          tstl.createBlock([exprStmt(read), exprStmt(call), exprStmt(read2)]),
          [id("v")],
          [id("t")],
        ),
    },
  ])("wrapper coverage via $name: returns betweenAccesses=true for read-call-read pattern", ({
    createStmt,
  }) => {
    const stmt = createStmt(
      chain("a", "b"),
      tstl.createCallExpression(id("unsafe"), []),
      chain("a", "b"),
    );
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("UnaryExpression: visits operand (chain inside unary)", () => {
    // return -a.b  → chain access seen, no call → both false
    const stmt = tstl.createReturnStatement([
      tstl.createUnaryExpression(chain("a", "b"), tstl.SyntaxKind.NegationOperator),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("ParenthesizedExpression: visits inner expression", () => {
    // return (a.b); foo(); a.b  →  both true
    const paren = tstl.createParenthesizedExpression(chain("a", "b"));
    const stmt = tstl.createDoStatement([
      exprStmt(paren),
      callStmt(id("foo")),
      exprStmt(chain("a", "b")),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("ConditionalExpression: visits condition, whenTrue, whenFalse", () => {
    // (a.b) ? foo() : a.b  →  read then call then read
    const cond = tstl.createConditionalExpression(
      chain("a", "b"),
      tstl.createCallExpression(id("foo"), []),
      chain("a", "b"),
    );
    const stmt = tstl.createReturnStatement([cond]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("VariableDeclarationStatement with no right: handles undefined RHS", () => {
    const stmt = tstl.createVariableDeclarationStatement(id("x"));
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("AssignmentStatement: inspects RHS for chain access", () => {
    // x = a.b; (a.b only on RHS)
    const stmt = tstl.createAssignmentStatement([id("x")], [chain("a", "b")]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("MethodCallExpression before first chain access: flags unchanged", () => {
    // obj:m(); a.b  → sawFirstChainAccess=false at call → no arming
    const stmt = tstl.createDoStatement([
      methodCallStmt(id("obj"), "m"),
      exprStmt(chain("a", "b")),
    ]);
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: false, betweenAccesses: false });
  });

  it("ForStatement with stepExpression: visits step before body", () => {
    // for i = 1, 10, 2 do a.b; foo(); a.b end
    const stmt = tstl.createForStatement(
      tstl.createBlock([exprStmt(chain("a", "b")), callStmt(id("foo")), exprStmt(chain("a", "b"))]),
      id("i"),
      num(1),
      num(10),
      num(2),
    );
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: true });
  });

  it("ExpressionStatement at top level: visits its expression", () => {
    // Direct ExpressionStatement passed as the top-level statement
    const stmt = exprStmt(
      tstl.createBinaryExpression(
        chain("a", "b"),
        tstl.createCallExpression(id("foo"), []),
        tstl.SyntaxKind.AdditionOperator,
      ),
    );
    const result = statementHasUnsafeCallAfterFirstChainAccess(stmt, "a.b");
    expect(result).toStrictEqual({ afterFirst: true, betweenAccesses: false });
  });
});

// ---------------------------------------------------------------------------
// hasInterveningCallForChain
// ---------------------------------------------------------------------------

describe("hasInterveningCallForChain", () => {
  it("returns false for stdlib root (no intervening call check needed)", () => {
    const stmts = [
      callStmt(id("foo")),
      exprStmt(chain("math", "floor")),
      exprStmt(chain("math", "floor")),
    ];
    expect(hasInterveningCallForChain(stmts, "math.floor", true)).toBe(false);
  });

  it("returns false when no chain is touched by any statement (early exit)", () => {
    const stmts = [callStmt(id("foo")), exprStmt(id("x"))];
    expect(hasInterveningCallForChain(stmts, "a.b", true)).toBe(false);
  });

  it("returns false when chain appears only once (no span to interleave)", () => {
    const stmts = [exprStmt(chain("a", "b"))];
    expect(hasInterveningCallForChain(stmts, "a.b", true)).toBe(false);
  });

  it("returns true when non-stdlib call appears between two chain accesses", () => {
    const stmts = [exprStmt(chain("a", "b")), callStmt(id("unsafeFn")), exprStmt(chain("a", "b"))];
    expect(hasInterveningCallForChain(stmts, "a.b", true)).toBe(true);
  });

  it("returns true when non-stdlib call before first access (pre-access guard)", () => {
    const stmts = [callStmt(id("unsafe")), exprStmt(chain("a", "b")), exprStmt(chain("a", "b"))];
    expect(hasInterveningCallForChain(stmts, "a.b", true)).toBe(true);
  });

  it("returns true when single statement has call between two chain accesses", () => {
    // a.b + unsafe() + a.b — intervening call within one statement
    const expr = tstl.createBinaryExpression(
      tstl.createBinaryExpression(
        chain("a", "b"),
        tstl.createCallExpression(id("unsafe"), []),
        tstl.SyntaxKind.AdditionOperator,
      ),
      chain("a", "b"),
      tstl.SyntaxKind.AdditionOperator,
    );
    expect(hasInterveningCallForChain([exprStmt(expr)], "a.b", true)).toBe(true);
  });

  it("returns false when chain in two statements with no intervening call", () => {
    const stmts = [exprStmt(chain("a", "b")), exprStmt(chain("a", "b"))];
    expect(hasInterveningCallForChain(stmts, "a.b", true)).toBe(false);
  });

  it("returns true when first-access statement writes the chain, later read follows", () => {
    // stmt0: self.i = self.i + 1  (read on RHS, write on LHS — same chain)
    // stmt1: return { value: 2 ^ self.i } (read only)
    // Expected: true because the write in stmt0 makes subsequent reads unsafe
    const chainRef = chain("self", "i");
    const readAndAdd = tstl.createBinaryExpression(
      chainRef,
      num(1),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt0 = tstl.createAssignmentStatement([chainRef], [readAndAdd]);
    const stmt1 = tstl.createReturnStatement([
      tstl.createTableExpression([
        tstl.createTableFieldExpression(
          tstl.createBinaryExpression(num(2), chain("self", "i"), tstl.SyntaxKind.PowerOperator),
          tstl.createStringLiteral("value"),
        ),
      ]),
    ]);
    expect(hasInterveningCallForChain([stmt0, stmt1], "self.i", false)).toBe(true);
  });

  it("returns false when write is at the last-access position (no later reads)", () => {
    // stmt0: x = self.i (read only)
    // stmt1: self.i = self.i + 1 (read+write, but LAST access — no later reads)
    // Expected: false because there are no reads after the write
    const chainRef = chain("self", "i");
    const readAndAdd = tstl.createBinaryExpression(
      chainRef,
      num(1),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt0 = tstl.createAssignmentStatement([id("x")], [chainRef]);
    const stmt1 = tstl.createAssignmentStatement([chainRef], [readAndAdd]);
    expect(hasInterveningCallForChain([stmt0, stmt1], "self.i", false)).toBe(false);
  });

  it("returns false when pure reads only (regression guard)", () => {
    const stmt0 = tstl.createAssignmentStatement([id("x")], [chain("self", "i")]);
    const stmt1 = tstl.createAssignmentStatement([id("y")], [chain("self", "i")]);
    expect(hasInterveningCallForChain([stmt0, stmt1], "self.i", false)).toBe(false);
  });

  it("returns true for: return this.bump(this.i) + this.i (call with chain in args, then later read)", () => {
    // Modeled as: ReturnStatement([BinaryExpression(CallExpression(chain("self","bump"), [chain("self","i")]), chain("self","i"), AdditionOperator)])
    const callWithChainArg = tstl.createCallExpression(chain("self", "bump"), [chain("self", "i")]);
    const binExpr = tstl.createBinaryExpression(
      callWithChainArg,
      chain("self", "i"),
      tstl.SyntaxKind.AdditionOperator,
    );
    const stmt = tstl.createReturnStatement([binExpr]);
    expect(hasInterveningCallForChain([stmt], "self.i", false)).toBe(true);
  });

  it("returns true for: return { x: this.bump(this.i), y: this.i } (table with call and read)", () => {
    // ReturnStatement([TableExpression([field(x: CallExpression(chain("self","bump"), [chain("self","i")])), field(y: chain("self","i"))])])
    const callWithChainArg = tstl.createCallExpression(chain("self", "bump"), [chain("self", "i")]);
    const tableExpr = tstl.createTableExpression([
      tstl.createTableFieldExpression(callWithChainArg, tstl.createStringLiteral("x")),
      tstl.createTableFieldExpression(chain("self", "i"), tstl.createStringLiteral("y")),
    ]);
    const stmt = tstl.createReturnStatement([tableExpr]);
    expect(hasInterveningCallForChain([stmt], "self.i", false)).toBe(true);
  });

  it("returns true for: const x = this.bump(this.i); return [x, this.i] (multi-statement with call then read)", () => {
    // First statement: VariableDeclarationStatement(id("x"), CallExpression(chain("self","bump"), [chain("self","i")]))
    // Second statement: ReturnStatement([TableExpression([field(chain("self","i"))])])
    const callWithChainArg = tstl.createCallExpression(chain("self", "bump"), [chain("self", "i")]);
    const stmt0 = tstl.createVariableDeclarationStatement(id("x"), callWithChainArg);
    const tableExpr = tstl.createTableExpression([
      tstl.createTableFieldExpression(chain("self", "i")),
    ]);
    const stmt1 = tstl.createReturnStatement([tableExpr]);
    expect(hasInterveningCallForChain([stmt0, stmt1], "self.i", false)).toBe(true);
  });

  it("returns false for: const x = string.len(this.i); return [x, this.i] (stdlib call is safe)", () => {
    // First statement with stdlib call
    const stdlibCall = tstl.createCallExpression(chain("string", "len"), [chain("self", "i")]);
    const stmt0 = tstl.createVariableDeclarationStatement(id("x"), stdlibCall);
    const tableExpr = tstl.createTableExpression([
      tstl.createTableFieldExpression(chain("self", "i")),
    ]);
    const stmt1 = tstl.createReturnStatement([tableExpr]);
    expect(hasInterveningCallForChain([stmt0, stmt1], "self.i", false)).toBe(false);
  });

  it("returns true when a method call precedes the first chain access", () => {
    // obj:m(); return self.i; return self.i
    // hasNonStdlibCall finds the method call before first access → unsafe
    const stmt0 = methodCallStmt(id("obj"), "m");
    const stmt1 = tstl.createReturnStatement([chain("self", "i")]);
    const stmt2 = tstl.createReturnStatement([chain("self", "i")]);
    expect(hasInterveningCallForChain([stmt0, stmt1, stmt2], "self.i", false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasEarlyExit
// ---------------------------------------------------------------------------

describe("hasEarlyExit", () => {
  it("returns false for empty body", () => {
    expect(hasEarlyExit([])).toBe(false);
  });

  it("returns true for return statement", () => {
    expect(hasEarlyExit([tstl.createReturnStatement([])])).toBe(true);
  });

  it("returns true for goto statement", () => {
    expect(hasEarlyExit([tstl.createGotoStatement("label")])).toBe(true);
  });

  it("returns true for break statement at top level", () => {
    expect(hasEarlyExit([tstl.createBreakStatement()])).toBe(true);
  });

  it("returns false when no exits present", () => {
    const stmts = [exprStmt(id("x")), tstl.createAssignmentStatement([id("x")], [num(1)])];
    expect(hasEarlyExit(stmts)).toBe(false);
  });

  it("returns true for return nested inside if-block", () => {
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([tstl.createReturnStatement([])]),
    );
    expect(hasEarlyExit([ifStmt])).toBe(true);
  });

  it("returns true for return nested inside else-block", () => {
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([]),
      tstl.createBlock([tstl.createReturnStatement([])]),
    );
    expect(hasEarlyExit([ifStmt])).toBe(true);
  });

  it("returns true for return nested inside DoStatement", () => {
    const doStmt = tstl.createDoStatement([tstl.createReturnStatement([])]);
    expect(hasEarlyExit([doStmt])).toBe(true);
  });

  it("returns true for return inside a nested loop body", () => {
    // Break inside a nested while is scoped to the inner loop, but return propagates
    const inner = tstl.createWhileStatement(
      tstl.createBlock([tstl.createReturnStatement([])]),
      tstl.createBooleanLiteral(true),
    );
    expect(hasEarlyExit([inner])).toBe(true);
  });

  it("break inside nested loop does NOT propagate as early exit for outer scope", () => {
    // break inside inner loop is scoped to that loop — hasScopeExit(inner.body, false)
    // so the outer hasEarlyExit should not see it as an exit
    const inner = tstl.createWhileStatement(
      tstl.createBlock([tstl.createBreakStatement()]),
      tstl.createBooleanLiteral(true),
    );
    expect(hasEarlyExit([inner])).toBe(false);
  });

  it("returns true for return inside a for-loop body", () => {
    const forStmt = tstl.createForStatement(
      tstl.createBlock([tstl.createReturnStatement([])]),
      id("i"),
      num(1),
      num(10),
    );
    expect(hasEarlyExit([forStmt])).toBe(true);
  });

  it("returns true for return inside a for-in body", () => {
    const forInStmt = tstl.createForInStatement(
      tstl.createBlock([tstl.createReturnStatement([])]),
      [id("v")],
      [id("t")],
    );
    expect(hasEarlyExit([forInStmt])).toBe(true);
  });

  it("returns true for return inside a repeat body", () => {
    const repeatStmt = tstl.createRepeatStatement(
      tstl.createBlock([tstl.createReturnStatement([])]),
      tstl.createBooleanLiteral(false),
    );
    expect(hasEarlyExit([repeatStmt])).toBe(true);
  });

  it("returns false for if-else block where neither branch exits", () => {
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([exprStmt(id("x"))]),
      tstl.createBlock([exprStmt(id("y"))]),
    );
    expect(hasEarlyExit([ifStmt])).toBe(false);
  });

  it("returns false for do block without exit", () => {
    const doStmt = tstl.createDoStatement([exprStmt(id("x"))]);
    expect(hasEarlyExit([doStmt])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// statementAssignsToChain
// ---------------------------------------------------------------------------

describe("statementAssignsToChain", () => {
  it("returns false for a statement that doesn't mention the chain at all", () => {
    const stmt = exprStmt(id("unrelated"));
    expect(statementAssignsToChain(stmt, "a.b")).toBe(false);
  });

  it("returns true for a top-level AssignmentStatement whose LHS is the chain", () => {
    // self.i = 1
    const stmt = tstl.createAssignmentStatement([chain("self", "i")], [num(1)]);
    expect(statementAssignsToChain(stmt, "self.i")).toBe(true);
  });

  it("returns true for a top-level AssignmentStatement whose LHS is the chain root identifier", () => {
    // self = { i = 0 }
    const stmt = tstl.createAssignmentStatement(
      [id("self")],
      [
        tstl.createTableExpression([
          tstl.createTableFieldExpression(num(0), tstl.createStringLiteral("i")),
        ]),
      ],
    );
    expect(statementAssignsToChain(stmt, "self.i")).toBe(true);
  });

  it.each([
    {
      name: "DoStatement",
      createStmt: (assignStmt: tstl.AssignmentStatement) => tstl.createDoStatement([assignStmt]),
    },
    {
      name: "IfStatement if-branch",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createIfStatement(tstl.createBooleanLiteral(true), tstl.createBlock([assignStmt])),
    },
    {
      name: "IfStatement else-branch",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createIfStatement(
          tstl.createBooleanLiteral(true),
          tstl.createBlock([]),
          tstl.createBlock([assignStmt]),
        ),
    },
    {
      name: "WhileStatement",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createWhileStatement(tstl.createBlock([assignStmt]), tstl.createBooleanLiteral(true)),
    },
    {
      name: "RepeatStatement",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createRepeatStatement(
          tstl.createBlock([assignStmt]),
          tstl.createBooleanLiteral(false),
        ),
    },
    {
      name: "ForStatement",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createForStatement(tstl.createBlock([assignStmt]), id("i"), num(1), num(10)),
    },
    {
      name: "ForInStatement",
      createStmt: (assignStmt: tstl.AssignmentStatement) =>
        tstl.createForInStatement(tstl.createBlock([assignStmt]), [id("v")], [id("t")]),
    },
  ])("returns true when nested in $name containing assignment to chain", ({ createStmt }) => {
    const assignStmt = tstl.createAssignmentStatement([chain("a", "b")], [num(99)]);
    const stmt = createStmt(assignStmt);
    expect(statementAssignsToChain(stmt, "a.b")).toBe(true);
  });

  it("returns true for nested wrapper-in-wrapper (DoStatement containing IfStatement containing assignment)", () => {
    const assignStmt = tstl.createAssignmentStatement([chain("x", "y")], [num(42)]);
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([assignStmt]),
    );
    const doStmt = tstl.createDoStatement([ifStmt]);
    expect(statementAssignsToChain(doStmt, "x.y")).toBe(true);
  });

  it("returns false when assignment is inside a nested FunctionExpression body", () => {
    // local f = function() a.b = 1 end
    // The function body should be skipped because closures execute later
    const assignStmt = tstl.createAssignmentStatement([chain("a", "b")], [num(1)]);
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([assignStmt]));
    const varDecl = tstl.createVariableDeclarationStatement(id("f"), funcExpr);
    expect(statementAssignsToChain(varDecl, "a.b")).toBe(false);
  });

  it("returns true for assignment to chain prefix (root identifier) nested in DoStatement", () => {
    // do a = { b = 2 } end
    // assigning to root 'a', which is a prefix of "a.b"
    const assignStmt = tstl.createAssignmentStatement(
      [id("a")],
      [
        tstl.createTableExpression([
          tstl.createTableFieldExpression(num(2), tstl.createStringLiteral("b")),
        ]),
      ],
    );
    const doStmt = tstl.createDoStatement([assignStmt]);
    expect(statementAssignsToChain(doStmt, "a.b")).toBe(true);
  });

  it("returns false for IfStatement with ifBlock only and no matching write", () => {
    // Exercises the elseBlock-undefined branch — no elseBlock to descend into.
    const assignStmt = tstl.createAssignmentStatement([id("other")], [num(0)]);
    const ifStmt = tstl.createIfStatement(
      tstl.createBooleanLiteral(true),
      tstl.createBlock([assignStmt]),
    );
    expect(statementAssignsToChain(ifStmt, "a.b")).toBe(false);
  });

  it("returns false when LHS is a chain whose root differs from the target root", () => {
    // other.b = 1; target "a.b" — root mismatch, chain prefix mismatch → false
    const stmt = tstl.createAssignmentStatement([chain("other", "b")], [num(1)]);
    expect(statementAssignsToChain(stmt, "a.b")).toBe(false);
  });
});
