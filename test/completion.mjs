/**
 * @file Completion and resolve. Each case opens a small document with `|`
 * as the cursor, mostly with parens left open as while typing. A second
 * server with snippet support checks snippets and `clips.completion.snippets`.
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

/** Definitions every completion case can use. */
const defs = `(deftemplate sensor "a hardware reading"
  (slot id (type INTEGER))
  (multislot readings)
  (slot status (allowed-values ok fail)))
(deftemplate alarm (slot level))
(deffunction helper (?a) (+ ?a 1))
(defgeneric area)
(defclass Shape (is-a USER)
  (slot side (allowed-values 1 2 3))
  (slot color (create-accessor read-write)))
(defclass Square (is-a Shape)
  (slot corners (create-accessor ?NONE)))
(defmessage-handler Shape describe ()
  (printout t ?self:side crlf))
(defglobal ?*count* = 0)
`;

/**
 * Spawns a server process and connects to it.
 *
 * @returns The process and its connection.
 */
function startServer() {
  const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  connection.listen();
  return { child, connection };
}

/**
 * Initializes a server and opens the definitions file.
 *
 * @param connection - The server's connection.
 * @param completionItem - The client's completion-item capabilities.
 */
async function initialize(connection, completionItem) {
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: { textDocument: { completion: { completionItem } } }
  });
  await connection.sendNotification('initialized', {});
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: 'file:///defs.clp', languageId: 'clips', version: 1, text: defs }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Server for a client without snippet support. */
const main = startServer();
/** Server for a client with snippet support. */
const snippetServer = startServer();
/** Connection used by default. */
const connection = main.connection;

/** Number of failed checks. */
let failures = 0;
/** Makes each case's document URI unique. */
let counter = 0;

/**
 * Position of the `|` cursor marker, and the text without it.
 *
 * @param textWithCursor - Text with one `|`.
 * @returns The text and the LSP position.
 */
function split(textWithCursor) {
  const index = textWithCursor.indexOf('|');
  const text = textWithCursor.slice(0, index) + textWithCursor.slice(index + 1);
  const before = text.slice(0, index);
  const line = (before.match(/\n/g) ?? []).length;
  const character = index - before.lastIndexOf('\n') - 1;
  return { text, position: { line, character } };
}

/**
 * Opens `textWithCursor` as a fresh document and requests completion at `|`.
 * The document stays open until `close()` (resolve needs it).
 *
 * @param textWithCursor - Text with one `|`.
 * @param server - The connection to use.
 * @returns The items and a function that closes the document.
 */
async function completeOpen(textWithCursor, server = connection) {
  const { text, position } = split(textWithCursor);
  const uri = `file:///case-${++counter}.clp`;
  server.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'clips', version: 1, text } });
  const result = await server.sendRequest('textDocument/completion', { textDocument: { uri }, position });
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  return { items, close: () => server.sendNotification('textDocument/didClose', { textDocument: { uri } }) };
}

/**
 * Like {@link completeOpen}, closing the document right away.
 *
 * @param textWithCursor - Text with one `|`.
 * @param server - The connection to use.
 * @returns The items.
 */
async function complete(textWithCursor, server = connection) {
  const { items, close } = await completeOpen(textWithCursor, server);
  close();
  return items;
}

/**
 * Checks that every label in `want` is offered and none in `notWant` is.
 *
 * @param label - What is checked.
 * @param textWithCursor - Text with one `|`.
 * @param want - Labels that must be offered.
 * @param notWant - Labels that must not be.
 * @returns The items.
 */
async function check(label, textWithCursor, want, notWant = []) {
  const items = await complete(textWithCursor);
  const labels = new Set(items.map((i) => i.label));
  const missing = want.filter((w) => !labels.has(w));
  const unexpected = notWant.filter((n) => labels.has(n));
  const pass = missing.length === 0 && unexpected.length === 0;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) {
    if (missing.length) console.log(`      missing: ${JSON.stringify(missing)}`);
    if (unexpected.length) console.log(`      unexpected: ${JSON.stringify(unexpected)}`);
    console.log(`      got ${items.length}: ${JSON.stringify([...labels].slice(0, 30))}`);
    failures++;
  }
  return items;
}

/**
 * Checks that nothing at all is offered.
 *
 * @param label - What is checked.
 * @param textWithCursor - Text with one `|`.
 */
async function checkEmpty(label, textWithCursor) {
  const items = await complete(textWithCursor);
  const pass = items.length === 0;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  ->  ${JSON.stringify(items.map((i) => i.label).slice(0, 15))}`}`);
  if (!pass) failures++;
}

/**
 * Records a check result.
 *
 * @param label - What is checked.
 * @param condition - Whether it passed.
 * @param detail - Shown on failure.
 */
function assert(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  ${detail}`}`);
  if (!condition) failures++;
}

try {
  await initialize(connection, { documentationFormat: ['markdown', 'plaintext'] });
  await initialize(snippetServer.connection, { documentationFormat: ['markdown'], snippetSupport: true });

  // ----------------------------------------------------------- names and keywords by position
  await check('top level, partial keyword', '(def|', ['defrule', 'deftemplate', 'defclass']);
  await check('top level, empty head: functions and construct keywords', '(|', ['defrule', 'helper', 'printout', 'reset']);
  await check('LHS pattern head: templates and CE keywords, no functions', '(defrule r (|', ['sensor', 'alarm', 'not', 'test', 'exists', 'declare'], ['printout', 'helper']);
  await check('LHS pattern head after a pattern: no declare', '(defrule r (sensor) (|', ['alarm', 'not'], ['declare']);
  await check('LHS slot names of the pattern\'s template', '(defrule r (sensor (|', ['id', 'readings', 'status'], ['level', 'printout']);
  await check('LHS slot names, auto-closed', '(defrule r (sensor (|)) => )', ['id', 'status'], ['level']);
  await check('LHS slot of an unknown template: nothing to offer', '(defrule r (nosuch (|', [], ['id', 'printout']);
  await check('RHS call head: functions and special forms, no templates', '(defrule r (sensor (id ?x)) => (|', ['printout', 'helper', 'assert', 'if', 'progn$'], ['sensor', 'id']);
  await check('RHS call head, auto-closed', '(defrule r (sensor (id ?x)) => (|))', ['printout', 'helper']);
  await check('function head nested in if/then', '(deffunction g (?a) (if (> ?a 1) then (str-|', ['str-cat', 'str-length']);
  await check('test CE takes a function', '(defrule r (sensor (id ?x)) (test (|', ['>', 'eq', 'helper'], ['sensor']);
  await check('assert pattern head: templates only', '(defrule r => (assert (|', ['sensor', 'alarm'], ['printout']);
  await check('slots of an asserted template fact', '(defrule r => (assert (sensor (|', ['id', 'readings', 'status'], ['printout']);
  await check('nested form in an ordered asserted fact is a call', '(defrule r => (assert (total (|', ['printout', '+'], ['id']);
  await check('modify slots via ?f <- pattern', '(defrule r ?f <- (sensor (id ?x)) => (modify ?f (|', ['id', 'status'], ['level', 'printout']);
  await check('deffacts pattern head', '(deffacts d (|', ['sensor', 'alarm'], ['printout']);
  await check('deffacts slots', '(deffacts d (sensor (|', ['id', 'status']);
  await check('fact-query set template', '(deffunction g () (do-for-all-facts ((?f |', ['sensor', 'alarm']);
  await check('defclass is-a: user and built-in classes', '(defclass Square (is-a |', ['Shape', 'USER', 'OBJECT'], ['sensor']);
  await check('defmethod restriction type', '(defmethod area ((?s |', ['Shape', 'INTEGER']);
  await check('definstances class after "of"', '(definstances i ([s1] of |', ['Shape']);
  // A method can overload a built-in, but not a deffunction ([GENRCPSR5]).
  await check('defmethod name: existing generics and built-ins, not deffunctions', '(defmethod |', ['area', '+'], ['helper']);
  await check('defmessage-handler class', '(defmessage-handler |', ['Shape']);

  // Suggestions CLIPS 6.4.2 would reject.
  await check('LHS slot value: no globals (a syntax error in a pattern)', '(defrule r (sensor (status |', ['ok', 'fail'], ['?*count*']);
  await check('LHS predicate call argument: globals are fine there', '(defrule r (sensor (id ?x&:(> ?x |', ['?*count*']);
  await check('make-instance of: only concrete user classes ([INSMNGR3])',
    '(defclass Abs (is-a USER) (role abstract))\n(defclass Sub (is-a Abs))\n(defrule r => (make-instance [x] of |',
    ['Shape', 'Square'], ['Abs', 'Sub', 'USER', 'INTEGER']);
  await check('object is-a: only classes that can be matched ([OBJRTBLD1/2])',
    '(defclass Quiet (is-a USER) (pattern-match non-reactive))\n(defclass Abs (is-a USER) (role abstract))\n(defclass Concrete (is-a Abs) (role concrete))\n(defrule r (object (is-a |',
    ['Shape', 'USER', 'OBJECT'], ['Quiet', 'Abs', 'Concrete', 'INTEGER']);
  await check('switch body: only case and default', '(defrule r => (switch ?x (|', ['case', 'default'], ['printout', 'helper']);
  await check('after an if condition: only then, not recovery-state keywords', '(defrule r => (if TRUE |', ['then'], ['to', 'of', 'around', '?']);
  await check('class body keywords that need arguments are still offered', '(defclass B (is-a USER) (|', ['role', 'pattern-match', 'slot']);
  await check('own bind target is not readable inside its value', '(defrule r => (bind ?fresh (+ 1 ?|', [], ['?fresh']);
  await check('an earlier bind of the same name is', '(defrule r => (bind ?n 1) (bind ?n (+ ?|', ['?n']);

  // Less common positions.
  await check('default value: ?NONE and ?DERIVE', '(deftemplate t (slot x (default |', ['?NONE', '?DERIVE']);
  await check('while: do after the condition', '(defrule r => (while TRUE |', ['do']);
  await check('built-in class argument (slot-range |)', '(defrule r => (slot-range |', ['Shape', 'Square']);
  await check('built-in slot argument of a literal class, inherited slots too', '(defrule r => (slot-range Square |', ['side', 'color', 'corners']);
  await check('built-in slot argument of a literal deftemplate', '(defrule r => (deftemplate-slot-multip sensor |', ['id', 'readings', 'status']);
  await check('focus: module names', '(defmodule M2 (export ?ALL))\n(defrule r => (focus |', ['MAIN', 'M2']);
  await check('import: other modules, not the one being defined', '(defmodule M2 (import |', ['MAIN'], ['M2']);
  await check('import item: constructs of the named type', '(defmodule M3 (import MAIN deftemplate |', ['sensor', 'alarm'], ['helper']);
  await check('pattern head: ordered facts used in the program', '(defrule seed => (assert (phase start)))\n(defrule r (|', ['phase', 'sensor']);
  await check('the word being typed is not an ordered fact of its own', '(defrule r (ph|', [], ['ph']);
  await check('query templates: no ordered facts', '(defrule seed => (assert (phase start)))\n(defrule r => (do-for-all-facts ((?f |', ['sensor'], ['phase']);
  await check('instance names after [', '(definstances d (lamp-1 of Shape))\n(defrule r => (send [|', ['[lamp-1]']);
  await check('no existing names for an instance being created', '(definstances d (lamp-1 of Shape))\n(definstances d2 ([|', [], ['[lamp-1]']);
  await check('printout: output logical names', '(defrule r => (printout |', ['t', 'stdout', 'stderr'], ['stdin']);
  await check('printout arguments: crlf, tab', '(defrule r => (printout t "x" |', ['crlf', 'tab']);
  await check('readline: input logical names', '(defrule r => (readline |', ['t', 'stdin'], ['stdout']);
  await check('top level outside any form: constructs only', '|', ['defrule', 'deftemplate'], ['active-make-instance', 'printout']);
  await check('template slot attribute keywords', '(deftemplate t (slot x (|', ['type', 'default', 'allowed-values', 'range', 'cardinality'], ['printout', 'sensor']);
  await check('type names after (type', '(deftemplate t (slot x (type |', ['SYMBOL', 'INTEGER', 'STRING', '?VARIABLE'], ['printout']);
  await check('deftemplate body keywords', '(deftemplate t (|', ['slot', 'multislot']);
  await check('declare properties', '(defrule r (declare (|', ['salience', 'auto-focus']);
  await check('defclass slot facets', '(defclass B (is-a USER) (slot x (|', ['access', 'storage', 'visibility', 'default']);
  await check('defclass access values', '(defclass B (is-a USER) (slot x (access |', ['read-write', 'read-only', 'initialize-only']);
  await check('defmodule body keywords', '(defmodule M (|', ['export', 'import']);

  // ----------------------------------------------------------- where nothing should be offered
  await checkEmpty('naming a new rule', '(defrule |');
  await checkEmpty('naming a new template', '(deftemplate |');
  await checkEmpty('declaring a parameter', '(deffunction g (?|');
  await checkEmpty('declaring a loop variable', '(deffunction g ($?l) (progn$ (?|');
  await checkEmpty('inside a string', '(defrule r => (printout t "see (|');
  await checkEmpty('inside a comment', '(defrule r ; about (|');
  // Outside any form only constructs fit (the editor filters them by the typed word).
  await check('outside any form: construct snippets, nothing else', 'hel|', ['defrule'], ['helper', 'printout', 'sensor']);

  // ----------------------------------------------------------- globals and variables
  await check('globals after ?*', '(defrule r => (printout t ?*|', ['?*count*'], ['?x']);
  await check('RHS sees LHS pattern variables and the fact address', '(defrule r ?f <- (sensor (id ?x)) => (printout t ?|', ['?x', '?f']);
  await check('RHS variable, auto-closed', '(defrule r (sensor (id ?x)) => (printout t ?|))', ['?x']);
  await check('RHS bind is not visible on the LHS', '(defrule r (sensor (id ?x)) (alarm (level ?|)) => (bind ?y 1))', ['?x'], ['?y']);
  await check('a later pattern is not visible in an earlier test', '(defrule r (sensor (id ?x)) (test (> ?| 1)) (alarm (level ?lv)) =>)', ['?x'], ['?lv']);
  await check('bind is visible after it on the RHS', '(defrule r => (bind ?total 0) (printout t ?|', ['?total']);
  await check('a not CE binding is not visible on the RHS', '(defrule r (sensor (id ?x)) (not (alarm (level ?n))) => (printout t ?|', ['?x'], ['?n']);
  await check('a not CE binding is visible inside that not CE', '(defrule r (sensor (id ?x)) (not (alarm (level ?n&:(> ?| 1)', ['?x', '?n']);
  await check('or: only names bound in every branch reach the RHS', '(defrule r (or (sensor (id ?a) (status ?both)) (alarm (level ?both))) => (printout t ?|', ['?both'], ['?a']);
  await check('query variable inside its query', '(deffunction g () (do-for-all-facts ((?f sensor)) TRUE (printout t ?|', ['?f']);
  await check('query variable not visible after its query', '(deffunction g () (do-for-all-facts ((?f sensor)) TRUE) (printout t ?|', [], ['?f']);
  await check('progn$ variable and its implicit -index', '(deffunction g ($?l) (progn$ (?e $?l) (printout t ?|', ['?e', '?e-index', '?l']);
  await check('progn$ variable not visible after the loop', '(deffunction g ($?l) (progn$ (?e $?l) TRUE) (printout t ?|', ['?l'], ['?e', '?e-index']);
  await check('foreach variable and its implicit -index', '(deffunction g ($?l) (foreach ?e $?l (printout t ?|', ['?e', '?e-index']);
  await check('loop-for-count variable, no -index', '(deffunction g () (loop-for-count (?i 1 10) (printout t ?|', ['?i'], ['?i-index']);
  await check('?self in a message handler', '(defmessage-handler Shape describe () (printout t ?|', ['?self']);
  await check('parameters of a deffunction', '(deffunction g (?alpha $?rest) (+ ?|', ['?alpha', '?rest']);
  await check('$? sigil keeps the multifield prefix', '(deffunction g ($?items) (length$ $?|', ['$?items'], ['?items']);
  await check('variables of other rules are not offered', '(defrule a (sensor (id ?other)) => )\n(defrule b (alarm (level ?lv)) => (printout t ?|', ['?lv'], ['?other']);
  await check('an unclosed earlier rule does not leak its variables', '(defrule a (sensor (id ?other)) => (printout t\n(defrule b (alarm (level ?lv)) => (printout t ?|', ['?lv'], ['?other']);
  const typing = await check('the word being typed is not offered as a candidate', '(defrule r (sensor (id ?xyz)) => (printout t ?xy|', ['?xyz'], ['?xy', '?clipsCompletionMarker']);

  // ----------------------------------------------------------- slot values
  await check('LHS slot value: allowed values', '(defrule r (sensor (status |', ['ok', 'fail'], ['printout', 'sensor']);
  await check('LHS predicate argument is not a slot value', '(defrule r (sensor (status ?s&:(eq ?s |', ['?s'], ['ok']);
  await check('asserted slot value', '(defrule r => (assert (sensor (status |', ['ok', 'fail']);
  await check('deffacts slot value', '(deffacts d (sensor (status |', ['ok', 'fail']);
  await check('modify slot value, with variables too', '(defrule r ?f <- (sensor (id ?x)) => (modify ?f (status |', ['ok', 'fail', '?x']);
  await check('object pattern slot value', '(defrule r (object (is-a Shape) (side |', ['1', '2', '3']);
  await check('make-instance slot value', '(defrule r => (make-instance [s] of Shape (side |', ['1', '2', '3']);

  // ----------------------------------------------------------- slots via variables and classes
  await check('?f: slots of the fact-address pattern', '(defrule r ?f <- (sensor) => (printout t ?f:|', ['id', 'status'], ['side']);
  await check('?f: slots of a fact-query member', '(deffunction g () (do-for-all-facts ((?f sensor)) TRUE (printout t ?f:|', ['id', 'readings']);
  await check('?i: slots of an instance-query member, inherited too', '(deffunction g () (do-for-all-instances ((?i Square)) TRUE (printout t ?i:|', ['corners', 'side']);
  await check("?self: slots of the handler's class and its superclasses", '(defmessage-handler Square show () (printout t ?self:|', ['corners', 'side', 'color'], ['id']);
  await check('object pattern slots, inherited, plus is-a', '(defrule r (object (is-a Square) (|', ['corners', 'side', 'color', 'is-a'], ['id']);
  await check("object pattern without is-a: every class's slots", '(defrule r (object (|', ['side', 'corners']);
  await check('make-instance slots', '(defrule r => (make-instance [s] of Square (|', ['corners', 'side'], ['id']);
  await check('definstances slots', '(definstances i ([s1] of Square (|', ['corners', 'side']);
  await check('modify-instance slots via an object pattern variable', '(defrule r ?o <- (object (is-a Square)) => (modify-instance ?o (|', ['corners', 'side'], ['id']);
  await check('modify-instance ?self: the handler class only', '(defmessage-handler Shape reset-side () (modify-instance ?self (|', ['side', 'color'], ['corners']);

  // ----------------------------------------------------------- send
  // A slot without create-accessor gets get-/put- too (CLIPS 6.4.2); only ?NONE gets none.
  await check("send: handlers, accessors and system handlers of the receiver's class", '(defrule r ?o <- (object (is-a Square)) => (send ?o |', ['describe', 'print', 'delete', 'init', 'get-color', 'put-color', 'get-side', 'put-side'], ['get-corners', 'put-corners']);
  await check('send to an unknown receiver: every handler', '(deffunction g (?x) (send ?x |', ['describe', 'print']);

  // ----------------------------------------------------------- item shape
  const partial = await complete('(defrule r (sen|');
  const sensor = partial.find((i) => i.label === 'sensor');
  assert('replace range covers the partially typed word',
    sensor?.textEdit?.range.start.character === 12 && sensor?.textEdit?.range.end.character === 15,
    JSON.stringify(sensor?.textEdit));
  const xyz = typing.find((i) => i.label === '?xyz');
  assert('replace range includes the variable sigil', xyz?.textEdit?.range.end.character - xyz?.textEdit?.range.start.character === 3, JSON.stringify(xyz?.textEdit));
  const head = await complete('(defrule r (sensor (id ?x)) => (|');
  /** Sort text of an item at the call head. */
  const order = (label) => head.find((i) => i.label === label)?.sortText ?? '';
  assert('user functions sort before built-ins', order('helper') < order('printout'), `${order('helper')} vs ${order('printout')}`);
  assert('inside a rule, user functions sort before keywords', order('helper') < order('if'), `${order('helper')} vs ${order('if')}`);
  const top = await complete('(|');
  /** Sort text of an item at the top level. */
  const topOrder = (label) => top.find((i) => i.label === label)?.sortText ?? '';
  assert('top level: construct keywords sort before user functions and built-ins',
    topOrder('defrule') < topOrder('helper') && topOrder('deftemplate') < topOrder('printout'),
    `${topOrder('defrule')} / ${topOrder('helper')} / ${topOrder('printout')}`);

  const open = await completeOpen('(defrule r (sen|');
  const resolvedTemplate = await connection.sendRequest('completionItem/resolve', open.items.find((i) => i.label === 'sensor'));
  assert('resolve documents a template with its hover card', resolvedTemplate?.documentation?.value?.includes('(deftemplate sensor)'), JSON.stringify(resolvedTemplate?.documentation));
  const printout = head.find((i) => i.label === 'printout');
  const resolvedBuiltin = await connection.sendRequest('completionItem/resolve', printout);
  assert('resolve documents a built-in with its syntax', resolvedBuiltin?.documentation?.value?.includes('(printout <logical-name>'), JSON.stringify(resolvedBuiltin?.documentation));
  open.close();
  const slots = await completeOpen('(defrule r (sensor (|');
  const resolvedSlot = await connection.sendRequest('completionItem/resolve', slots.items.find((i) => i.label === 'status'));
  assert('resolve documents a slot', resolvedSlot?.documentation?.value?.includes('allowed-values'), JSON.stringify(resolvedSlot?.documentation));
  slots.close();
  const messages = await completeOpen('(defrule r ?o <- (object (is-a Square)) => (send ?o |');
  const resolvedHandler = await connection.sendRequest('completionItem/resolve', messages.items.find((i) => i.label === 'describe'));
  assert('resolve documents a message handler', resolvedHandler?.documentation?.value?.includes('describe'), JSON.stringify(resolvedHandler?.documentation));
  const classSlotItems = await completeOpen('(defrule r (object (is-a Square) (|');
  const resolvedClassSlot = await connection.sendRequest('completionItem/resolve', classSlotItems.items.find((i) => i.label === 'side'));
  assert('resolve documents a class slot', resolvedClassSlot?.documentation?.value?.includes('allowed-values 1 2 3') && resolvedClassSlot?.documentation?.value?.includes('defclass Shape'), JSON.stringify(resolvedClassSlot?.documentation));
  messages.close();
  classSlotItems.close();
  const plain = await connection.sendRequest('completionItem/resolve', printout);
  assert('resolve still documents a built-in after its document closed', plain?.documentation?.value?.includes('(printout'), JSON.stringify(plain?.documentation));

  // ----------------------------------------------------------- constructs lost mid-edit
  const uri = 'file:///stale.clp';
  const valid = '(defrule r (sensor (id ?x)) => )\n(deftemplate later-t (slot q))\n';
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'clips', version: 1, text: valid } });
  const broken = '(defrule r (sensor (id ?x)) => (assert (\n(deftemplate later-t (slot q))\n';
  connection.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: broken }]
  });
  const lost = await connection.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 0, character: broken.indexOf('\n') }
  });
  assert('a template defined after an unclosed form is still offered', lost.some((i) => i.label === 'later-t'), JSON.stringify(lost.map((i) => i.label)));

  // ----------------------------------------------------------- snippets
  const plainHead = (await complete('(|')).find((i) => i.label === 'defrule');
  assert('without client snippet support, items insert plain names', plainHead?.textEdit?.newText === 'defrule' && plainHead?.insertTextFormat !== 2, JSON.stringify(plainHead));

  const snip = snippetServer.connection;
  /**
   * The text an item inserts on the snippet server.
   *
   * @param textWithCursor - Text with one `|`.
   * @param label - The item's label.
   * @returns The text and whether it is a snippet, or `null` if not offered.
   */
  async function snippet(textWithCursor, label) {
    const item = (await complete(textWithCursor, snip)).find((i) => i.label === label);
    return item ? { text: item.textEdit?.newText, snippet: item.insertTextFormat === 2 } : null;
  }
  /**
   * Checks the snippet an item inserts.
   *
   * @param label - What is checked.
   * @param textWithCursor - Text with one `|`.
   * @param itemLabel - The item's label.
   * @param expected - The snippet text, or `null` for a plain name.
   */
  async function checkSnippet(label, textWithCursor, itemLabel, expected) {
    const got = await snippet(textWithCursor, itemLabel);
    const pass = expected === null
      ? got !== null && !got.snippet && got.text === itemLabel
      : got?.snippet === true && got.text === expected;
    assert(label, pass, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }

  await checkSnippet('construct skeleton, closing the open paren', '(|', 'defrule', 'defrule ${1:name}\n  ${2:pattern}\n  =>\n  $0)');
  await checkSnippet('construct skeleton, paren already auto-closed', '(|)', 'defrule', 'defrule ${1:name}\n  ${2:pattern}\n  =>\n  $0');
  await checkSnippet('built-in call: required arguments from the manual', '(defrule r => (mo|', 'mod', 'mod ${1:numeric-expression} ${2:numeric-expression}$0)');
  await checkSnippet('built-in call: syntax wrapped over two lines', '(defrule r => (sub-s|))', 'sub-string', 'sub-string ${1:integer-expression} ${2:integer-expression} ${3:string-expression}$0');
  await checkSnippet('built-in call: optional and repeated arguments are left out', '(defrule r => (printo|', 'printout', 'printout ${1:logical-name}$0)');
  await checkSnippet('special form with a literal $ escaped', '(defrule r => (progn|', 'progn$', 'progn\\$ (?${1:item} ${2:list})\n  $0)');
  await checkSnippet('bind: variable with its ? and a value', '(defrule r => (bin|', 'bind', 'bind ?${1:var} ${2:value}$0)');
  await checkSnippet('assert: a fact in parens, not the grammar name', '(defrule r => (asse|', 'assert', 'assert (${1:fact})$0)');
  await checkSnippet('make-instance: name and class', '(defrule r => (make-i|', 'make-instance', 'make-instance [${1:name}] of ${2:class}$0)');
  await checkSnippet('switch clause snippet', '(defrule r => (switch ?x (ca|', 'case', 'case ${1:value} then\n  $0)');
  await checkSnippet('top-level construct written with its paren', 'defr|', 'defrule', '(defrule ${1:name}\n  ${2:pattern}\n  =>\n  $0)');
  await checkSnippet('user deffunction: its parameters', '(defrule r => (hel|', 'helper', 'helper ${1:?a}$0)');
  await checkSnippet('slot of an asserted fact', '(defrule r => (assert (sensor (|', 'id', 'id $0)');
  await checkSnippet('slot, paren already auto-closed', '(defrule r => (assert (sensor (|))))', 'id', 'id $0');
  await checkSnippet('arguments already written after the cursor: plain name', '(defrule r => (printo| t "x"))', 'printout', null);
  await checkSnippet('template at a pattern head stays a plain name', '(defrule r (sen|', 'sensor', null);
  await checkSnippet('?f: slot stays a plain name', '(defrule r ?f <- (sensor) => (printout t ?f:|', 'id', null);
  await checkSnippet('balanced form: no extra paren', '(defrule r => (mo|) (printout t x))', 'mod', 'mod ${1:numeric-expression} ${2:numeric-expression}$0');

  snip.sendNotification('workspace/didChangeConfiguration', { settings: { clips: { completion: { snippets: false } } } });
  await checkSnippet('clips.completion.snippets = false turns snippets off', '(|', 'defrule', null);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const server of [main, snippetServer]) {
    server.connection.dispose();
    server.child.kill();
  }
}

console.log(failures === 0 ? '\nall completion checks passed' : `\n${failures} completion check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
