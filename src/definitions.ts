/**
 * @file Go-to-definition: constructs through {@link resolveTarget}, ordered
 * facts and instance names through the places that create them.
 */

import type { Tree } from 'tree-sitter';
import type { Location, Position } from 'vscode-languageserver/node.js';
import { toLocation } from './lsp.js';
import { instanceSitesFor, orderedFactSites, orderedFieldsCompatible } from './sites.js';
import type { SymbolTable } from './symbolTable.js';
import { resolveTarget } from './targets.js';
import { uriKey } from './uri.js';

/**
 * Go to definition.
 *
 * @param tree - The document's tree.
 * @param table - The lookup scope.
 * @param uri - The document's URI.
 * @param position - The position.
 * @param documents - Documents searched for asserts of ordered facts.
 * @returns The locations, or `null`.
 */
export function provideDefinition(
  tree: Tree,
  table: SymbolTable,
  uri: string,
  position: Position,
  documents: Iterable<{ uri: string; tree: Tree }> = [{ uri, tree }]
): Location[] | null {
  const target = resolveTarget(tree, table, position);
  if (!target) return null;

  switch (target.kind) {
    case 'construct': {
      // Don't jump to the definition the cursor is already on.
      const locations = target.entries
        .filter((e) => e.nameNode.id !== target.reference.id)
        .map((e) => toLocation(e.uri, e.nameNode));
      return locations.length > 0 ? locations : null;
    }
    case 'local':
      return target.bindings.map((n) => toLocation(uri, n));
    case 'slot': {
      if (!target.slotDefinition) return null;
      const nameChild = target.slotDefinition.children.find((c) => c.type === 'name');
      return nameChild ? [toLocation(target.owner.uri, nameChild)] : null;
    }
    case 'builtin':
      return null;
    case 'hostFunction':
      // Its defudf line, unless we're on it.
      return target.host.nameNode.id === target.reference.parent?.id ? null : [toLocation(target.host.uri, target.host.nameNode)];
    case 'external': {
      // Its defexternal line, unless we're on it.
      const node = target.external.nameNode;
      const onIt = node.id === target.reference.id || node.id === target.reference.parent?.id;
      return onIt ? null : [toLocation(target.external.uri, node)];
    }
    case 'orderedFact': {
      // Jump to asserts whose literal fields could match: (phase match) is
      // never created by (assert (phase expand-any)). This file's asserts
      // first; other files only if this file has none, and never from an
      // assert itself, since other files are usually unrelated programs.
      const pattern = target.reference.parent;
      const fromAssert = pattern?.type === 'ordered_RHS_pattern';
      const here: Location[] = [];
      const elsewhere: Location[] = [];
      for (const doc of documents) {
        const own = uriKey(doc.uri) === uriKey(uri);
        for (const site of orderedFactSites(target.name, doc.tree.rootNode)) {
          if (site.id === target.reference.id) continue;
          if (pattern && site.parent && !orderedFieldsCompatible(pattern, site.parent)) continue;
          (own ? here : elsewhere).push(toLocation(doc.uri, site));
        }
      }
      const locations = here.length > 0 || fromAssert ? here : elsewhere;
      return locations.length > 0 ? locations : null;
    }
    case 'module':
      return target.entry && target.entry.nameNode.id !== target.reference.id
        ? [toLocation(target.entry.uri, target.entry.nameNode)]
        : null;
    case 'classSlot': {
      const nameChild = target.slot.node.children.find((c) => c.type === 'name');
      return nameChild ? [toLocation(target.slot.owner.uri, nameChild)] : null;
    }
    case 'patternAttribute':
    case 'builtinClass':
    case 'systemHandler':
      return null;
    case 'instanceName': {
      const sites = instanceSitesFor(target.name, uri, documents).filter((s) => s.site.nameNode.id !== target.reference.parent?.id);
      return sites.length > 0 ? sites.map((s) => toLocation(s.uri, s.site.nameNode)) : null;
    }
  }
}
