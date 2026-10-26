/**
 * @file COOL helpers: class slots including inherited ones, accessors and
 * message handlers, and whether a variable refers to a fact or an instance.
 */

import type { SyntaxNode } from 'tree-sitter';
import { findLocalDefinitions } from './locals.js';
import { nameKey, type SymbolEntry, type SymbolTable } from './symbolTable.js';

/** Handlers CLIPS defines on `USER` (msgcom.h, insmoddp.h). */
export const SYSTEM_HANDLERS = [
  'init',
  'delete',
  'print',
  'create',
  'direct-modify',
  'message-modify',
  'direct-duplicate',
  'message-duplicate'
] as const;

/**
 * Predefined classes and their direct superclasses, as reported by
 * `class-superclasses` in CLIPS 6.4.2. `INITIAL-OBJECT` no longer exists.
 */
export const BUILTIN_CLASS_PARENTS: Record<string, string[]> = {
  OBJECT: [],
  PRIMITIVE: ['OBJECT'],
  USER: ['OBJECT'],
  NUMBER: ['PRIMITIVE'],
  INTEGER: ['NUMBER'],
  FLOAT: ['NUMBER'],
  LEXEME: ['PRIMITIVE'],
  SYMBOL: ['LEXEME'],
  STRING: ['LEXEME'],
  MULTIFIELD: ['PRIMITIVE'],
  ADDRESS: ['PRIMITIVE'],
  'EXTERNAL-ADDRESS': ['ADDRESS'],
  'FACT-ADDRESS': ['ADDRESS'],
  'INSTANCE-ADDRESS': ['INSTANCE', 'ADDRESS'],
  INSTANCE: ['PRIMITIVE'],
  'INSTANCE-NAME': ['INSTANCE']
};

/** Predefined COOL classes. */
export const BUILTIN_CLASSES = new Set(Object.keys(BUILTIN_CLASS_PARENTS));

/** A class slot, from the nearest class that declares it. */
export interface ClassSlot {
  /** Slot name. */
  name: string;
  /** The `slot` node in the declaring `defclass`. */
  node: SyntaxNode;
  /** The declaring class. */
  owner: SymbolEntry;
}

/**
 * Whether a name in a defclass is a superclass: the names after `is-a`,
 * up to its `)`.
 *
 * @param nameNode - A `name` child of the defclass.
 * @param defclassNode - The `defclass_construct`.
 * @returns `true` for a superclass, `false` for the class's own name.
 */
export function isDefclassSuperclassName(nameNode: SyntaxNode, defclassNode: SyntaxNode): boolean {
  let seenIsA = false;
  for (const child of defclassNode.children) {
    if (!seenIsA) {
      if (child.type === 'is-a') seenIsA = true;
      continue;
    }
    if (child.type === ')') break;
    if (child.id === nameNode.id) return true;
  }
  return false;
}

/**
 * Direct superclasses of a `defclass`.
 *
 * @param defclass - A `defclass_construct` node.
 * @returns The superclass names.
 */
function superclassNames(defclass: SyntaxNode): string[] {
  return defclass.children
    .filter((c) => c.type === 'name' && isDefclassSuperclassName(c, defclass))
    .map((c) => nameKey(c));
}

/**
 * The class and its user-defined ancestors, nearest first.
 *
 * @param className - The class name.
 * @param scope - The lookup scope.
 * @returns Their entries; built-in classes have none.
 */
export function classAncestry(className: string, scope: SymbolTable): SymbolEntry[] {
  const result: SymbolEntry[] = [];
  const seen = new Set<string>();
  const queue = [className];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = scope.classes.get(name);
    if (!entry) continue;
    result.push(entry);
    queue.push(...superclassNames(entry.definitionNode));
  }
  return result;
}

/**
 * The class's own `role` or `pattern-match` setting.
 *
 * @param defclass - A `defclass_construct` node.
 * @param facet - The setting to read.
 * @returns The value, or `null` if the class doesn't declare it.
 */
function classFacet(defclass: SyntaxNode, facet: 'role' | 'pattern-match'): string | null {
  for (const child of defclass.children) {
    const match = new RegExp(`^\\(\\s*${facet}\\s+([\\w-]+)\\s*\\)$`).exec(child.text);
    if (match) return match[1];
  }
  return null;
}

/**
 * Whether instances can be created. `role` comes from the nearest class
 * that declares it; without one the class is concrete (USER being abstract
 * is not inherited).
 *
 * @param className - The class name.
 * @param scope - The lookup scope.
 */
export function isConcreteClass(className: string, scope: SymbolTable): boolean {
  for (const entry of classAncestry(className, scope)) {
    const role = classFacet(entry.definitionNode, 'role');
    if (role) return role === 'concrete';
  }
  return true;
}

/**
 * Whether instances take part in pattern matching. Reactive by default; an
 * abstract class is not ([CLASSPSR1]), and neither are its concrete
 * subclasses unless they declare `(pattern-match reactive)`.
 *
 * @param className - The class name.
 * @param scope - The lookup scope.
 */
export function isReactiveClass(className: string, scope: SymbolTable): boolean {
  for (const entry of classAncestry(className, scope)) {
    const setting = classFacet(entry.definitionNode, 'pattern-match');
    if (setting) return setting === 'reactive';
    if (classFacet(entry.definitionNode, 'role') === 'abstract') return false;
  }
  return true;
}

/**
 * Whether `(is-a <class>)` can match: the class or a subclass must be
 * concrete and reactive, otherwise CLIPS rejects the rule ([OBJRTBLD1/2]).
 *
 * @param className - The class name.
 * @param scope - The lookup scope.
 */
export function isMatchableClass(className: string, scope: SymbolTable): boolean {
  const candidates =
    className === 'USER' || className === 'OBJECT'
      ? [...scope.classes.keys()]
      : [...scope.classes.keys()].filter((c) => classAncestry(c, scope).some((e) => e.name === className));
  return candidates.some((c) => isConcreteClass(c, scope) && isReactiveClass(c, scope));
}

/**
 * Own and inherited slots, each from the nearest class that declares it.
 *
 * @param className - The class name.
 * @param scope - The lookup scope.
 * @returns The slots.
 */
export function classSlots(className: string, scope: SymbolTable): ClassSlot[] {
  const slots = new Map<string, ClassSlot>();
  for (const owner of classAncestry(className, scope)) {
    for (const node of owner.definitionNode.children) {
      if (node.type !== 'slot') continue;
      const nameNode = node.children.find((c) => c.type === 'name');
      if (!nameNode) continue;
      const name = nameKey(nameNode);
      if (!slots.has(name)) slots.set(name, { name, node, owner });
    }
  }
  return [...slots.values()];
}

/**
 * `get-`/`put-` handlers per the `create-accessor` facet; both if it is absent.
 *
 * @param slot - The slot.
 * @returns The handler names.
 */
export function slotAccessors(slot: ClassSlot): string[] {
  const facet = slot.node.descendantsOfType('create_accessor_facet')[0];
  const value = facet
    ? facet.children.find((c) => /^(read|write|read-write|\?NONE)$/.test(c.type))?.type
    : 'read-write';
  const accessors: string[] = [];
  if (value === 'read' || value === 'read-write') accessors.push(`get-${slot.name}`);
  if (value === 'write' || value === 'read-write') accessors.push(`put-${slot.name}`);
  return accessors;
}

/** A user-defined message handler. */
export interface Handler {
  /** Message name. */
  name: string;
  /** The class it belongs to. */
  className: string;
  /** The `defmessage-handler` entry. */
  entry: SymbolEntry;
}

/**
 * Every `defmessage-handler` in scope.
 *
 * @param scope - The lookup scope.
 * @returns The handlers with their classes.
 */
export function allHandlers(scope: SymbolTable): Handler[] {
  const handlers: Handler[] = [];
  for (const entry of scope.entries) {
    if (entry.definitionNode.type !== 'defmessage_handler_construct') continue;
    const classNode = entry.definitionNode.children.find((c) => c.type === 'name');
    if (!classNode) continue;
    handlers.push({ name: entry.name, className: nameKey(classNode), entry });
  }
  return handlers;
}

/** Templates and classes a variable's fact or instance can belong to. */
export interface VariableReferent {
  /** Possible templates, for a fact. */
  templates: SymbolEntry[];
  /** Possible class names, for an instance. */
  classes: string[];
}

/**
 * Classes named in an object pattern's `(is-a ...)`.
 *
 * @param objectPattern - An `object_pattern_CE` node.
 * @returns The class names; empty if there is no `is-a`.
 */
export function objectPatternClasses(objectPattern: SyntaxNode): string[] {
  const names: string[] = [];
  for (const attribute of objectPattern.children) {
    if (attribute.type !== 'attribute_constraint' || attribute.children[1]?.type !== 'is-a') continue;
    for (const constant of attribute.descendantsOfType('constant')) {
      if (constant.firstChild?.type === 'symbol') names.push(constant.text);
    }
  }
  return names;
}

/**
 * What a variable refers to, from where it is bound: `?f <- (pattern)`, a
 * query set member, `(name ?x)` in an object pattern, or `?self`.
 *
 * @param variable - A variable node, or the symbol inside `?x:slot`.
 * @param scope - The lookup scope.
 * @returns The referent, or `null` if unknown (a parameter, a bind target, ...).
 */
export function variableReferent(variable: SyntaxNode, scope: SymbolTable): VariableReferent | null {
  const name = variable.text.replace(/^\$?\?/, '');
  if (name === 'self') {
    for (let a: SyntaxNode | null = variable; a; a = a.parent) {
      if (a.type !== 'defmessage_handler_construct') continue;
      const classNode = a.children.find((c) => c.type === 'name');
      return classNode ? { templates: [], classes: [nameKey(classNode)] } : null;
    }
    return null;
  }

  const templates: SymbolEntry[] = [];
  const classes: string[] = [];
  for (const binding of findLocalDefinitions(variable)) {
    const site = binding.parent;
    if (site?.type === 'assigned_pattern_CE') {
      const pattern = site.children.find((c) => c.type === 'pattern_CE')?.firstChild;
      if (pattern?.type === 'object_pattern_CE') {
        classes.push(...objectPatternClasses(pattern));
      } else if (pattern) {
        const head = pattern.children.find((c) => c.type === 'name');
        const template = head ? scope.templates.get(nameKey(head)) : undefined;
        if (template) templates.push(template);
      }
    } else if (site?.type === 'fact_set_member_template') {
      for (const nameNode of site.children.filter((c) => c.type === 'name')) {
        const template = scope.templates.get(nameKey(nameNode));
        if (template) templates.push(template);
      }
    } else if (site?.type === 'instance_set_member_template') {
      classes.push(...site.children.filter((c) => c.type === 'name').map((c) => nameKey(c)));
    } else if (site?.type === 'term') {
      // (object (is-a Warehouse) (name ?x)): ?x is the instance's name.
      let attribute: SyntaxNode | null = site;
      while (attribute && CONSTRAINT_WRAPPERS.has(attribute.type)) attribute = attribute.parent;
      if (attribute?.type === 'attribute_constraint' && attribute.children[1]?.type === 'name' && attribute.parent?.type === 'object_pattern_CE') {
        classes.push(...objectPatternClasses(attribute.parent));
      }
    }
  }
  if (templates.length === 0 && classes.length === 0) return null;
  return { templates: [...new Set(templates)], classes: [...new Set(classes)] };
}

// Class slot references

/** Nodes between a constant and the slot or attribute it constrains. */
const CONSTRAINT_WRAPPERS = new Set(['term', 'single_constraint', 'connected_constraint', 'constraint']);

/**
 * The LHS slot or object attribute a constant constrains, going up through
 * `?x&red|blue` syntax only. Inside a predicate call this returns the call.
 *
 * @param constant - A `constant` node.
 * @returns The first ancestor that is not constraint syntax.
 */
export function constrainedBy(constant: SyntaxNode): SyntaxNode | null {
  let a = constant.parent;
  while (a && CONSTRAINT_WRAPPERS.has(a.type)) a = a.parent;
  return a;
}

/**
 * Whether the constant is a class in an object pattern's `(is-a ...)`.
 *
 * @param constant - A `constant` node.
 */
export function isObjectPatternClass(constant: SyntaxNode): boolean {
  const owner = constrainedBy(constant);
  return owner?.type === 'attribute_constraint' && owner.children[1]?.type === 'is-a';
}

/**
 * Classes of an object pattern attribute.
 *
 * @param attribute - An `attribute_constraint` node.
 * @returns The classes, or `null` if the pattern names none.
 */
export function attributeClasses(attribute: SyntaxNode): string[] | null {
  const pattern = attribute.parent;
  const classes = pattern?.type === 'object_pattern_CE' ? objectPatternClasses(pattern) : [];
  return classes.length > 0 ? classes : null;
}

/**
 * Classes of a slot override: the class after `of`, or the class of the
 * instance variable a `modify-instance`-style call changes.
 *
 * @param slotOverride - A `slot_override` node.
 * @param scope - The lookup scope.
 * @returns The classes, or `null` if unknown.
 */
export function slotOverrideClasses(slotOverride: SyntaxNode, scope: SymbolTable): string[] | null {
  const owner = slotOverride.parent;
  if (owner?.type === 'instance_definition') {
    const className = instanceDefinitionClass(owner);
    return className ? [className.text] : null;
  }
  if (owner?.type === 'instance_action') {
    const target = owner.namedChildren.find((c) => c.type === 'variable')?.firstChild;
    const classes = target ? variableReferent(target, scope)?.classes : null;
    return classes && classes.length > 0 ? classes : null;
  }
  return null;
}

/**
 * The class after `of`. The instance name is optional, so this isn't
 * always the second constant.
 *
 * @param instanceDefinition - An `instance_definition` node.
 * @returns The class constant, or `null`.
 */
export function instanceDefinitionClass(instanceDefinition: SyntaxNode): SyntaxNode | null {
  const of = instanceDefinition.children.findIndex((c) => c.type === 'of');
  const className = of >= 0 ? instanceDefinition.children[of + 1] : null;
  return className?.type === 'constant' ? className : null;
}

/**
 * A slot from the first of `classes` that has it.
 *
 * @param classes - The classes to search; all classes in scope if `null`.
 * @param slotName - The slot name.
 * @param scope - The lookup scope.
 * @returns The slot, or `null`.
 */
export function findClassSlot(classes: string[] | null, slotName: string, scope: SymbolTable): ClassSlot | null {
  for (const className of classes ?? [...scope.classes.keys()]) {
    const slot = classSlots(className, scope).find((s) => s.name === slotName);
    if (slot) return slot;
  }
  return null;
}
