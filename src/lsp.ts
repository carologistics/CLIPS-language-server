/**
 * @file Tree-sitter nodes as LSP ranges, locations and diagnostics.
 */

import type { SyntaxNode } from 'tree-sitter';
import type {
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  Location,
  Range
} from 'vscode-languageserver/node.js';

/**
 * The range of a node.
 *
 * @param node - The node.
 * @returns Its LSP range.
 */
export function toRange(node: SyntaxNode): Range {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column }
  };
}

/**
 * A location for a node.
 *
 * @param uri - The node's document.
 * @param node - The node.
 * @returns The location.
 */
export function toLocation(uri: string, node: SyntaxNode): Location {
  return { uri, range: toRange(node) };
}

/**
 * A diagnostic with source `clips` and code `clips(<code>)`.
 *
 * @param node - Where to report it.
 * @param message - The message.
 * @param severity - The severity.
 * @param code - The code, e.g. `slot-unknown`.
 * @param extra - Further fields.
 * @returns The diagnostic.
 */
export function diag(
  node: SyntaxNode,
  message: string,
  severity: DiagnosticSeverity,
  code: string,
  extra: Partial<Diagnostic> = {}
): Diagnostic {
  return { range: toRange(node), message, severity, code: `clips(${code})`, source: 'clips', ...extra };
}

/**
 * Related information pointing at one node.
 *
 * @param uri - The node's document.
 * @param node - The node.
 * @param message - The message.
 * @returns A one-element list.
 */
export function relatedAt(uri: string, node: SyntaxNode, message: string): DiagnosticRelatedInformation[] {
  return [{ location: { uri, range: toRange(node) }, message }];
}
