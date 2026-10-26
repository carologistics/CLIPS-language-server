/**
 * @file Local variables: binding sites (from `locals.scm`, plus the forms it
 * misses), references, and which variables are visible at a position.
 */

import Parser, { type SyntaxNode } from 'tree-sitter';
import { CLIPS_LANGUAGE, LOCALS_QUERY_SOURCE } from './language.js';

/** The compiled `locals.scm` query. */
const localsQuery = new Parser.Query(CLIPS_LANGUAGE, LOCALS_QUERY_SOURCE);

/** The `@local.scope` nodes of `locals.scm`. */
const SCOPE_TYPES = new Set([
  'defrule_body',
  'deffunction_construct',
  'defmethod_construct',
  'defmessage_handler_construct'
]);

/**
 * The nearest enclosing scope.
 *
 * @param node - Any node.
 * @returns The rule body, function, method or handler, or `null`.
 */
function findEnclosingScope(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (SCOPE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Strips `?` or `$?`; the symbol inside `?x:slot` has none.
 *
 * @param text - A variable's text.
 * @returns The bare name.
 */
function normalizeVarName(text: string): string {
  if (text.startsWith('$?')) return text.slice(2);
  if (text.startsWith('?')) return text.slice(1);
  return text;
}

/**
 * The binding sites of a variable in its rule, function, method or
 * handler. Includes the bindings `locals.scm` misses (`foreach`, multifield
 * `bind`), and maps `?x-index` to the `progn$`/`foreach` that binds `?x`.
 *
 * @param node - A variable node, or the symbol inside `?x:slot`.
 * @returns The binding nodes in document order.
 */
export function findLocalDefinitions(node: SyntaxNode): SyntaxNode[] {
  const scope = findEnclosingScope(node);
  if (!scope) return [];

  const key = normalizeVarName(node.text);
  const captures = localsQuery.captures(scope);

  const seen = new Set<string>();
  const results: SyntaxNode[] = [];
  /** Adds a binding once per source range. */
  const add = (binding: SyntaxNode) => {
    const rangeKey = `${binding.startIndex}-${binding.endIndex}`;
    if (seen.has(rangeKey)) return;
    seen.add(rangeKey);
    results.push(binding);
  };
  for (const { name, node: capturedNode } of captures) {
    if (name !== 'local.definition.var') continue;
    if (normalizeVarName(capturedNode.text) === key) add(capturedNode);
  }
  for (const v of scope.descendantsOfType(['single_field_variable', 'multifield_variable'])) {
    const kind = bindingKind(v);
    if ((kind === 'bind' || kind === 'loop') && normalizeVarName(v.text) === key) add(v);
  }
  if (results.length === 0) {
    const loopVariable = implicitIndexLoopVariable(node, scope);
    if (loopVariable) add(loopVariable);
  }
  return results.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * `progn$` and `foreach` also bind `?<var>-index` inside the loop
 * (`loop-for-count` doesn't).
 *
 * @param node - A variable such as `?c-index`.
 * @param scope - Its enclosing scope.
 * @returns The `?c` of the innermost enclosing loop, or `null`.
 */
export function implicitIndexLoopVariable(node: SyntaxNode, scope: SyntaxNode): SyntaxNode | null {
  const key = normalizeVarName(node.text);
  if (!key.endsWith('-index')) return null;
  const loopName = key.slice(0, -'-index'.length);

  let best: SyntaxNode | null = null;
  for (const v of scope.descendantsOfType(['single_field_variable', 'multifield_variable'])) {
    if (normalizeVarName(v.text) !== loopName) continue;
    if (bindingKind(v) !== 'loop' || v.parent?.type === 'loop_for_count_binding') continue;
    const body = bindingBody(v);
    if (body && contains(body, node) && (!best || v.startIndex > best.startIndex)) best = v;
  }
  return best;
}

/** Node types counted by {@link findLocalReferences}. */
const VARIABLE_NODE_TYPES = new Set(['single_field_variable', 'multifield_variable']);

/**
 * Every occurrence of the name in scope that isn't a binding site. Walks
 * the tree, since `locals.scm`'s reference patterns miss deeply nested calls.
 *
 * @param node - A variable node.
 * @returns The reads.
 */
export function findLocalReferences(node: SyntaxNode): SyntaxNode[] {
  const scope = findEnclosingScope(node);
  if (!scope) return [];

  const key = normalizeVarName(node.text);
  const bindingRanges = new Set(
    findLocalDefinitions(node).map((n) => `${n.startIndex}-${n.endIndex}`)
  );

  const seen = new Set<string>();
  const results: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [scope];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
    if (!VARIABLE_NODE_TYPES.has(current.type)) continue;
    if (normalizeVarName(current.text) !== key) continue;

    const rangeKey = `${current.startIndex}-${current.endIndex}`;
    if (bindingRanges.has(rangeKey) || seen.has(rangeKey)) continue;
    seen.add(rangeKey);
    results.push(current);
  }
  return results;
}

/**
 * All `locals.scm` binding sites in a scope, by bare name.
 *
 * @param scope - A rule body, function, method or handler.
 * @returns Binding nodes per name, in document order.
 */
export function scopeBindingSites(scope: SyntaxNode): Map<string, SyntaxNode[]> {
  const byName = new Map<string, SyntaxNode[]>();
  const seen = new Set<string>();
  for (const { name, node } of localsQuery.captures(scope)) {
    if (name !== 'local.definition.var') continue;
    const rangeKey = `${node.startIndex}-${node.endIndex}`;
    if (seen.has(rangeKey)) continue;
    seen.add(rangeKey);
    const key = normalizeVarName(node.text);
    const list = byName.get(key);
    if (list) list.push(node);
    else byName.set(key, [node]);
  }
  return byName;
}

/**
 * Strips `?` or `$?` from a variable's text.
 *
 * @param text - The variable's text.
 * @returns The bare name.
 */
export function bareVarName(text: string): string {
  return normalizeVarName(text);
}

// Binding sites and visibility (shared by diagnostics and completion)

/**
 * How an occurrence binds a variable:
 * - `pattern`: a term in an LHS pattern
 * - `fact-address`: `?f <- (pattern)`
 * - `parameter`: of a function, method or handler
 * - `bind`: `(bind ?x ...)`
 * - `loop`: `progn$`, `foreach` or `loop-for-count`
 * - `query`: a fact or instance set member
 */
export type BindingKind = 'pattern' | 'fact-address' | 'parameter' | 'bind' | 'loop' | 'query';

/** Node types whose variable is a parameter. */
const PARAMETER_PARENTS = new Set([
  'regular_parameter',
  'parameter',
  'wildcard_parameter',
  'parameter_restriction',
  'wildcard_parameter_restriction'
]);

/**
 * Classifies a variable occurrence, including the forms `locals.scm` misses.
 *
 * @param v - A variable node.
 * @returns The binding kind, or `null` for a read.
 */
export function bindingKind(v: SyntaxNode): BindingKind | null {
  const p = v.parent;
  if (!p) return null;
  if (p.type === 'term') return 'pattern';
  if (p.type === 'assigned_pattern_CE') return 'fact-address';
  if (PARAMETER_PARENTS.has(p.type)) return 'parameter';
  if (p.type === 'progn_dollar_binding' || p.type === 'loop_for_count_binding') return 'loop';
  if (p.type === 'fact_set_member_template' || p.type === 'instance_set_member_template') return 'query';
  if (p.type === 'variable' && p.parent?.type === 'function_call') {
    const kids = p.parent.namedChildren;
    if (kids[0]?.type === 'function_name' && kids[1]?.id === p.id) {
      if (kids[0].text === 'bind') return 'bind';
      if (kids[0].text === 'foreach') return 'loop';
    }
  }
  return null;
}

/**
 * The expression a loop or query variable is limited to.
 *
 * @param binding - A `loop` or `query` binding.
 * @returns The loop or query expression, or `null` for other kinds.
 */
export function bindingBody(binding: SyntaxNode): SyntaxNode | null {
  const p = binding.parent;
  if (!p) return null;
  switch (p.type) {
    case 'progn_dollar_binding':
    case 'loop_for_count_binding':
      return p.parent;
    case 'fact_set_member_template':
    case 'instance_set_member_template':
      return p.parent?.parent ?? null;
    case 'variable':
      return p.parent; // (foreach ...)
    default:
      return null;
  }
}

/**
 * Whether `inner` is within `outer`.
 *
 * @param outer - The enclosing candidate.
 * @param inner - The node.
 */
function contains(outer: SyntaxNode, inner: SyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * Whether a CE binds `name` through a pattern term or `?f <-`.
 *
 * @param ce - A conditional element.
 * @param name - The bare variable name.
 */
function bindsName(ce: SyntaxNode, name: string): boolean {
  for (const v of ce.descendantsOfType(['single_field_variable', 'multifield_variable'])) {
    const kind = bindingKind(v);
    if ((kind === 'pattern' || kind === 'fact-address') && normalizeVarName(v.text) === name) return true;
  }
  return false;
}

/**
 * Whether an LHS binding is visible at `at`. One inside `not`, `exists` or
 * `forall` is visible only within it; one in an `or` branch is visible
 * after the `or` only if every branch binds it.
 *
 * @param binding - The binding occurrence.
 * @param name - Its bare name.
 * @param at - The node where the variable is used.
 */
function lhsBindingVisible(binding: SyntaxNode, name: string, at: SyntaxNode): boolean {
  for (let a = binding.parent; a; a = a.parent) {
    if (a.type === 'defrule_body') break;
    if (contains(a, at)) continue;
    if (a.type === 'not_CE' || a.type === 'exists_CE' || a.type === 'forall_CE') return false;
    if (a.type === 'or_CE') {
      const branches = a.namedChildren.filter((c) => c.type === 'conditional_element');
      if (!branches.every((b) => bindsName(b, name))) return false;
    }
  }
  return true;
}

/** A variable visible at a position. */
export interface VisibleVariable {
  /** Name without `?` or `$?`. */
  name: string;
  /** `implicit` for `?self` and the `-index` of `progn$`/`foreach`. */
  kind: BindingKind | 'implicit';
  /** Holds a multifield value. */
  multifield: boolean;
}

/**
 * Variables visible at `at`, in binding order. Only bindings before `at`
 * count.
 *
 * @param scope - The enclosing construct.
 * @param at - The node at the position.
 * @returns One entry per name.
 */
export function visibleVariables(scope: SyntaxNode, at: SyntaxNode): VisibleVariable[] {
  const result = new Map<string, VisibleVariable>();
  /** Adds a variable unless a nearer one has the name. */
  const add = (name: string, kind: VisibleVariable['kind'], multifield: boolean) => {
    if (!result.has(name)) result.set(name, { name, kind, multifield });
  };

  for (let a: SyntaxNode | null = at; a; a = a.parent) {
    if (a.type === 'defmessage_handler_construct') add('self', 'implicit', false);
  }

  for (const v of scope.descendantsOfType(['single_field_variable', 'multifield_variable'])) {
    if (v.startIndex >= at.startIndex) continue;
    const kind = bindingKind(v);
    if (!kind) continue;
    const name = normalizeVarName(v.text);
    if (!name) continue;

    if (kind === 'loop' || kind === 'query') {
      const body = bindingBody(v);
      if (!body || !contains(body, at)) continue;
    } else if (kind === 'bind') {
      // In (bind ?y (+ 1 ?|)) the value is evaluated before ?y is set.
      const call = v.parent?.parent;
      if (call && contains(call, at)) continue;
    } else if (kind === 'pattern' || kind === 'fact-address') {
      if (!lhsBindingVisible(v, name, at)) continue;
    }

    add(name, kind, v.type === 'multifield_variable');
    if (kind === 'loop' && v.parent?.type !== 'loop_for_count_binding') add(`${name}-index`, 'implicit', false);
  }
  return [...result.values()];
}

/**
 * Whether a new variable is declared here, so existing names aren't offered.
 *
 * @param v - A variable node.
 */
export function isDeclarationPosition(v: SyntaxNode): boolean {
  const kind = bindingKind(v);
  return kind === 'parameter' || kind === 'loop' || kind === 'query' || kind === 'fact-address';
}
