/**
 * @file Multi-file support. Only rules.clp is opened; what it uses is in the
 * unopened templates.clp. Opened documents use VS Code's URI spelling and
 * the folder uses Node's, as in a real session on Windows.
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

/** Defines what `rules.clp` uses. */
const templatesSrc = `(deftemplate person
  (slot name)
  (slot age (type INTEGER)))

(defglobal ?*limit* = 10)

(deffunction greet (?who)
  (printout t "hi " ?who crlf))
`;

/** Uses the definitions in `templates.clp`, and one that exists nowhere. */
const rulesSrc = `(defrule welcome
  (person (name ?n))
  =>
  (greet ?n)
  (helper-x)
  (printout t ?*limit* crlf))
`;

/**
 * VS Code's spelling of a file URI: lowercase drive letter, encoded colon.
 *
 * @param path - An absolute path.
 * @returns The URI.
 */
function vscodeUri(path) {
  const forward = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(.*)$/.exec(forward);
  if (!drive) return pathToFileURL(path).href;
  const rest = drive[2].split('/').map(encodeURIComponent).join('/');
  return `file:///${drive[1].toLowerCase()}%3A${rest}`;
}

/**
 * Compares two file URIs by the file they name, ignoring spelling.
 *
 * @param a - A file URI.
 * @param b - Another file URI.
 * @returns Whether they name the same file.
 */
function sameFile(a, b) {
  return fileURLToPath(a).toLowerCase() === fileURLToPath(b).toLowerCase();
}

/**
 * The position of the `occurrence`-th `needle` in `src`.
 *
 * @param src - The text.
 * @param needle - Text to find.
 * @param occurrence - Which match, 0-based.
 * @returns The LSP position.
 */
function position(src, needle, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = src.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`needle not found: "${needle}" (occurrence ${occurrence})`);
  }
  const before = src.slice(0, index);
  return { line: (before.match(/\n/g) ?? []).length, character: index - before.lastIndexOf('\n') - 1 };
}

/**
 * The text of a single-line range.
 *
 * @param src - The text.
 * @param range - The range.
 * @returns The covered text.
 */
function rangeText(src, range) {
  return src.split('\n')[range.start.line].slice(range.start.character, range.end.character);
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param ms - The delay.
 * @returns The promise.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for indexing plus the server's 250 ms revalidation debounce. */
const SETTLE_MS = 700;

/** A file that is never opened and has a problem of its own, for the diagnostics-scope checks. */
const extraSrc = `(defrule lonely
  =>
  (no-such-fn))
`;

/**
 * Two unrelated files defining the same deffunction with different arity
 * (a copy of a program next to the original). An arity check in the open
 * one must use its own definition, not give up on the ambiguity.
 */
const tallySrc = `(deffunction tally (?a) ?a)
`;
/** A copy of `tally.clp` with a different arity, see {@link tallySrc}. */
const tallyCopySrc = `(deffunction tally (?a ?b) (+ ?a ?b))

(deffunction use-tally ()
  (tally 1))
`;

/** Temporary workspace folder. */
const dir = mkdtempSync(join(tmpdir(), 'clips-ws-'));
// The fixture files.
const templatesPath = join(dir, 'templates.clp');
const rulesPath = join(dir, 'rules.clp');
const extraPath = join(dir, 'extra.clp');
const tallyPath = join(dir, 'tally.clp');
const tallyCopyPath = join(dir, 'tally-copy.clp');
writeFileSync(templatesPath, templatesSrc);
writeFileSync(rulesPath, rulesSrc);
writeFileSync(extraPath, extraSrc);
writeFileSync(tallyPath, tallySrc);
writeFileSync(tallyCopyPath, tallyCopySrc);

/** Node's spelling of the folder URI, as the workspace scan sees it. */
const folderUri = pathToFileURL(dir).href;
/** VS Code's spelling of `rules.clp`, as an open editor reports it. */
const rulesUri = vscodeUri(rulesPath);
/** VS Code's spelling of `templates.clp`. */
const templatesUri = vscodeUri(templatesPath);

/** The server under test. */
const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));
/** JSON-RPC connection to the server. */
const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);

/** Latest diagnostics by URI as published. */
const latestDiagnostics = new Map();
connection.onNotification('textDocument/publishDiagnostics', (p) => latestDiagnostics.set(p.uri, p.diagnostics));

/** Stand in for the editor's settings: the server pulls `clips` via workspace/configuration. */
let diagnosticsScope = 'openFiles';
connection.onRequest('workspace/configuration', (p) =>
  p.items.map(() => ({ diagnostics: { scope: diagnosticsScope } }))
);
connection.onRequest('client/registerCapability', () => null);
/**
 * Changes the `clips.diagnostics.scope` setting and waits for the server.
 *
 * @param scope - The new scope.
 */
async function setScope(scope) {
  diagnosticsScope = scope;
  connection.sendNotification('workspace/didChangeConfiguration', { settings: null });
  await sleep(SETTLE_MS);
}
connection.listen();

/**
 * Latest diagnostic messages for a file, whichever URI spelling the server published under.
 *
 * @param path - The file's path.
 * @returns The messages.
 */
function messagesForFile(path) {
  const messages = [];
  for (const [uri, diagnostics] of latestDiagnostics) {
    if (sameFile(uri, pathToFileURL(path).href)) messages.push(...diagnostics.map((d) => d.message));
  }
  return messages;
}

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
 * Latest diagnostic messages published for exactly this URI.
 *
 * @param uri - The URI.
 * @returns The messages.
 */
const messagesFor = (uri) => (latestDiagnostics.get(uri) ?? []).map((d) => d.message);
/**
 * Whether a message published for `uri` contains `text`.
 *
 * @param uri - The URI.
 * @param text - The text.
 */
const mentions = (uri, text) => messagesFor(uri).some((m) => m.includes(text));

try {
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: folderUri,
    workspaceFolders: [{ uri: folderUri, name: 'ws' }],
    capabilities: {
      workspace: {
        workspaceFolders: true,
        configuration: true,
        didChangeConfiguration: { dynamicRegistration: true }
      }
    }
  });
  await connection.sendNotification('initialized', {});

  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: rulesUri, languageId: 'clips', version: 1, text: rulesSrc }
  });
  await sleep(SETTLE_MS);

  // 1. Cross-file references resolve for diagnostics.
  check('template from unopened file is known', !mentions(rulesUri, 'Unknown deftemplate'), JSON.stringify(messagesFor(rulesUri)));
  check('deffunction from unopened file is known', !mentions(rulesUri, 'Unknown function "greet"'), JSON.stringify(messagesFor(rulesUri)));
  check('defglobal from unopened file is known', !mentions(rulesUri, 'Unknown global'), JSON.stringify(messagesFor(rulesUri)));
  check('a genuinely undefined function is still flagged', mentions(rulesUri, 'Unknown function "helper-x"'), JSON.stringify(messagesFor(rulesUri)));

  // 2. Go-to-definition and hover land in the unopened file.
  const greetDef = await connection.sendRequest('textDocument/definition', {
    textDocument: { uri: rulesUri },
    position: position(rulesSrc, 'greet')
  });
  check('definition of greet jumps into templates.clp',
    greetDef?.length === 1 && sameFile(greetDef[0].uri, templatesUri) && rangeText(templatesSrc, greetDef[0].range) === 'greet',
    JSON.stringify(greetDef));

  const slotDef = await connection.sendRequest('textDocument/definition', {
    textDocument: { uri: rulesUri },
    position: position(rulesSrc, 'name')
  });
  check('definition of slot "name" jumps into templates.clp',
    slotDef?.length === 1 && sameFile(slotDef[0].uri, templatesUri) && rangeText(templatesSrc, slotDef[0].range) === 'name',
    JSON.stringify(slotDef));

  const personHover = await connection.sendRequest('textDocument/hover', {
    textDocument: { uri: rulesUri },
    position: position(rulesSrc, 'person')
  });
  const personText = personHover?.contents?.value ?? '';
  check('hover on person names the defining file', personText.includes('defined in `templates.clp`'), personText);
  check('hover on person counts the referencing rule in the other file', personText.includes('used in 1 rule'), personText);

  // 3. No double indexing despite the URI spelling mismatch.
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: templatesUri, languageId: 'clips', version: 1, text: templatesSrc }
  });
  await sleep(SETTLE_MS);
  const symbols = await connection.sendRequest('workspace/symbol', { query: 'greet' });
  check('workspace/symbol lists greet exactly once', symbols.length === 1, JSON.stringify(symbols.map((s) => s.location.uri)));
  connection.sendNotification('textDocument/didClose', { textDocument: { uri: templatesUri } });
  await sleep(SETTLE_MS);

  // 4. Unsaved editor text overrides the disk copy.
  const editedTemplates = `${templatesSrc}\n(deffunction helper-x () 1)\n`;
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: templatesUri, languageId: 'clips', version: 1, text: editedTemplates }
  });
  await sleep(SETTLE_MS);
  check('unsaved definition in an open file resolves elsewhere', !mentions(rulesUri, 'helper-x'), JSON.stringify(messagesFor(rulesUri)));

  // 5. Closing without saving reverts to the disk copy.
  connection.sendNotification('textDocument/didClose', { textDocument: { uri: templatesUri } });
  await sleep(SETTLE_MS);
  check('closing an unsaved file reverts the index to disk', mentions(rulesUri, 'Unknown function "helper-x"'), JSON.stringify(messagesFor(rulesUri)));
  check('closed file has its diagnostics cleared', (latestDiagnostics.get(templatesUri) ?? []).length === 0);

  // 6. A change on disk (watched file) is picked up.
  writeFileSync(templatesPath, templatesSrc.replace('greet', 'salute'));
  connection.sendNotification('workspace/didChangeWatchedFiles', {
    changes: [{ uri: pathToFileURL(templatesPath).href, type: 2 /* Changed */ }]
  });
  await sleep(SETTLE_MS);
  check('renaming greet on disk makes the call unknown', mentions(rulesUri, 'Unknown function "greet"'), JSON.stringify(messagesFor(rulesUri)));

  // 7. The clips.diagnostics.scope setting.
  check('openFiles scope: an unopened file gets no diagnostics', messagesForFile(extraPath).length === 0, JSON.stringify(messagesForFile(extraPath)));

  await setScope('workspace');
  check('workspace scope: an unopened file gets its diagnostics',
    messagesForFile(extraPath).some((m) => m.includes('Unknown function "no-such-fn"')), JSON.stringify(messagesForFile(extraPath)));
  check('workspace scope: a clean unopened file reports nothing', messagesForFile(templatesPath).length === 0, JSON.stringify(messagesForFile(templatesPath)));

  connection.sendNotification('textDocument/didClose', { textDocument: { uri: rulesUri } });
  await sleep(SETTLE_MS);
  check('workspace scope: closing a file keeps its diagnostics',
    messagesForFile(rulesPath).some((m) => m.includes('Unknown function "greet"')), JSON.stringify(messagesForFile(rulesPath)));

  await setScope('openFiles');
  check('back to openFiles: unopened files are cleared',
    messagesForFile(extraPath).length === 0 && messagesForFile(rulesPath).length === 0,
    JSON.stringify([messagesForFile(extraPath), messagesForFile(rulesPath)]));

  // 8. A deffunction defined in this file and (differently) in another:
  // the arity check uses this file's own definition.
  const tallyCopyUri = vscodeUri(tallyCopyPath);
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: tallyCopyUri, languageId: 'clips', version: 1, text: tallyCopySrc }
  });
  await sleep(SETTLE_MS);
  check('arity uses the file\'s own deffunction over another file\'s',
    mentions(tallyCopyUri, '"tally" expects exactly 2 arguments, but this call has 1'), JSON.stringify(messagesFor(tallyCopyUri)));

  await connection.sendRequest('shutdown');
  await connection.sendNotification('exit').catch(() => {});

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall workspace checks passed');
  }
} catch (err) {
  console.error('workspace test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
