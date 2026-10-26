/**
 * @file Document outline and workspace symbol search, built from a
 * {@link SymbolTable}.
 */

import type { SyntaxNode } from 'tree-sitter';
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver/node.js';
import { toRange } from './lsp.js';
import type { SymbolTable } from './symbolTable.js';

/** Constructs shown at the top level of the outline; slots are nested under them. */
const CONTAINER_TYPES = new Set([
  'deftemplate_construct',
  'defrule_construct',
  'deffunction_construct',
  'defgeneric_construct',
  'defmethod_construct',
  'defclass_construct',
  'defmodule_construct',
  'deffacts_construct',
  'definstances_construct',
  'defglobal_construct',
  'defmessage_handler_construct'
]);

/**
 * Sorts symbols in document order; query matches aren't always in that order.
 *
 * @param a - First symbol.
 * @param b - Second symbol.
 * @returns A comparator result.
 */
function byPosition(a: DocumentSymbol, b: DocumentSymbol): number {
  return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}

/**
 * Builds the outline: one symbol per construct, slots nested under the
 * construct that contains them, all in document order.
 *
 * @param table - The document's symbol table.
 * @returns The outline.
 */
export function toDocumentSymbols(table: SymbolTable): DocumentSymbol[] {
  const containers = new Map<number, DocumentSymbol>();
  const topLevel: DocumentSymbol[] = [];

  for (const entry of table.entries) {
    if (!CONTAINER_TYPES.has(entry.definitionNode.type)) continue;
    const symbol: DocumentSymbol = {
      name: entry.name,
      kind: entry.kind,
      range: toRange(entry.definitionNode),
      selectionRange: toRange(entry.nameNode),
      children: []
    };
    containers.set(entry.definitionNode.startIndex, symbol);
    topLevel.push(symbol);
  }

  for (const entry of table.entries) {
    if (CONTAINER_TYPES.has(entry.definitionNode.type)) continue;

    let ancestor: SyntaxNode | null = entry.definitionNode.parent;
    while (ancestor) {
      const container = containers.get(ancestor.startIndex);
      if (container) {
        container.children!.push({
          name: entry.name,
          kind: entry.kind,
          range: toRange(entry.definitionNode),
          selectionRange: toRange(entry.nameNode)
        });
        break;
      }
      ancestor = ancestor.parent;
    }
  }

  topLevel.sort(byPosition);
  for (const container of containers.values()) {
    container.children?.sort(byPosition);
  }

  return topLevel;
}

/**
 * Workspace symbol search: case-insensitive substring match over all
 * entries, slots included.
 *
 * @param tables - Symbol tables of all indexed documents.
 * @param query - The search text; empty matches everything.
 * @returns The matching symbols.
 */
export function searchWorkspaceSymbols(
  tables: Iterable<SymbolTable>,
  query: string
): SymbolInformation[] {
  const needle = query.toLowerCase();
  const results: SymbolInformation[] = [];

  for (const table of tables) {
    for (const entry of table.entries) {
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      results.push({
        name: entry.name,
        kind: entry.kind,
        location: { uri: entry.uri, range: toRange(entry.nameNode) }
      });
    }
  }

  return results;
}
