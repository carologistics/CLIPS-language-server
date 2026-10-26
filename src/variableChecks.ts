/**
 * @file Semantic checks of local variables: unbound, unused, used before
 * bound, rebound to another type, or shadowing another binding. Run by
 * `collectSemanticDiagnostics` in diagnostics.ts.
 */

import type { SyntaxNode } from 'tree-sitter';
import { DiagnosticSeverity, DiagnosticTag, type Diagnostic } from 'vscode-languageserver/node.js';
import { bareVarName, bindingBody, bindingKind, findLocalReferences, scopeBindingSites } from './locals.js';
import { diag, relatedAt } from './lsp.js';
import { enclosingLhsSlot, resolveTemplateSlot, slotConstraints } from './slots.js';
import type { SymbolTable } from './symbolTable.js';

/** Node types of local variables. */
const VAR_TYPES = ['single_field_variable', 'multifield_variable'];

// Parameters

/**
 * Duplicate parameters of functions, methods and handlers.
 *
 * @param root - The document's root.
 * @param uri - The document's URI.
 * @param out - Output.
 */
export function checkDuplicateParameters(root: SyntaxNode, uri: string, out: Diagnostic[]): void {
  for (const fn of root.descendantsOfType([
    'deffunction_construct',
    'defmethod_construct',
    'defmessage_handler_construct'
  ])) {
    if (fn.hasError) continue;
    const first = new Map<string, SyntaxNode>();
    for (const param of fn.descendantsOfType([
      'regular_parameter',
      'parameter',
      'wildcard_parameter',
      'parameter_restriction',
      'wildcard_parameter_restriction'
    ])) {
      const varNode = param.type.endsWith('restriction')
        ? param.children.find((c) => c.type === 'single_field_variable' || c.type === 'multifield_variable')
        : param;
      if (!varNode) continue;
      const name = bareVarName(varNode.text);
      const prior = first.get(name);
      if (prior) {
        out.push(
          diag(varNode, `Duplicate parameter "${varNode.text}"`, DiagnosticSeverity.Error, 'duplicate-parameter', {
            relatedInformation: relatedAt(uri, prior, 'first declared here')
          })
        );
      } else {
        first.set(name, varNode);
      }
    }
  }
}

// Rule variables: unbound (RHS + predicates), not/exists scope escape

/**
 * Whether a variable occurrence binds it.
 *
 * @param v - A variable node.
 */
function isBindingOccurrence(v: SyntaxNode): boolean {
  return bindingKind(v) !== null;
}

/**
 * Reads of unbound variables in `actions` ([PRCCODE3]). Parameters, bind
 * targets and `scopeWide` names are bound for the whole body; loop and
 * query variables only inside their expression.
 *
 * @param scope - The rule body or construct.
 * @param actions - The actions to check.
 * @param scopeWide - Names bound for the whole body (LHS variables, `?self`).
 * @param unboundHint - Message ending for a name bound nowhere.
 * @param out - Output.
 */
function checkUnboundReads(
  scope: SyntaxNode,
  actions: SyntaxNode[],
  scopeWide: Iterable<string>,
  unboundHint: string,
  out: Diagnostic[]
): void {
  const bound = new Set<string>(scopeWide);
  const confined: { name: string; body: SyntaxNode }[] = [];
  /** Records a binding, for the whole scope or only its loop or query body. */
  const addBinding = (v: SyntaxNode, kind: ReturnType<typeof bindingKind>) => {
    const name = bareVarName(v.text);
    const extent = kind === 'loop' || kind === 'query' ? bindingBody(v) : null;
    if (!extent) {
      bound.add(name);
      return;
    }
    confined.push({ name, body: extent });
    if (kind === 'loop' && v.parent?.type !== 'loop_for_count_binding') confined.push({ name: `${name}-index`, body: extent });
  };
  for (const [, sites] of scopeBindingSites(scope)) {
    for (const site of sites) addBinding(site, VAR_TYPES.includes(site.type) ? bindingKind(site) : null);
  }
  for (const v of scope.descendantsOfType(VAR_TYPES)) {
    const kind = bindingKind(v);
    if (kind) addBinding(v, kind);
  }

  for (const action of actions) {
    for (const read of action.descendantsOfType([...VAR_TYPES, 'special_variable'])) {
      if (read.type !== 'special_variable' && isBindingOccurrence(read)) continue;
      // ?f:slot -> f
      const name = read.type === 'special_variable' ? (read.children.find((c) => c.type === 'symbol')?.text ?? '') : bareVarName(read.text);
      if (!name || bound.has(name)) continue;
      if (confined.some((c) => c.name === name && c.body.startIndex <= read.startIndex && read.endIndex <= c.body.endIndex)) continue;

      // Bound only inside some other loop or query: mention it.
      const elsewhere = confined.find((c) => c.name === name);
      out.push(
        diag(
          read,
          elsewhere
            ? `Unbound variable ${read.text} — ?${name} only exists inside the ${confinedFormName(elsewhere.body)} on line ${elsewhere.body.startPosition.row + 1}`
            : `Unbound variable ${read.text} — ${unboundHint}`,
          DiagnosticSeverity.Warning,
          'variable-unbound'
        )
      );
    }
  }
}

/**
 * Unbound variables in function, method and handler bodies.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkFunctionBodyVariables(root: SyntaxNode, out: Diagnostic[]): void {
  for (const fn of root.descendantsOfType(['deffunction_construct', 'defmethod_construct', 'defmessage_handler_construct'])) {
    if (fn.hasError) continue;
    const actions = fn.children.filter((c) => c.type === 'action');
    const implicit = fn.type === 'defmessage_handler_construct' ? ['self'] : [];
    checkUnboundReads(fn, actions, implicit, 'not a parameter or bound by bind', out);
  }
}

/**
 * The keyword of a loop or query, for messages.
 *
 * @param body - From `bindingBody`.
 * @returns e.g. `foreach`.
 */
function confinedFormName(body: SyntaxNode): string {
  if (body.type === 'function_call') return body.namedChildren[0]?.text ?? 'loop';
  const keyword = body.children.find((c) => !c.isNamed && c.type !== '(' && c.type !== ')');
  return keyword?.type ?? body.type.replace(/_expression$/, '').replace(/_/g, '-');
}

/**
 * The nearest `not` or `exists` CE around a node.
 *
 * @param node - A node in the rule.
 * @param ruleNode - The rule, where the search stops.
 * @returns The CE, or `null`.
 */
function enclosingNegativeCE(node: SyntaxNode, ruleNode: SyntaxNode): SyntaxNode | null {
  for (let a = node.parent; a && a.id !== ruleNode.id; a = a.parent) {
    if (a.type === 'not_CE' || a.type === 'exists_CE') return a;
  }
  return null;
}

/** A rule's LHS occurrences of one variable, and the `not`/`exists` CEs (by id) they are in. */
interface LhsBinding {
  /** The occurrences. */
  nodes: SyntaxNode[];
  /** Ids of the `not` and `exists` CEs containing them. */
  negativeCEs: Set<number>;
  /** Some occurrence is outside any negative CE. */
  hasPositive: boolean;
}

/**
 * Rule variables: unbound in predicates or on the RHS, and bound only
 * inside not/exists but used outside.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkRuleVariables(root: SyntaxNode, out: Diagnostic[]): void {
  for (const rule of root.descendantsOfType('defrule_construct')) {
    if (rule.hasError) continue;
    const body = rule.children.find((c) => c.type === 'defrule_body');
    if (!body) continue;

    const conditionals = body.children.filter((c) => c.type === 'conditional_element');
    const actions = body.children.filter((c) => c.type === 'action');

    // LHS bindings, noting whether all of them are inside not/exists.
    const lhs = new Map<string, LhsBinding>();
    /** Records an LHS occurrence and whether it is inside a negative CE. */
    const addBinding = (varNode: SyntaxNode, site: SyntaxNode) => {
      const key = bareVarName(varNode.text);
      let entry = lhs.get(key);
      if (!entry) {
        entry = { nodes: [], negativeCEs: new Set(), hasPositive: false };
        lhs.set(key, entry);
      }
      entry.nodes.push(varNode);
      const negative = enclosingNegativeCE(site, rule);
      if (negative) entry.negativeCEs.add(negative.id);
      else entry.hasPositive = true;
    };
    for (const ce of conditionals) {
      for (const assigned of ce.descendantsOfType('assigned_pattern_CE')) {
        const v = assigned.children.find((c) => c.type === 'single_field_variable');
        if (v) addBinding(v, assigned);
      }
      for (const term of ce.descendantsOfType('term')) {
        const child = term.firstChild;
        if (child && VAR_TYPES.includes(child.type)) addBinding(child, term);
      }
    }

    // Variables in test CEs and :(...) / =(...) constraints must be bound by a pattern.
    const predicateCalls: SyntaxNode[] = [];
    for (const ce of conditionals) {
      for (const testCE of ce.descendantsOfType('test_CE')) {
        const call = testCE.children.find((c) => c.type === 'function_call');
        if (call) predicateCalls.push(call);
      }
      for (const term of ce.descendantsOfType('term')) {
        if (term.firstChild?.type === ':' || term.firstChild?.type === '=') {
          const call = term.children.find((c) => c.type === 'function_call');
          if (call) predicateCalls.push(call);
        }
      }
    }
    for (const call of predicateCalls) {
      for (const v of call.descendantsOfType(VAR_TYPES)) {
        const key = bareVarName(v.text);
        if (!lhs.has(key)) {
          out.push(
            diag(
              v,
              `Unbound variable ${v.text} in a pattern constraint — no LHS pattern binds it`,
              DiagnosticSeverity.Warning,
              'variable-unbound'
            )
          );
        }
      }
    }

    checkUnboundReads(body, actions, lhs.keys(), 'not bound on the rule LHS or by bind', out);

    // A variable bound only inside not/exists and used outside it.
    for (const [name, binding] of lhs) {
      if (binding.hasPositive || binding.negativeCEs.size === 0) continue;
      for (const v of rule.descendantsOfType(VAR_TYPES)) {
        if (bareVarName(v.text) !== name) continue;
        if (binding.nodes.some((b) => b.id === v.id)) continue;
        let insideOwnCE = false;
        for (let a = v.parent; a && a.id !== rule.id; a = a.parent) {
          if (binding.negativeCEs.has(a.id)) {
            insideOwnCE = true;
            break;
          }
        }
        if (!insideOwnCE) {
          out.push(
            diag(
              v,
              `Variable ${v.text} is bound inside a not/exists CE and is not visible here`,
              DiagnosticSeverity.Error,
              'variable-scope-escape'
            )
          );
        }
      }
    }
  }
}

// Unused (singleton) variables

/**
 * Whether a binding is a `bind`, `progn$` or `loop-for-count` target.
 *
 * @param binding - A variable node.
 */
function isAssignmentBinding(binding: SyntaxNode): boolean {
  const p = binding.parent;
  if (p?.type === 'progn_dollar_binding' || p?.type === 'loop_for_count_binding') return true;
  if (p?.type === 'variable' && p.parent?.type === 'function_call') {
    const kids = p.parent.namedChildren;
    return kids[0]?.type === 'function_name' && kids[0].text === 'bind' && kids[1]?.id === p.id;
  }
  return false;
}

/**
 * The binding form's name for messages.
 *
 * @param binding - A variable node from {@link isAssignmentBinding}.
 * @returns `bind`, `progn$` or `loop-for-count`.
 */
function bindingVerb(binding: SyntaxNode): string {
  const p = binding.parent?.type;
  if (p === 'progn_dollar_binding') return 'progn$';
  if (p === 'loop_for_count_binding') return 'loop-for-count';
  return 'bind';
}

/**
 * `bind`, `progn$` and `loop-for-count` variables that are never read.
 * Unused parameters and pattern variables are common, so they aren't reported.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkUnusedVariables(root: SyntaxNode, out: Diagnostic[]): void {
  for (const scope of root.descendantsOfType([
    'defrule_body',
    'deffunction_construct',
    'defmethod_construct',
    'defmessage_handler_construct'
  ])) {
    if (scope.hasError) continue;
    for (const [, sites] of scopeBindingSites(scope)) {
      if (sites.length !== 1) continue; // several bindings form a join
      const binding = sites[0];
      // Only bind, progn$ and loop-for-count targets. Unused parameters and
      // pattern variables are very common in CLIPS code and would be noise.
      if (!isAssignmentBinding(binding)) continue;
      if (findLocalReferences(binding).length > 0) continue;
      out.push(
        diag(
          binding,
          `Variable ${binding.text} is bound by ${bindingVerb(binding)} but never used`,
          DiagnosticSeverity.Hint,
          'variable-unused',
          { tags: [DiagnosticTag.Unnecessary] }
        )
      );
    }
  }
}

// variable-used-before-bound

/**
 * Whether a binding is a `bind` target.
 *
 * @param node - A variable node.
 */
function isBindTarget(node: SyntaxNode): boolean {
  const p = node.parent;
  if (p?.type !== 'variable' || p.parent?.type !== 'function_call') return false;
  const kids = p.parent.namedChildren;
  return kids[0]?.type === 'function_name' && kids[0].text === 'bind' && kids[1]?.id === p.id;
}

/**
 * Names bound by LHS patterns, found by walking the tree so object
 * pattern bindings are included.
 *
 * @param scope - A scope node.
 * @returns The bare names; empty for non-rule scopes.
 */
function termBoundNames(scope: SyntaxNode): Set<string> {
  const names = new Set<string>();
  if (scope.type !== 'defrule_body') return names;
  for (const ce of scope.children) {
    if (ce.type !== 'conditional_element') continue;
    for (const term of ce.descendantsOfType('term')) {
      const child = term.firstChild;
      if (child && VAR_TYPES.includes(child.type)) names.add(bareVarName(child.text));
    }
    for (const assigned of ce.descendantsOfType('assigned_pattern_CE')) {
      const v = assigned.children.find((c) => c.type === 'single_field_variable');
      if (v) names.add(bareVarName(v.text));
    }
  }
  return names;
}

/**
 * Reads before the first `bind`, for variables bound only by `bind`.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkVariableUsedBeforeBound(root: SyntaxNode, out: Diagnostic[]): void {
  for (const scope of root.descendantsOfType([
    'defrule_body',
    'deffunction_construct',
    'defmethod_construct',
    'defmessage_handler_construct'
  ])) {
    if (scope.hasError) continue;
    const otherBindings = termBoundNames(scope);
    for (const [name, sites] of scopeBindingSites(scope)) {
      if (otherBindings.has(name)) continue;
      const bindSites = sites.filter(isBindTarget);
      if (bindSites.length === 0) continue;
      if (bindSites.length !== sites.length) continue; // also bound otherwise, so available from the start

      const earliest = bindSites.reduce((a, b) => (b.startIndex < a.startIndex ? b : a));
      for (const v of scope.descendantsOfType(VAR_TYPES)) {
        if (bareVarName(v.text) !== name) continue;
        if (sites.some((s) => s.id === v.id)) continue;
        if (v.startIndex < earliest.startIndex) {
          out.push(
            diag(
              v,
              `Variable ${v.text} is read here before its first (bind ${v.text} ...) later in this scope`,
              DiagnosticSeverity.Error,
              'variable-used-before-bound'
            )
          );
        }
      }
    }
  }
}

// variable-unused-pattern

/**
 * Pattern variables never used elsewhere. A separate code from
 * `variable-unused`, since these are common and often intended.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkUnusedPatternVariables(root: SyntaxNode, out: Diagnostic[]): void {
  for (const scope of root.descendantsOfType([
    'defrule_body',
    'deffunction_construct',
    'defmethod_construct',
    'defmessage_handler_construct'
  ])) {
    if (scope.hasError) continue;
    for (const [, sites] of scopeBindingSites(scope)) {
      if (sites.length !== 1) continue; // a join is a use
      const binding = sites[0];
      if (binding.parent?.type !== 'term') continue;
      if (findLocalReferences(binding).length > 0) continue;
      out.push(
        diag(
          binding,
          `Variable ${binding.text} is pattern-bound but never referenced elsewhere in this rule`,
          DiagnosticSeverity.Hint,
          'variable-unused-pattern',
          { tags: [DiagnosticTag.Unnecessary] }
        )
      );
    }
  }
}

// variable-rebind-type-conflict

/**
 * Whether two type lists share a type, with NUMBER and LEXEME expanded.
 *
 * @param a - One slot's types.
 * @param b - Another slot's types.
 * @returns `true` if they overlap.
 */
function typesCanOverlap(a: string[], b: string[]): boolean {
  /** A type with NUMBER and LEXEME replaced by their members. */
  const expand = (t: string): string[] => {
    if (t === 'NUMBER') return ['INTEGER', 'FLOAT'];
    if (t === 'LEXEME') return ['SYMBOL', 'STRING'];
    return [t];
  };
  const setA = new Set(a.flatMap(expand));
  for (const t of b.flatMap(expand)) if (setA.has(t)) return true;
  return false;
}

/**
 * A variable bound in two slots whose types can never be equal; CLIPS
 * rejects the rule ([RULECSTR1]). Only `type` counts.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 */
export function checkRebindTypeConflicts(root: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  for (const rule of root.descendantsOfType('defrule_construct')) {
    if (rule.hasError) continue;
    const body = rule.children.find((c) => c.type === 'defrule_body');
    if (!body) continue;

    const byName = new Map<string, SyntaxNode[]>();
    for (const ce of body.children) {
      if (ce.type !== 'conditional_element') continue;
      for (const term of ce.descendantsOfType('term')) {
        const child = term.firstChild;
        if (!child || !VAR_TYPES.includes(child.type)) continue;
        const key = bareVarName(child.text);
        const list = byName.get(key);
        if (list) list.push(child);
        else byName.set(key, [child]);
      }
    }

    for (const occurrences of byName.values()) {
      if (occurrences.length < 2) continue;

      const typed: { node: SyntaxNode; types: string[]; label: string }[] = [];
      for (const occ of occurrences) {
        const slot = enclosingLhsSlot(occ);
        const ctx = slot ? resolveTemplateSlot(slot, table) : null;
        if (!ctx?.slotDefinition) continue;
        const types = slotConstraints(ctx.slotDefinition).types;
        if (types.length > 0) typed.push({ node: occ, types, label: `${ctx.owner.name}.${ctx.slotName}` });
      }

      for (let i = 1; i < typed.length; i++) {
        if (typesCanOverlap(typed[0].types, typed[i].types)) continue;
        out.push(
          diag(
            typed[i].node,
            `Variable ${occurrences[0].text} is bound to "${typed[0].label}" (${typed[0].types.join('/')}) and "${typed[i].label}" (${typed[i].types.join('/')}) -- these types can never be equal, so the pattern is unmatchable and CLIPS refuses to load this rule`,
            DiagnosticSeverity.Error,
            'variable-rebind-type-conflict'
          )
        );
      }
    }
  }
}

// variable-shadow

/**
 * Label of a non-`bind` binding: parameter, pattern variable or fact address.
 *
 * @param node - The binding.
 * @returns The label with its article, e.g. `a parameter`.
 */
function structuralBindingLabel(node: SyntaxNode): string {
  switch (node.type) {
    case 'regular_parameter':
    case 'parameter':
    case 'wildcard_parameter':
      return 'a parameter';
  }
  switch (node.parent?.type) {
    case 'parameter_restriction':
    case 'wildcard_parameter_restriction':
      return 'a parameter';
    case 'assigned_pattern_CE':
      return 'a fact-address binding';
    case 'term':
      return 'a pattern-bound variable';
    default:
      return 'another binding';
  }
}

/**
 * A `bind` target also bound by a pattern or as a fact address; after the
 * bind it no longer holds the matched value. Parameters are exempt:
 * `(bind ?x (upcase ?x))` is common.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
export function checkVariableShadowing(root: SyntaxNode, out: Diagnostic[]): void {
  for (const scope of root.descendantsOfType([
    'defrule_body',
    'deffunction_construct',
    'defmethod_construct',
    'defmessage_handler_construct'
  ])) {
    if (scope.hasError) continue;
    const otherBindings = termBoundNames(scope);
    for (const [name, sites] of scopeBindingSites(scope)) {
      const assignments = sites.filter(isBindTarget);
      if (assignments.length === 0) continue;

      const structural = sites.filter((n) => !isBindTarget(n) && structuralBindingLabel(n) !== 'a parameter');
      if (structural.length > 0) {
        out.push(
          diag(
            assignments[0],
            `${assignments[0].text} rebinds a name already used as ${structuralBindingLabel(structural[0])} -- consider a different variable name to avoid confusion`,
            DiagnosticSeverity.Hint,
            'variable-shadow'
          )
        );
      } else if (otherBindings.has(name)) {
        // Bound in a pattern locals.scm doesn't cover, e.g. an object pattern.
        out.push(
          diag(
            assignments[0],
            `${assignments[0].text} rebinds a name already used as a pattern-bound variable -- consider a different variable name to avoid confusion`,
            DiagnosticSeverity.Hint,
            'variable-shadow'
          )
        );
      }
    }
  }
}
