/**
 * @file {@link resolveTarget}: what is at a position, for go-to-definition and
 * hover. `name` nodes serve many purposes in the grammar, so a name is
 * classified by its parent node.
 */

import type { SyntaxNode, Tree } from 'tree-sitter';
import type { Position } from 'vscode-languageserver/node.js';
import { BUILTIN_FUNCTIONS, builtinArgumentAt, type BuiltinFunction } from './builtins.js';
import {
  allHandlers,
  attributeClasses,
  BUILTIN_CLASS_PARENTS,
  classAncestry,
  classSlots,
  findClassSlot,
  instanceDefinitionClass,
  isDefclassSuperclassName,
  isObjectPatternClass,
  slotAccessors,
  slotOverrideClasses,
  SYSTEM_HANDLERS,
  variableReferent,
  type ClassSlot
} from './classes.js';
import { externalKey, type ExternalKind, type ExternalName, type HostFunction } from './declarations.js';
import { findLocalDefinitions } from './locals.js';
import { instanceNameKey, isInstanceSiteName } from './sites.js';
import { findSlotDefinition, resolveFactActionTemplate, resolveRhsPatternSlot, resolveTemplateSlot } from './slots.js';
import { nameKey, type SymbolEntry, type SymbolTable } from './symbolTable.js';

/** What is at a position; `reference` is the node under the cursor. */
export type HoverTarget =
  /** A template, class or global, or a generic with its methods. */
  | { kind: 'construct'; entries: SymbolEntry[]; reference: SyntaxNode }
  /** A local variable with all its binding sites. */
  | { kind: 'local'; bindings: SyntaxNode[]; reference: SyntaxNode }
  /** A template slot; `slotDefinition` is `null` if the template lacks it. */
  | {
      kind: 'slot';
      owner: SymbolEntry;
      slotName: string;
      slotDefinition: SyntaxNode | null;
      reference: SyntaxNode;
    }
  /** A built-in function. */
  | { kind: 'builtin'; name: string; entry: BuiltinFunction; reference: SyntaxNode }
  /** A function registered with AddUDF, from a declaration file. */
  | { kind: 'hostFunction'; host: HostFunction; reference: SyntaxNode }
  /** A template, class or global declared by name only, `(defexternal <kind> <name>)` in a declaration file. */
  | { kind: 'external'; external: ExternalName; reference: SyntaxNode }
  /**
   * An ordered fact head. CLIPS creates an implied template, so its sites
   * are where it is asserted.
   */
  | { kind: 'orderedFact'; name: string; reference: SyntaxNode }
  /** The `MAIN` in `MAIN::x`; `entry` is `null` for the predefined `MAIN`. */
  | { kind: 'module'; name: string; entry: SymbolEntry | null; reference: SyntaxNode }
  /**
   * A class slot; `className` is the class it was reached through, which
   * may inherit it from `slot.owner`.
   */
  | { kind: 'classSlot'; slot: ClassSlot; className: string; reference: SyntaxNode }
  /** `is-a` or `name` in an object pattern. */
  | { kind: 'patternAttribute'; name: 'is-a' | 'name'; reference: SyntaxNode }
  /** A class predefined by CLIPS. */
  | { kind: 'builtinClass'; name: string; reference: SyntaxNode }
  /** A message handler predefined by CLIPS. */
  | { kind: 'systemHandler'; name: string; reference: SyntaxNode }
  /** `[S-1]`, resolved to where an instance of that name is created. */
  | { kind: 'instanceName'; name: string; reference: SyntaxNode };

/**
 * What the node at a position refers to; shared by go-to-definition and hover.
 *
 * @param tree - The document's tree.
 * @param table - The lookup scope.
 * @param position - The position.
 * @returns The target, or `null`.
 */
export function resolveTarget(
  tree: Tree,
  table: SymbolTable,
  position: Position
): HoverTarget | null {
  let node = tree.rootNode.descendantForPosition({ row: position.line, column: position.character });
  if (!node) return null;

  // On the ? or $? itself: use the name after it.
  if (node.type === '?' || node.type === '$?') {
    const after = tree.rootNode.descendantForPosition(node.endPosition);
    if (after) node = after;
  }

  if (node.type === 'global_variable') {
    const target = table.globals.get(node.text);
    if (target) return { kind: 'construct', entries: [target], reference: node };
    return externalTarget('defglobal', node.text, node, table);
  }

  const parent = node.parent;

  // assert, modify, make-instance, ... are grammar keywords and can't be redefined.
  if (node.type === 'fact_action_name' || parent?.type === 'instance_action_name') {
    const builtin = BUILTIN_FUNCTIONS.get(node.text);
    return builtin ? { kind: 'builtin', name: node.text, entry: builtin, reference: node } : null;
  }

  if ((node.type === 'is-a' || node.type === 'name') && parent?.type === 'attribute_constraint') {
    return { kind: 'patternAttribute', name: node.type, reference: node };
  }

  if (node.type === 'instance_name' || (parent?.type === 'constant' && isInstanceSiteName(parent))) {
    return { kind: 'instanceName', name: instanceNameKey(node.text), reference: node };
  }

  const formName = specialFormName(node);
  const form = formName ? BUILTIN_FUNCTIONS.get(formName) : undefined;
  if (formName && form) return { kind: 'builtin', name: formName, entry: form, reference: node };

  if (node.type !== 'symbol') return null;

  if (parent?.type === 'single_field_variable' || parent?.type === 'multifield_variable') {
    const defs = findLocalDefinitions(parent);
    return defs.length > 0 ? { kind: 'local', bindings: defs, reference: node } : null;
  }

  if (parent?.type === 'special_variable' && parent.children[1]?.id === node.id) {
    const defs = findLocalDefinitions(node);
    return defs.length > 0 ? { kind: 'local', bindings: defs, reference: node } : null;
  }

  // Call head, also in (UTIL::double 21), where the function is after `::`.
  const callHead =
    parent?.type === 'function_name'
      ? parent
      : parent?.type === 'qualified_name' && parent.parent?.type === 'function_name' && parent.children[2]?.id === node.id
        ? parent.parent
        : null;
  if (callHead) {
    // Actually a slot of an asserted template fact.
    const slot = callHead.parent ? resolveRhsPatternSlot(callHead.parent, table) : null;
    if (slot) return { kind: 'slot', ...slot, reference: node };

    const matches = table.functionLike.get(node.text);
    if (matches && matches.length > 0) {
      return { kind: 'construct', entries: matches, reference: node };
    }
    const builtin = BUILTIN_FUNCTIONS.get(node.text);
    if (builtin) return { kind: 'builtin', name: node.text, entry: builtin, reference: node };
    const host = table.hostFunctions.get(node.text);
    return host ? { kind: 'hostFunction', host, reference: node } : null;
  }

  if (parent?.type === 'constant') {
    // The name of a (defudf ...) or (defexternal ...) line of a declaration file.
    const declared = declarationLineTarget(parent, table);
    if (declared) return declared;
    // Slot override: ([w1] of Warehouse (Elements ...)), (modify-instance ?x (candidate no))
    const override = parent.parent;
    if (override?.type === 'slot_override' && override.namedChildren[0]?.id === parent.id) {
      return classSlotTarget(slotOverrideClasses(override, table), node.text, node, table);
    }
    // (object (is-a Warehouse) ...)
    if (isObjectPatternClass(parent)) return classTarget(node.text, node, table);
    // ([w1] of Warehouse ...), (make-instance of moves ...)
    if (override?.type === 'instance_definition' && instanceDefinitionClass(override)?.id === parent.id) {
      return classTarget(node.text, node, table);
    }
    // (send ?self compute-output)
    const call = parent.parent;
    if (call?.type === 'function_call' && call.namedChildren[0]?.text === 'send' && call.namedChildren[2]?.id === parent.id) {
      return resolveSendMessage(parent, call, table);
    }
    // (slot-range WeakAcid PH)
    const argument = resolveBuiltinArgument(parent, table);
    if (argument) return argument;
  }

  const moduleTarget = resolveModuleTarget(node, table);
  if (moduleTarget) return moduleTarget;

  const nameNode = climbToName(node);
  if (nameNode) return resolveNameTarget(nameNode, table);

  return null;
}

/**
 * Special forms and operators, which are anonymous tokens (`if`, `while`,
 * `>`, ...). Also maps `then`/`else` to `if` and `case`/`default` to
 * `switch`.
 *
 * @param node - The leaf at the position.
 * @returns The built-in's name, or `null`.
 */
function specialFormName(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  if ((node.type === 'then' || node.type === 'else') && parent.type === 'if_statement') return 'if';
  if (!node.isNamed) {
    if (parent.type === 'function_name' || /_(expression|statement)$/.test(parent.type)) return node.text;
    return null;
  }
  // case/default parse as calls inside the switch.
  if (node.type === 'symbol' && (node.text === 'case' || node.text === 'default') && parent.type === 'function_name') {
    const outer = parent.parent?.parent;
    const head = outer?.type === 'function_call' ? outer.namedChildren[0] : null;
    if (head?.type === 'function_name' && head.text === 'switch') return 'switch';
  }
  return null;
}

/**
 * The `name` around a symbol leaf.
 *
 * @param symbolNode - The symbol at the position.
 * @returns The `name`, or `null` (also for the `MAIN` in `MAIN::foo`).
 */
function climbToName(symbolNode: SyntaxNode): SyntaxNode | null {
  let target: SyntaxNode = symbolNode;
  if (target.parent?.type === 'qualified_name') {
    const qualified = target.parent;
    if (qualified.children[0]?.id === target.id) return null;
    target = qualified;
  }
  if (target.parent?.type === 'name') {
    return target.parent;
  }
  return null;
}

/**
 * Resolves a `name` node by its parent.
 *
 * @param nameNode - The `name` node.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveNameTarget(nameNode: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const context = nameNode.parent;
  if (!context) return null;
  const key = nameKey(nameNode);

  switch (context.type) {
    case 'template_pattern_CE':
    case 'ordered_pattern_CE': // (attribute) without slots can still be a template pattern
    case 'template_RHS_pattern':
    case 'ordered_RHS_pattern':
    case 'fact_set_member_template': {
      const target = table.templates.get(key);
      if (target) return { kind: 'construct', entries: [target], reference: nameNode };
      const external = externalTarget('deftemplate', key, nameNode, table);
      if (external) return external;
      return context.type === 'ordered_pattern_CE' || context.type === 'ordered_RHS_pattern'
        ? { kind: 'orderedFact', name: key, reference: nameNode }
        : null;
    }
    case 'parameter_restriction':
    case 'instance_set_member_template':
      return classTarget(key, nameNode, table);
    case 'port_specification': // (import MAIN ?ALL)
      return moduleTarget(key, nameNode, table);
    case 'port_item': // (export deftemplate status)
      return portItemTarget(context.children.find((c) => c.type === 'port_construct')?.text, key, nameNode, table);
    case 'defclass_construct': {
      if (isDefclassSuperclassName(nameNode, context)) return classTarget(key, nameNode, table);
      return ownConstructTarget(nameNode, context, table);
    }
    case 'defmessage_handler_construct': {
      // First name is the class, second the handler.
      const nameChildren = context.children.filter((c) => c.type === 'name');
      if (nameChildren[0]?.id === nameNode.id) return classTarget(key, nameNode, table);
      return ownConstructTarget(nameNode, context, table);
    }
    case 'single_field_LHS_slot':
    case 'multifield_LHS_slot':
      return resolveSlotTarget(nameNode, context, table);
    case 'single_field_RHS_slot':
    case 'multifield_RHS_slot':
      return resolveRhsSlotTarget(nameNode, context, table);
    case 'attribute_constraint':
      return classSlotTarget(attributeClasses(context), key, nameNode, table);
    case 'special_variable': {
      // ?f:slot, ?self:slot
      const variable = context.children.find((c) => c.type === 'symbol');
      const referent = variable ? variableReferent(variable, table) : null;
      if (!referent) return null;
      const owner = referent.templates.length === 1 ? referent.templates[0] : null;
      if (owner) {
        return { kind: 'slot', owner, slotName: key, slotDefinition: findSlotDefinition(owner.definitionNode, key), reference: nameNode };
      }
      return classSlotTarget(referent.classes, key, nameNode, table);
    }
    default:
      // A construct's own name, so hover works at the definition too.
      return ownConstructTarget(nameNode, context, table);
  }
}

/**
 * A construct's own name, so hover works at the definition too.
 *
 * @param nameNode - The name.
 * @param context - Its construct.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function ownConstructTarget(
  nameNode: SyntaxNode,
  context: SyntaxNode,
  table: SymbolTable
): HoverTarget | null {
  if (!context.type.endsWith('_construct')) return null;
  const entry = table.entries.find(
    (e) => e.definitionNode.id === context.id && e.nameNode.id === nameNode.id
  );
  return entry ? { kind: 'construct', entries: [entry], reference: nameNode } : null;
}

/**
 * A construct in an import/export item; `(export defglobal limit)` names `?*limit*`.
 *
 * @param constructType - The item's construct keyword.
 * @param name - The name.
 * @param reference - The node under the cursor.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function portItemTarget(constructType: string | undefined, name: string, reference: SyntaxNode, table: SymbolTable): HoverTarget | null {
  /** A construct target for an entry, or `null` if there is none. */
  const construct = (entry: SymbolEntry | undefined): HoverTarget | null =>
    entry ? { kind: 'construct', entries: [entry], reference } : null;
  switch (constructType) {
    case 'deftemplate':
      return construct(table.templates.get(name)) ?? externalTarget('deftemplate', name, reference, table);
    case 'defclass':
      return classTarget(name, reference, table);
    case 'defglobal':
      return construct(table.globals.get(`?*${name}*`)) ?? externalTarget('defglobal', `?*${name}*`, reference, table);
    case 'deffunction':
    case 'defgeneric': {
      const types = constructType === 'deffunction' ? ['deffunction_construct'] : ['defgeneric_construct', 'defmethod_construct'];
      const entries = (table.functionLike.get(name) ?? []).filter((e) => types.includes(e.definitionNode.type));
      return entries.length > 0 ? { kind: 'construct', entries, reference } : null;
    }
    default:
      return null;
  }
}

/**
 * A slot name in an LHS pattern.
 *
 * @param slotNameNode - The slot name.
 * @param slotNode - Its LHS slot node.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveSlotTarget(
  slotNameNode: SyntaxNode,
  slotNode: SyntaxNode,
  table: SymbolTable
): HoverTarget | null {
  if (slotNode.children.find((c) => c.type === 'name')?.id !== slotNameNode.id) return null;

  const context = resolveTemplateSlot(slotNode, table);
  if (!context) return null;

  return {
    kind: 'slot',
    owner: context.owner,
    slotName: context.slotName,
    slotDefinition: context.slotDefinition,
    reference: slotNameNode
  };
}

/**
 * A slot in `(modify ?f (age 4))`; the template comes from `?f`'s pattern.
 *
 * @param slotNameNode - The slot name.
 * @param slotNode - Its RHS slot node.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveRhsSlotTarget(
  slotNameNode: SyntaxNode,
  slotNode: SyntaxNode,
  table: SymbolTable
): HoverTarget | null {
  const factAction = slotNode.parent?.parent;
  if (factAction?.type !== 'fact_action') return null;

  const owner = resolveFactActionTemplate(factAction, table);
  if (!owner) return null;

  const slotName = nameKey(slotNameNode);
  return {
    kind: 'slot',
    owner,
    slotName,
    slotDefinition: findSlotDefinition(owner.definitionNode, slotName),
    reference: slotNameNode
  };
}

/**
 * A defclass or predefined class.
 *
 * @param name - The class name.
 * @param reference - The node under the cursor.
 * @param table - The lookup scope.
 * @returns The target, or `null` if the class is unknown.
 */
function classTarget(name: string, reference: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const entry = table.classes.get(name);
  if (entry) return { kind: 'construct', entries: [entry], reference };
  if (name in BUILTIN_CLASS_PARENTS) return { kind: 'builtinClass', name, reference };
  return externalTarget('defclass', name, reference, table);
}

/**
 * A name declared by `(defexternal <kind> <name>)`, the fallback when no
 * construct of that name exists.
 *
 * @param kind - What kind of name.
 * @param name - The name (a global with its `?*...*`).
 * @param reference - The node under the cursor.
 * @param table - The lookup scope.
 * @returns The target, or `null` if nothing declares it.
 */
function externalTarget(kind: ExternalKind, name: string, reference: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const external = table.externals.get(externalKey(kind, name));
  return external ? { kind: 'external', external, reference } : null;
}

/**
 * The name argument of a top-level `(defudf ...)` or `(defexternal ...)`
 * line, so hovering a declaration shows what it declares.
 *
 * @param constant - A constant.
 * @param table - The lookup scope (the declaration file's own names are in it).
 * @returns The target, or `null` if `constant` isn't such a name.
 */
function declarationLineTarget(constant: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const call = constant.parent;
  if (call?.type !== 'function_call' || call.parent?.type !== 'CLIPS_program') return null;
  const head = call.namedChildren[0]?.text;
  if (head === 'defudf' && call.namedChildren[1]?.id === constant.id) {
    const host = table.hostFunctions.get(constant.text);
    return host?.nameNode.id === constant.id ? { kind: 'hostFunction', host, reference: constant } : null;
  }
  if (head === 'defexternal' && call.namedChildren[2]?.id === constant.id) {
    const external = [...table.externals.values()].find((e) => e.nameNode.id === constant.id);
    return external ? { kind: 'external', external, reference: constant } : null;
  }
  return null;
}

/**
 * A class slot reached through known classes.
 *
 * @param classes - Candidate classes; `null` resolves nothing rather than guessing.
 * @param slotName - The slot name.
 * @param reference - The node under the cursor.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function classSlotTarget(
  classes: string[] | null,
  slotName: string,
  reference: SyntaxNode,
  table: SymbolTable
): HoverTarget | null {
  if (!classes || classes.length === 0) return null;
  const slot = findClassSlot(classes, slotName, table);
  if (!slot) return null;
  const className = classes.find((c) => findClassSlot([c], slotName, table)) ?? slot.owner.name;
  return { kind: 'classSlot', slot, className, reference };
}

/**
 * A module target; `MAIN` resolves without a defmodule.
 *
 * @param name - The module name.
 * @param reference - The node under the cursor.
 * @param table - The lookup scope.
 * @returns The target, or `null` if no such module exists.
 */
function moduleTarget(name: string, reference: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const entry = table.entries.find((e) => e.definitionNode.type === 'defmodule_construct' && e.name === name) ?? null;
  if (!entry && name !== 'MAIN') return null;
  return { kind: 'module', name, entry, reference };
}

/**
 * The module part of a qualified name, e.g. the `MAIN` in `MAIN::start`.
 *
 * @param symbolNode - The symbol at the position.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveModuleTarget(symbolNode: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const qualified = symbolNode.parent;
  if (qualified?.type !== 'qualified_name' || qualified.children[0]?.id !== symbolNode.id) return null;
  return moduleTarget(symbolNode.text, symbolNode, table);
}

/**
 * The message of a `send`: user handlers, a `get-`/`put-` accessor, or a
 * system handler. If the receiver's class is known, only handlers of its
 * subclasses and of all their superclasses count.
 *
 * @param constant - The message.
 * @param call - The `send` call.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveSendMessage(constant: SyntaxNode, call: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const message = constant.text;
  const receiver = call.namedChildren[1]?.firstChild;
  const classes = receiver && receiver.type === 'single_field_variable' ? (variableReferent(receiver, table)?.classes ?? []) : [];
  /** A class and the names of its ancestors. */
  const ancestors = (c: string) => [c, ...classAncestry(c, table).map((e) => e.name)];
  const receivers = [...classes, ...[...table.classes.keys()].filter((other) => classes.some((c) => ancestors(other).includes(c)))];
  const lineage = new Set(receivers.flatMap(ancestors));

  const handlers = allHandlers(table).filter((h) => h.name === message && (lineage.size === 0 || lineage.has(h.className)));
  if (handlers.length > 0) return { kind: 'construct', entries: handlers.map((h) => h.entry), reference: constant };

  const accessor = /^(?:get|put)-(.+)$/.exec(message);
  if (accessor) {
    const owners = classes.length > 0 ? classes : [...table.classes.keys()];
    const matches = owners
      .map((c) => ({ className: c, slot: classSlots(c, table).find((s) => s.name === accessor[1]) }))
      .filter((m) => m.slot && slotAccessors(m.slot).includes(message));
    // With an unknown receiver, only resolve if exactly one slot matches.
    const slots = new Set(matches.map((m) => m.slot!.node.id));
    if (matches.length > 0 && (classes.length > 0 || slots.size === 1)) {
      return { kind: 'classSlot', slot: matches[0].slot!, className: matches[0].className, reference: constant };
    }
  }

  return (SYSTEM_HANDLERS as readonly string[]).includes(message) ? { kind: 'systemHandler', name: message, reference: constant } : null;
}

/**
 * A class, template or slot passed to a built-in. A slot only resolves if
 * its class or template is a literal in the same call.
 *
 * @param constant - The argument.
 * @param table - The lookup scope.
 * @returns The target, or `null`.
 */
function resolveBuiltinArgument(constant: SyntaxNode, table: SymbolTable): HoverTarget | null {
  const argument = builtinArgumentAt(constant, table);
  if (!argument) return null;
  const name = constant.text;

  switch (argument.role) {
    case 'class':
      return classTarget(name, constant, table);
    case 'template': {
      const entry = table.templates.get(name);
      return entry ? { kind: 'construct', entries: [entry], reference: constant } : externalTarget('deftemplate', name, constant, table);
    }
    case 'module':
      return moduleTarget(name, constant, table);
    case 'slot': {
      if (argument.classLiteral) return classSlotTarget([argument.classLiteral], name, constant, table);
      const owner = argument.templateLiteral ? table.templates.get(argument.templateLiteral) : undefined;
      const slotDefinition = owner ? findSlotDefinition(owner.definitionNode, name) : null;
      return owner && slotDefinition ? { kind: 'slot', owner, slotName: name, slotDefinition, reference: constant } : null;
    }
    default:
      return null;
  }
}
