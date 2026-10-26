/**
 * @file Load graph checks on a small project: main.clp loads helpers.clp,
 * rules.clp and a missing file; other.clp is never loaded.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node.js';

/** The built server. */
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/** The program's files by name. */
const files = {
  'main.clp': `(load "helpers.clp")
(load "rules.clp")
(load "nope.clp")
`,
  'helpers.clp': `(deftemplate person
  (slot name))

(deffunction greet (?n)
  (printout t "hi " ?n crlf))

(defgeneric shout)
`,
  'rules.clp': `(deftemplate person
  (slot name)
  (slot age))

(deffunction shout () (printout t "HEY" crlf))

(defrule hello
  (person (name ?n))
  =>
  (greet ?n)
  (stray ?n))
`,
  'other.clp': `(deffunction stray (?x) ?x)

(deftemplate person
  (slot x))
`,
  'solo.clp': `(deffunction twice () 1)
(defgeneric twice)
`,
  'dyn.clp': `(load "helpers.clp")
(deffunction boot (?f) (load ?f))
(defrule go => (stray 1))
`,
  'loose.clp': `(defrule use-stray => (stray 1))
`
};

/** Temporary folder the files are written to. */
const dir = mkdtempSync(join(tmpdir(), 'clips-loads-'));
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
/**
 * URI of a file in the folder.
 *
 * @param name - The file name.
 * @returns The URI.
 */
const uriOf = (name) => pathToFileURL(join(dir, name)).href;

/** The server under test. */
const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));
/** JSON-RPC connection to the server. */
const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);
/** Latest diagnostics by URI. */
const latest = new Map();
connection.onNotification('textDocument/publishDiagnostics', (p) => latest.set(p.uri, p.diagnostics));
connection.listen();

/** Number of failed checks. */
let failures = 0;
/**
 * Records a check result.
 *
 * @param label - What is checked.
 * @param pass - Whether it passed.
 * @param detail - Printed on failure.
 */
function check(label, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${!pass && detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}
/**
 * Diagnostics of a file with the given code.
 *
 * @param name - The file name.
 * @param code - The code without `clips(...)`, e.g. `load-file-missing`.
 * @returns The diagnostics.
 */
const withCode = (name, code) => (latest.get(uriOf(name)) ?? []).filter((d) => d.code === `clips(${code})`);
/**
 * A file's diagnostics as text, for failure output.
 *
 * @param name - The file name.
 * @returns Codes and messages as JSON.
 */
const dump = (name) => JSON.stringify((latest.get(uriOf(name)) ?? []).map((d) => `${d.code}: ${d.message}`));

try {
  const folderUri = pathToFileURL(dir).href;
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: folderUri,
    workspaceFolders: [{ uri: folderUri, name: 'loads' }],
    capabilities: {}
  });
  await connection.sendNotification('initialized', {});
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the workspace index

  for (const [name, text] of Object.entries(files)) {
    connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri: uriOf(name), languageId: 'clips', version: 1, text }
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 700));

  const missing = withCode('main.clp', 'load-file-missing');
  check('missing load target is flagged', missing.length === 1 && missing[0].message.includes('"nope.clp"'), dump('main.clp'));

  const notLoaded = withCode('rules.clp', 'construct-not-loaded');
  check('function defined only in an unloaded file is flagged',
    notLoaded.length === 1 && notLoaded[0].message.includes('"stray"') && notLoaded[0].message.includes('other.clp'), dump('rules.clp'));
  check('function from a loaded file is not flagged', !notLoaded.some((d) => d.message.includes('"greet"')), dump('rules.clp'));

  const dupRules = withCode('rules.clp', 'duplicate-construct-across-files');
  check('same deftemplate in two loaded files is flagged, naming the slot difference',
    dupRules.length === 1 && dupRules[0].message.includes('helpers.clp') && dupRules[0].message.includes('different slots') && dupRules[0].message.includes('age'),
    dump('rules.clp'));
  check('...and the unloaded file defining it too is not mentioned', !dupRules.some((d) => d.message.includes('other.clp')), dump('rules.clp'));
  const dupHelpers = withCode('helpers.clp', 'duplicate-construct-across-files');
  check('the duplicate is flagged on the other side as well', dupHelpers.length === 1 && dupHelpers[0].message.includes('rules.clp'), dump('helpers.clp'));

  const conflictRules = withCode('rules.clp', 'function-generic-conflict');
  check('deffunction clashing with a defgeneric in a loaded file is an error',
    conflictRules.length === 1 && conflictRules[0].severity === 1 && conflictRules[0].message.includes('helpers.clp'), dump('rules.clp'));
  const conflictHelpers = withCode('helpers.clp', 'function-generic-conflict');
  check('...and on the defgeneric side', conflictHelpers.length === 1 && conflictHelpers[0].message.includes('rules.clp'), dump('helpers.clp'));

  check('a file outside any known program gets no cross-file warnings',
    withCode('other.clp', 'duplicate-construct-across-files').length === 0, dump('other.clp'));

  const solo = withCode('solo.clp', 'function-generic-conflict');
  check('deffunction/defgeneric clash within one file is an error (no load info needed)', solo.length === 2, dump('solo.clp'));

  check('a program with a computed load path gets no not-loaded warnings',
    withCode('dyn.clp', 'construct-not-loaded').length === 0, dump('dyn.clp'));

  // Hover names the defining file, and whether the load graph ties it to this one.
  /** Hover text at `needle` in a file. */
  const hoverAt = async (name, needle) => {
    const text = files[name];
    const index = text.indexOf(needle);
    const before = text.slice(0, index);
    const position = { line: before.split('\n').length - 1, character: index - before.lastIndexOf('\n') - 1 + 1 };
    const hover = await connection.sendRequest('textDocument/hover', { textDocument: { uri: uriOf(name) }, position });
    return hover?.contents?.value ?? '';
  };
  const greet = await hoverAt('rules.clp', 'greet ?n');
  check('hover: construct from a file of the same program has no load note',
    greet.includes('defined in `helpers.clp`') && !greet.includes('not loaded') && !greet.includes('not linked'), greet);
  const stray = await hoverAt('rules.clp', 'stray ?n');
  check('hover: construct from a file outside the program says so',
    stray.includes('defined in `other.clp` · not loaded by this file\'s program'), stray);
  const loose = await hoverAt('loose.clp', 'stray 1');
  check('hover: construct seen from a file with no load links says so',
    loose.includes('defined in `other.clp` · not linked to this file by any (load ...)'), loose);

  // Completion right after an opening paren: the call-head candidates.
  /** Completion items just after the `(` that starts `needle`. */
  const completeAfter = async (name, needle) => {
    const text = files[name];
    const index = text.indexOf(needle) + 1; // just past the '('
    const before = text.slice(0, index);
    const position = { line: before.split('\n').length - 1, character: index - before.lastIndexOf('\n') - 1 };
    const result = await connection.sendRequest('textDocument/completion', { textDocument: { uri: uriOf(name) }, position });
    return Array.isArray(result) ? result : (result?.items ?? []);
  };
  /** The items' labels. */
  const labels = (items) => items.map((i) => i.label);
  const inProgram = await completeAfter('rules.clp', '(greet ?n)');
  check('completion in a known program offers its other files\' constructs',
    labels(inProgram).includes('greet'), JSON.stringify(labels(inProgram).slice(0, 20)));
  check('completion in a known program leaves out files it does not load',
    !labels(inProgram).includes('twice') && !labels(inProgram).includes('boot'), JSON.stringify(labels(inProgram).slice(0, 20)));
  const unlinked = await completeAfter('loose.clp', '(stray 1)');
  const strayItem = unlinked.find((i) => i.label === 'stray');
  check('completion in an unlinked file labels other files\' constructs',
    strayItem?.detail?.includes('other.clp (not linked by any load)'), JSON.stringify(strayItem));
  connection.sendNotification('workspace/didChangeConfiguration', { settings: { clips: { completion: { unlinkedFiles: 'exclude' } } } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const excluded = await completeAfter('loose.clp', '(stray 1)');
  check('clips.completion.unlinkedFiles = exclude keeps only the file\'s own constructs',
    !labels(excluded).includes('stray') && !labels(excluded).includes('greet') && labels(excluded).includes('printout'),
    JSON.stringify(labels(excluded).slice(0, 20)));
  connection.sendNotification('workspace/didChangeConfiguration', { settings: { clips: { completion: { unlinkedFiles: 'include' } } } });

  await connection.sendRequest('shutdown');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await connection.sendNotification('exit');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall load checks passed');
  }
} catch (err) {
  console.error('load test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
