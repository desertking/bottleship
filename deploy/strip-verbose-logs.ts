import ts from "typescript";

const CALLEES = new Set(["verbose", "verboseLazy"]);
const SIDE_EFFECTS = new Set([
    ts.SyntaxKind.PlusPlusToken,
    ts.SyntaxKind.MinusMinusToken,
]);

function isVerboseCall(node: ts.Node): node is ts.CallExpression {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    return ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === "Logger"
        && CALLEES.has(callee.name.text);
}

function hasSideEffects(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && SIDE_EFFECTS.has(n.operator)) {
            found = true;
            return;
        }
        if (ts.isBinaryExpression(n)
            && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            found = true;
            return;
        }
        if (ts.isDeleteExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n)) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

export interface StripResult {
    code: string;
    removed: number;
    kept: number;
}

export function stripVerboseLogs(code: string, fileName: string): StripResult | null {
    if (!code.includes("Logger.verbose")) return null;
    const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
    const edits: { start: number; end: number }[] = [];
    let kept = 0;
    const visit = (node: ts.Node): void => {
        if (isVerboseCall(node)) {
            if (node.arguments.some(hasSideEffects)) {
                kept++;
            }
            else {
                edits.push({ start: node.getStart(sf), end: node.getEnd() });
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    if (edits.length === 0) return null;
    let out = "";
    let at = 0;
    for (const e of edits) {
        out += code.slice(at, e.start) + "void 0";
        at = e.end;
    }
    out += code.slice(at);
    return { code: out, removed: edits.length, kept };
}
