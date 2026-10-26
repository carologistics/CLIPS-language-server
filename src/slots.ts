/**
 * @file Template slots: finding the slot definition for a pattern, a fact or
 * a modify call, and the values the slot allows.
 */

import type { SyntaxNode } from 'tree-sitter';
import { findLocalDefinitions } from './locals.js';
import { nameKey, type SymbolEntry, type SymbolTable } from './symbolTable.js';

/**
 * A template's slot definition.
 *
 * @param templateNode - The `deftemplate_construct`.
 * @param slotName - The slot name.
 * @returns The `single_slot_definition` or `multislot_definition`, or `null`.
 */
export function findSlotDefinition(templateNode: SyntaxNode, slotName: string): SyntaxNode | null {
  for (const child of templateNode.children) {
    if (child.type !== 'slot_definition') continue;
    const inner = child.firstChild;
    if (!inner) continue;
    const nameChild = inner.children.find((c) => c.type === 'name');
    if (nameChild && nameKey(nameChild) === slotName) return inner;
  }
  return null;
}

/** A template slot with its template. */
export interface TemplateSlotContext {
  /** The template. */
  owner: SymbolEntry;
  /** The slot name. */
  slotName: string;
  /** `null` if the template has no such slot. */
  slotDefinition: SyntaxNode | null;
}

/**
 * The LHS slot a node is in. Stops at the rule body and actions.
 *
 * @param node - Any node.
 * @returns The LHS slot, or `null`.
 */
export function enclosingLhsSlot(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'single_field_LHS_slot' || current.type === 'multifield_LHS_slot') {
      return current;
    }
    if (current.type === 'defrule_body' || current.type === 'action') return null;
    current = current.parent;
  }
  return null;
}

/**
 * The template and slot definition of an LHS slot.
 *
 * @param lhsSlot - An LHS slot node.
 * @param table - The lookup scope.
 * @returns The slot, or `null` if the template is unknown.
 */
export function resolveTemplateSlot(
  lhsSlot: SyntaxNode,
  table: SymbolTable
): TemplateSlotContext | null {
  const slotNameNode = lhsSlot.children.find((c) => c.type === 'name');
  if (!slotNameNode) return null;

  const pattern = lhsSlot.parent?.parent;
  if (pattern?.type !== 'template_pattern_CE') return null;

  const ownerNameNode = pattern.children.find((c) => c.type === 'name');
  if (!ownerNameNode) return null;

  const owner = table.templates.get(nameKey(ownerNameNode));
  if (!owner) return null;

  const slotName = nameKey(slotNameNode);
  return { owner, slotName, slotDefinition: findSlotDefinition(owner.definitionNode, slotName) };
}

/**
 * A slot of an asserted or deffacts fact, e.g. `(name "gouda")` in
 * `(assert (cheese (name "gouda")))`. The grammar parses it as a call;
 * like CLIPS, we treat it as a slot when the head is a known deftemplate.
 *
 * @param call - A `function_call` node.
 * @param table - The lookup scope.
 * @returns The slot, or `null` if it is a real call.
 */
export function resolveRhsPatternSlot(call: SyntaxNode, table: SymbolTable): TemplateSlotContext | null {
  // =(+ 1 ?n) is a value, not a slot.
  const pattern = call.parent?.type === 'RHS_field' && call.parent.firstChild?.type !== '=' ? call.parent.parent : null;
  if (pattern?.type !== 'ordered_RHS_pattern') return null;

  const slotNameNode = call.namedChildren[0];
  if (slotNameNode?.type !== 'function_name') return null;

  const head = pattern.children.find((c) => c.type === 'name');
  if (!head) return null;
  const owner = table.templates.get(nameKey(head));
  if (!owner) return null;

  const slotName = slotNameNode.text;
  return { owner, slotName, slotDefinition: findSlotDefinition(owner.definitionNode, slotName) };
}

/**
 * The patterns that bound the fact a modify/duplicate changes, through its
 * `?f <- (...)` bindings or a query member like `((?c cheese))`.
 *
 * @param factAction - A `fact_action` node.
 * @returns The patterns (several if `?f` is bound in several `or` branches), or `null` if the fact can't be traced.
 */
export function factActionPatterns(factAction: SyntaxNode): SyntaxNode[] | null {
  const specifier = factAction.children.find((c) => c.type === 'variable')?.firstChild;
  if (specifier?.type !== 'single_field_variable') return null;

  const patterns: SyntaxNode[] = [];
  for (const binding of findLocalDefinitions(specifier)) {
    const assigned = binding.parent;
    if (assigned?.type === 'fact_set_member_template') {
      patterns.push(assigned);
      continue;
    }
    if (assigned?.type !== 'assigned_pattern_CE') return null;
    const pattern = assigned.children.find((c) => c.type === 'pattern_CE')?.firstChild;
    if (!pattern) return null;
    patterns.push(pattern);
  }
  return patterns.length > 0 ? patterns : null;
}

/**
 * The template of the fact a modify/duplicate changes. All bound patterns
 * must be of the same template.
 *
 * @param factAction - A `fact_action` node.
 * @param table - The lookup scope.
 * @returns The template, or `null`.
 */
export function resolveFactActionTemplate(factAction: SyntaxNode, table: SymbolTable): SymbolEntry | null {
  const patterns = factActionPatterns(factAction);
  if (!patterns) return null;

  let templateName: string | null = null;
  for (const pattern of patterns) {
    if (!['template_pattern_CE', 'ordered_pattern_CE', 'fact_set_member_template'].includes(pattern.type)) return null;
    const heads = pattern.children.filter((c) => c.type === 'name');
    if (heads.length !== 1) return null;
    const name = nameKey(heads[0]);
    if (templateName !== null && name !== templateName) return null;
    templateName = name;
  }
  return templateName === null ? null : (table.templates.get(templateName) ?? null);
}

/** A slot's declared constraints, shared by hover and diagnostics. */
export interface SlotConstraints {
  /** Declared with `multislot`. */
  isMultislot: boolean;
  /** `(type ...)` values, e.g. `['INTEGER']`; empty if none. */
  types: string[];
  /** `allowed-*` values; `null` without such an attribute. */
  allowedValues: string[] | null;
  /** `(range lo hi)`; bounds may be `?VARIABLE`. */
  range: { lo: string; hi: string } | null;
  /** `(cardinality lo hi)`; bounds may be `?VARIABLE`. */
  cardinality: { lo: string; hi: string } | null;
  /** Values of a static default (empty for `?NONE`/`?DERIVE`); `null` for none or `default-dynamic`. */
  defaultValues: SyntaxNode[] | null;
}

/**
 * Reads a slot's constraints.
 *
 * @param slotDefinition - A template slot definition or a class `slot`.
 * @returns The constraints.
 */
export function slotConstraints(slotDefinition: SyntaxNode): SlotConstraints {
  const isMultislot =
    slotDefinition.type === 'multislot_definition' || /^\(\s*multislot\b/.test(slotDefinition.text);

  const types: string[] = [];
  const typeAttr = slotDefinition.descendantsOfType('type_attribute')[0];
  if (typeAttr) {
    const spec = typeAttr.namedChildren.find((c) => c.type === 'type_specification');
    if (spec && spec.text !== '?VARIABLE') {
      for (const at of spec.namedChildren) if (at.type === 'allowed_type') types.push(at.text);
    }
  }

  let allowedValues: string[] | null = null;
  const allowedAttr = slotDefinition.descendantsOfType('allowed_constant_attribute')[0];
  if (allowedAttr) {
    const list = allowedAttr.namedChildren.find((c) => c.type.endsWith('_list'));
    if (list && list.text !== '?VARIABLE') {
      allowedValues = list.namedChildren.filter((c) => c.type !== 'variable').map((c) => c.text);
    }
  }

  /** The two limits of a `range` or `cardinality` attribute, or `null`. */
  const boundsOf = (attrType: string, specType: string): { lo: string; hi: string } | null => {
    const attr = slotDefinition.descendantsOfType(attrType)[0];
    if (!attr) return null;
    const specs = attr.namedChildren.filter((c) => c.type === specType);
    return specs.length === 2 ? { lo: specs[0].text, hi: specs[1].text } : null;
  };

  let defaultValues: SyntaxNode[] | null = null;
  const defAttr = slotDefinition.descendantsOfType('default_attribute')[0];
  if (defAttr && /^\(\s*default\b/.test(defAttr.text) && !/^\(\s*default-dynamic\b/.test(defAttr.text)) {
    defaultValues = defAttr.namedChildren.slice();
  }

  return {
    isMultislot,
    types,
    allowedValues,
    range: boundsOf('range_attribute', 'range_specification'),
    cardinality: boundsOf('cardinality_attribute', 'cardinality_specification'),
    defaultValues
  };
}

/**
 * The type of a literal.
 *
 * @param node - A `constant` or one of its inner nodes.
 * @returns The type name, or `null` if not a literal.
 */
export function literalType(node: SyntaxNode): string | null {
  let inner = node;
  if (inner.type === 'constant' && inner.firstChild) inner = inner.firstChild;
  if (inner.type === 'number' && inner.firstChild) inner = inner.firstChild;
  switch (inner.type) {
    case 'integer':
      return 'INTEGER';
    case 'float':
      return 'FLOAT';
    case 'string':
      return 'STRING';
    case 'instance_name':
      return 'INSTANCE-NAME';
    case 'symbol':
      return /^(TRUE|FALSE)$/.test(inner.text) ? 'BOOLEAN' : 'SYMBOL';
    default:
      return null;
  }
}

/**
 * Whether a literal type satisfies declared types.
 *
 * @param litType - From {@link literalType}.
 * @param declared - Declared types; empty means any.
 * @returns `true` if compatible, or when in doubt.
 */
export function literalSatisfiesTypes(litType: string, declared: string[]): boolean {
  if (declared.length === 0) return true;
  /** Whether the literal fits declared type `d`. */
  const ok = (d: string): boolean => {
    switch (d) {
      case 'NUMBER':
        return litType === 'INTEGER' || litType === 'FLOAT';
      case 'LEXEME':
        return litType === 'STRING' || litType === 'SYMBOL' || litType === 'BOOLEAN';
      case 'SYMBOL':
        return litType === 'SYMBOL' || litType === 'BOOLEAN';
      case 'STRING':
        return litType === 'STRING';
      case 'INTEGER':
        return litType === 'INTEGER';
      case 'FLOAT':
        return litType === 'FLOAT';
      case 'INSTANCE':
      case 'INSTANCE-NAME':
        return litType === 'INSTANCE-NAME';
      default:
        return true; // addresses, user class names
    }
  };
  return declared.some(ok);
}
