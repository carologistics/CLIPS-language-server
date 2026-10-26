/**
 * @file Document outline and workspace symbol search.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node.js';

/** The built server. */
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/** Fixture with one construct of each kind. */
const src = `(deftemplate foo
  (slot bar)
  (multislot baz))

(defclass Animal
  (is-a USER)
  (slot name))

(defglobal ?*count* = 0)

(deffunction helper (?a ?b)
  (+ ?a ?b))

(defrule my-rule
  (foo (bar ?x))
  =>
  (helper ?x ?*count*))
`;

/** The server under test. */
const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));

/** JSON-RPC connection to the server. */
const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);
connection.listen();

/** Number of failed checks. */
let failures = 0;
/**
 * Records a check result.
 *
 * @param label - What is checked.
 * @param condition - Whether it passed.
 * @param detail - Printed after the label.
 */
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures++;
}

try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  await connection.sendNotification('initialized', {});

  const uri = 'file:///symbols.clp';
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'clips', version: 1, text: src }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const symbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri } });
  const names = symbols.map((s) => s.name);
  console.log('top-level symbols:', names);

  check('5 top-level symbols (foo, Animal, ?*count*, helper, my-rule)', symbols.length === 5, JSON.stringify(names));
  check('USER (superclass) does NOT leak in as a top-level symbol', !names.includes('USER'));

  const fooSymbol = symbols.find((s) => s.name === 'foo');
  check('foo has 2 nested slot children (bar, baz)',
    fooSymbol?.children?.length === 2 && fooSymbol.children.map((c) => c.name).join(',') === 'bar,baz',
    JSON.stringify(fooSymbol?.children?.map((c) => c.name)));

  const animalSymbol = symbols.find((s) => s.name === 'Animal');
  check('Animal has exactly 1 nested slot child (name), not USER',
    animalSymbol?.children?.length === 1 && animalSymbol.children[0].name === 'name',
    JSON.stringify(animalSymbol?.children?.map((c) => c.name)));

  const allWorkspaceSymbols = await connection.sendRequest('workspace/symbol', { query: '' });
  check('workspace/symbol with empty query returns all entries (including nested slots)',
    allWorkspaceSymbols.length === 8, `got ${allWorkspaceSymbols.length}: ${JSON.stringify(allWorkspaceSymbols.map((s) => s.name))}`);

  const filtered = await connection.sendRequest('workspace/symbol', { query: 'help' });
  check('workspace/symbol filters by query substring',
    filtered.length === 1 && filtered[0].name === 'helper', JSON.stringify(filtered.map((s) => s.name)));

  // Constructs whose name was deleted get an empty MISSING name. VS Code
  // rejects the whole outline if any symbol name is empty.
  const namelessUri = 'file:///nameless.clp';
  const namelessSrc = [
    '(deftemplate \n  (slot slot-name))',
    '(deffunction  ()\n  )',
    '(defclass  (is-a USER)\n  (slot slot-name))',
    '(deffacts \n  )',
    '(defmodule \n  (export ?ALL))',
    '(defgeneric )',
    '(defmethod  ()\n  )',
    '(definstances \n  ([instance] of class))',
    '(deftemplate kept (slot a))'
  ].join('\n');
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: namelessUri, languageId: 'clips', version: 1, text: namelessSrc }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const namelessSymbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri: namelessUri } });
  const flat = namelessSymbols.flatMap((s) => [s, ...(s.children ?? [])]);
  check('constructs with a deleted name produce no empty symbol names',
    flat.length > 0 && flat.every((s) => s.name), JSON.stringify(flat.map((s) => s.name)));
  check('a named construct after them is still listed', namelessSymbols.some((s) => s.name === 'kept'),
    JSON.stringify(namelessSymbols.map((s) => s.name)));

  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall symbol checks passed');
  }
} catch (err) {
  console.error('symbols test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
}
