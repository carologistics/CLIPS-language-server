/**
 * @file Diagnostics for declaration files (.clpd): malformed lines, stray
 * calls, and declarations that are redundant, unused or dumped too late.
 */

import type { SyntaxNode, Tree } from 'tree-sitter';
import { DiagnosticSeverity, DiagnosticTag, type Diagnostic } from 'vscode-languageserver/node.js';
import { declarationHeader, externalKey, readExternals, readHostFunctions } from './declarations.js';
import { diag } from './lsp.js';
import type { SymbolTable } from './symbolTable.js';
import { displayName } from './uri.js';

/**
 * Checks for a .clpd file: malformed lines, stray calls, constructs a dump
 * shares with the .clp files (dump.clp ran too late), and hand-written
 * declarations that are redundant or unused. Hints carry
 * `data: { remove: true }` for the quick fix.
 *
 * @param tree - The file's tree.
 * @param table - Its symbol table.
 * @param described - The .clp documents it applies to.
 * @param dumps - Generated files covering the same documents.
 * @returns The diagnostics.
 */
export function collectDeclarationDiagnostics(
  tree: Tree,
  table: SymbolTable,
  described: { uri: string; tree: Tree; table: SymbolTable }[],
  dumps: { uri: string; table: SymbolTable }[] = []
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const problem of readHostFunctions(tree, '').problems) {
    out.push(diag(problem.node, problem.message, DiagnosticSeverity.Error, 'declaration-defudf'));
  }
  for (const problem of readExternals(tree, '').problems) {
    out.push(diag(problem.node, problem.message, DiagnosticSeverity.Error, 'declaration-defexternal'));
  }
  for (const call of tree.rootNode.namedChildren) {
    if (call.type !== 'function_call' || call.hasError) continue;
    const head = call.namedChildren[0];
    if (head?.type === 'function_name' && (head.text === 'defudf' || head.text === 'defexternal')) continue;
    out.push(
      diag(
        head?.type === 'function_name' ? head : call,
        'Only constructs, (defudf ...) and (defexternal ...) lines belong in a declaration file: nothing in it is run, so this call declares nothing',
        DiagnosticSeverity.Warning,
        'declaration-not-declaration'
      )
    );
  }

  const generated = declarationHeader(tree) !== null;
  // (defexternal deftemplate x) and (deftemplate x) declare the same name.
  const declared: { label: string; name: string; node: SyntaxNode; definedIn: (t: SymbolTable) => boolean }[] = [];
  /** Whether a table defines or declares template `name`. */
  const templateIn = (name: string) => (t: SymbolTable) => t.templates.has(name) || t.externals.has(externalKey('deftemplate', name));
  /** Whether a table defines or declares class `name`. */
  const classIn = (name: string) => (t: SymbolTable) => t.classes.has(name) || t.externals.has(externalKey('defclass', name));
  /** Whether a table defines or declares global `name`. */
  const globalIn = (name: string) => (t: SymbolTable) => t.globals.has(name) || t.externals.has(externalKey('defglobal', name));
  /** Whether a table defines function `name` or declares it with `defudf`. */
  const functionIn = (name: string) => (t: SymbolTable) => t.functionLike.has(name) || t.hostFunctions.has(name);
  for (const [name, entry] of table.templates) declared.push({ label: 'Deftemplate', name, node: entry.nameNode, definedIn: templateIn(name) });
  for (const [name, entry] of table.classes) declared.push({ label: 'Defclass', name, node: entry.nameNode, definedIn: classIn(name) });
  for (const [name, entry] of table.globals) declared.push({ label: 'Defglobal', name, node: entry.nameNode, definedIn: globalIn(name) });
  for (const [name, entries] of table.functionLike) declared.push({ label: 'Function', name, node: entries[0].nameNode, definedIn: functionIn(name) });
  for (const [name, host] of table.hostFunctions) declared.push({ label: 'Host function', name, node: host.nameNode, definedIn: functionIn(name) });
  for (const external of table.externals.values()) {
    const definedIn = external.kind === 'deftemplate' ? templateIn : external.kind === 'defclass' ? classIn : globalIn;
    declared.push({ label: external.kind[0].toUpperCase() + external.kind.slice(1), name: external.name, node: external.nameNode, definedIn: definedIn(external.name) });
  }

  const mentioned = new Set<string>();
  if (!generated) {
    for (const doc of described) {
      for (const leaf of doc.tree.rootNode.descendantsOfType(['symbol', 'global_variable'])) mentioned.add(leaf.text);
    }
  }

  const remove = { data: { remove: true }, tags: [DiagnosticTag.Unnecessary] };
  for (const { label, name, node, definedIn } of declared) {
    const files = [...new Set(described.filter((d) => definedIn(d.table)).map((d) => displayName(d.uri)))];
    if (files.length > 0) {
      const where = files.join(', ');
      out.push(
        generated
          ? diag(
              node,
              `${label} "${name}" is also defined in ${where}: dump.clp ran after the host loaded the user's .clp files, so this copy keeps it defined even if ${where} drops it. Run dump.clp before the host's Load calls, then run it again`,
              DiagnosticSeverity.Warning,
              'declaration-late-dump'
            )
          : diag(node, `${label} "${name}" is defined in ${where}; this declaration is not needed`, DiagnosticSeverity.Hint, 'declaration-redundant', remove)
      );
      continue;
    }
    if (generated) continue;
    const dump = dumps.find((d) => definedIn(d.table));
    if (dump) {
      out.push(diag(node, `${label} "${name}" is already in ${displayName(dump.uri)}, generated by dump.clp; this declaration is not needed`, DiagnosticSeverity.Hint, 'declaration-redundant', remove));
    } else if (!mentioned.has(name)) {
      out.push(diag(node, `${label} "${name}" is declared but no .clp file in this folder uses it`, DiagnosticSeverity.Hint, 'declaration-unused', remove));
    }
  }
  return out;
}
