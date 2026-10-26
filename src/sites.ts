/**
 * @file Where ordered facts and instance names are created; go-to-definition
 * and hover point there.
 */

import type { SyntaxNode, Tree } from 'tree-sitter';
import { instanceDefinitionClass } from './classes.js';
import { nameKey } from './symbolTable.js';
import { uriKey } from './uri.js';

/**
 * An instance name without brackets.
 *
 * @param text - The name, with or without brackets.
 * @returns The bare name.
 */
export function instanceNameKey(text: string): string {
  return text.replace(/^\[/, '').replace(/\]$/, '');
}

/** A place that creates an instance under a literal name. */
export interface InstanceSite {
  /** The instance name. */
  nameNode: SyntaxNode;
  /** `null` for a duplicate-instance copy. */
  className: string | null;
  /** The source of `duplicate-instance [a] to [b]`. */
  copyOf: string | null;
}

/**
 * Whether a constant is the instance name before `of`.
 *
 * @param constant - A `constant` node.
 */
export function isInstanceSiteName(constant: SyntaxNode): boolean {
  const definition = constant.parent;
  if (definition?.type !== 'instance_definition') return false;
  const of = definition.children.findIndex((c) => c.type === 'of');
  return of > 0 && definition.children[of - 1].id === constant.id;
}

/**
 * Where instances are created under a literal name: `(S-1 of C)` and the
 * name after `to` in duplicate-instance.
 *
 * @param root - A document's root.
 * @returns The sites in document order.
 */
export function instanceSites(root: SyntaxNode): InstanceSite[] {
  const sites: InstanceSite[] = [];
  for (const definition of root.descendantsOfType('instance_definition')) {
    const of = definition.children.findIndex((c) => c.type === 'of');
    const nameNode = of > 0 ? definition.children[of - 1] : null;
    if (nameNode?.type !== 'constant') continue;
    sites.push({ nameNode, className: instanceDefinitionClass(definition)?.text ?? null, copyOf: null });
  }
  for (const action of root.descendantsOfType('instance_action')) {
    const to = action.children.findIndex((c) => c.type === 'to');
    const target = to > 0 ? action.children[to + 1] : null;
    if (target?.type !== 'constant') continue;
    const source = action.children.slice(0, to).reverse().find((c) => c.type === 'constant' || c.type === 'variable');
    sites.push({ nameNode: target, className: null, copyOf: source?.text ?? null });
  }
  return sites.sort((a, b) => a.nameNode.startIndex - b.nameNode.startIndex);
}

/**
 * Sites creating an instance of this name: the document's own if it has
 * any, otherwise other files'.
 *
 * @param name - The name without brackets.
 * @param uri - The current document.
 * @param documents - All indexed documents.
 * @returns The sites.
 */
export function instanceSitesFor(
  name: string,
  uri: string,
  documents: Iterable<{ uri: string; tree: Tree }>
): { uri: string; site: InstanceSite }[] {
  const here: { uri: string; site: InstanceSite }[] = [];
  const elsewhere: { uri: string; site: InstanceSite }[] = [];
  for (const doc of documents) {
    const own = uriKey(doc.uri) === uriKey(uri);
    for (const site of instanceSites(doc.tree.rootNode)) {
      if (instanceNameKey(site.nameNode.text) === name) (own ? here : elsewhere).push({ uri: doc.uri, site });
    }
  }
  return here.length > 0 ? here : elsewhere;
}

/**
 * Heads of asserted and deffacts facts with this name.
 *
 * @param name - The fact name.
 * @param root - A document's root.
 * @returns The head nodes.
 */
export function orderedFactSites(name: string, root: SyntaxNode): SyntaxNode[] {
  const sites: SyntaxNode[] = [];
  for (const pattern of root.descendantsOfType('ordered_RHS_pattern')) {
    const head = pattern.children.find((c) => c.type === 'name');
    if (head && nameKey(head) === name) sites.push(head);
  }
  return sites;
}

/** A field of an ordered fact: its literal text, or whether it may span several fields. */
interface OrderedField {
  /** The field's text if it is a literal, else `null`. */
  literal: string | null;
  /** May match several fields. */
  multi: boolean;
}

/**
 * Fields of an ordered pattern or fact. `$?`, `$?x` and, in an assert, a
 * function call can span several fields.
 *
 * @param fact - An ordered pattern or fact.
 * @returns The fields in order.
 */
function orderedFields(fact: SyntaxNode): OrderedField[] {
  const fields: OrderedField[] = [];
  for (const child of fact.namedChildren) {
    if (child.type === 'constraint') {
      const constants = child.descendantsOfType('constant');
      const literal = constants.length === 1 && constants[0].text === child.text ? child.text : null;
      fields.push({ literal, multi: child.text.startsWith('$?') });
    } else if (child.type === 'RHS_field') {
      const value = child.firstNamedChild;
      fields.push({
        literal: value?.type === 'constant' ? value.text : null,
        multi: value?.type === 'function_call' || value?.firstChild?.type === 'multifield_variable'
      });
    }
  }
  return fields;
}

/**
 * Whether two ordered facts can be the same. Literal fields are compared
 * from both ends up to the first multi-field one: `(pair $? 7)` matches
 * `(pair 1 7)` but not `(pair 1 8)`.
 *
 * @param a - An ordered pattern or fact.
 * @param b - An ordered fact.
 * @returns `false` only if they can never match.
 */
export function orderedFieldsCompatible(a: SyntaxNode, b: SyntaxNode): boolean {
  const fa = orderedFields(a);
  const fb = orderedFields(b);
  /** Two different literals. */
  const clash = (x: OrderedField, y: OrderedField) => x.literal !== null && y.literal !== null && x.literal !== y.literal;
  const n = Math.min(fa.length, fb.length);
  for (let i = 0; i < n && !fa[i].multi && !fb[i].multi; i++) {
    if (clash(fa[i], fb[i])) return false;
  }
  for (let i = 1; i <= n && !fa[fa.length - i].multi && !fb[fb.length - i].multi; i++) {
    if (clash(fa[fa.length - i], fb[fb.length - i])) return false;
  }
  /** Whether any of the fields can span several values. */
  const spans = (fields: OrderedField[]) => fields.some((f) => f.multi);
  return spans(fa) || spans(fb) || fa.length === fb.length;
}
