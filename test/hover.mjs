/**
 * @file Hover: expected substrings of the Markdown for each kind of target.
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

/** The hovered fixture. */
const src = `(deftemplate sensor "a hardware temperature reading"
  (slot id (type INTEGER))   ; primary key
  (slot mode (allowed-values auto manual))
  (multislot samples))

(deftemplate reading
  (slot id (type INTEGER)))

(defglobal ?*threshold* = 10)

(defclass Device
  (is-a USER))

(defclass Probe
  (is-a Device))

(defgeneric calibrate)
(defmethod calibrate ((?p Probe))
  (printout t ?p crlf))

(deffunction average (?a ?b)
  (bind ?sum (+ ?a ?b))
  (/ ?sum 2))

(deffunction tally (?first $?rest)
  (+ ?first (length$ $?rest)))

(definstances gear
  ([p1] of Probe))

(defrule check
  (declare (salience 20))
  ?s <- (sensor (id ?sid) (mode ?m) (samples $?data))
  (reading (id ?sid))
  =>
  (calibrate ?sid)
  (average ?sid ?*threshold*)
  (printout t sensor ?m crlf))

(defrule emit
  =>
  (assert (sensor (id 2) (mode auto))))

(defrule switch-mode
  ?t <- (sensor (mode auto))
  =>
  (duplicate ?t (mode manual)))

(deffunction reset-first (?facts)
  (modify (nth$ 1 ?facts) (mode auto)))

(deffacts boot
  (sensor (id 7) (mode manual))
  (uptime (+ 1 2)))

(defrule flow
  (waiting)
  =>
  (if (> 1 0) then (assert (waiting)) else (halt))
  (switch 1 (case 1 then TRUE) (default FALSE))
  (do-for-all-facts ((?r gauge)) TRUE (modify ?r (level 3))))

(deftemplate gauge
  (slot level))

(deffacts MAIN::extra
  (waiting))

(deffunction listing (?items)
  (foreach ?it ?items
    (println ?it ?it-index)))

(defclass Bin (is-a USER)
  (slot fill (type INTEGER)))

(defclass Crate (is-a Bin))

(definstances crates
  ([c1] of Crate (fill 3)))

(defrule bin-check
  (object (is-a Crate) (name ?bin))
  =>
  (println ?bin (slot-types Crate fill)))

(defrule bin-report
  (object (is-a Crate) (name ?c))
  =>
  (send ?c print)
  (send ?c get-fill))

(definstances crate-set
  (crate-9 of Crate))

(defrule crate-poke
  =>
  (send [crate-9] print)
  (send [nowhere] print))
`;

/**
 * The position of the `occurrence`-th `needle` in the fixture.
 *
 * @param needle - Text to find.
 * @param occurrence - Which match, 0-based.
 * @returns The LSP position.
 */
function position(needle, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = src.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`needle not found: "${needle}" (occurrence ${occurrence})`);
  }
  const before = src.slice(0, index);
  const line = (before.match(/\n/g) ?? []).length;
  const character = index - before.lastIndexOf('\n') - 1;
  return { line, character };
}

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
 * Checks that every string in `needles` appears in the hover's Markdown.
 *
 * @param label - What is checked.
 * @param hover - The hover result.
 * @param needles - The expected strings.
 */
function check(label, hover, needles) {
  const value = hover?.contents?.value ?? null;
  const pass = needles.every((n) => value !== null && value.includes(n));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) {
    console.log(`      wanted all of: ${JSON.stringify(needles)}`);
    console.log(`      got: ${JSON.stringify(value)}`);
    failures++;
  }
}

/**
 * Checks that there is no hover at this position.
 *
 * @param label - What is checked.
 * @param hover - The hover result.
 */
function checkNull(label, hover) {
  const pass = hover === null;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  ->  ${JSON.stringify(hover)}`}`);
  if (!pass) failures++;
}

try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  await connection.sendNotification('initialized', {});

  const uri = 'file:///hover.clp';
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'clips', version: 1, text: src }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  /**
   * Requests the hover at a position.
   *
   * @param pos - The position.
   * @returns The hover, or `null`.
   */
  async function hover(pos) {
    return connection.sendRequest('textDocument/hover', { textDocument: { uri }, position: pos });
  }

  check('deftemplate reference (sensor in LHS pattern head)',
    await hover(position('sensor', 1)),
    ['(deftemplate sensor)', 'a hardware temperature reading', '(slot id)', '(multislot samples)']);

  check('deffunction call (average in RHS)',
    await hover(position('average', 1)),
    ['(deffunction average (?a ?b))', 'deffunction']);

  check('defglobal reference (?*threshold* in RHS)',
    await hover(position('?*threshold*', 1)),
    ['?*threshold* = 10', 'defglobal']);

  check('defclass is-a superclass reference (Device in Probe is-a)',
    await hover(position('Device', 1)),
    ['(defclass Device (is-a USER))']);

  check('defmethod parameter type reference (Probe in restriction)',
    await hover(position('Probe', 1)),
    ['(defclass Probe (is-a Device))']);

  check('definstances instance-of class reference (Probe after "of")',
    await hover(position('Probe', 2)),
    ['(defclass Probe (is-a Device))', 'defclass']);

  check('defgeneric call resolves to generic + method overload (calibrate in RHS)',
    await hover(position('calibrate', 2)),
    ['(defgeneric calibrate)', '(defmethod calibrate ((?p Probe)))', 'method']);

  check('built-in function call (printout) shows the curated card',
    await hover(position('printout', 1)),
    ['(printout <logical-name> <expression>*)', 'built-in function', '§12.4.3']);

  check('built-in function call (+) shows the curated card',
    await hover(position('+ ?a ?b')),
    ['(+ <numeric-expression>', 'built-in function', '§12.5.1']);

  check('built-in function call (length$) shows the curated card',
    await hover(position('length$')),
    ['(length$ <multifield-expression>)', 'built-in function', '§12.2.13']);

  check('user deffunction call is not mistaken for a builtin (average)',
    await hover(position('average', 1)),
    ['(deffunction average (?a ?b))']);

  check('defrule own name lists the templates its LHS matches + salience',
    await hover(position('check', 0)),
    ['(defrule check)', 'matches:', '`sensor`', '`reading`', 'salience 20']);

  check('deftemplate own name: rule backlink + per-slot constraint badges',
    await hover(position('reading', 1)),
    ['(deftemplate reading)', 'used in 1 rule']);

  check('deftemplate slot list carries type/enum badges',
    await hover(position('sensor', 1)),
    ['(slot id) · INTEGER', '(slot mode) · auto|manual']);

  check('deffunction shows call-site count',
    await hover(position('average', 1)),
    ['(deffunction average (?a ?b))', 'called by 1 site']);

  check('defglobal shows inferred literal type and read count',
    await hover(position('?*threshold*', 1)),
    ['?*threshold* = 10', 'defglobal · INTEGER', '1 read']);

  check('local read footer includes first-read line',
    await hover(position('?sum', 1)),
    ['?sum', 'bound by `bind`', 'first at line']);

  check('defclass own name shows subclass backlink',
    await hover(position('Device', 0)),
    ['(defclass Device (is-a USER))', 'referenced by 1 subclass']);

  check('variable bound to an allowed-values slot surfaces the enum (?m)',
    await hover(position('?m', 0)),
    ['?m', 'one of: auto manual', 'from sensor.mode', 'pattern-bound', 'defrule check']);

  check('local bound by bind (?sum in (/ ?sum 2))',
    await hover(position('?sum', 1)),
    ['?sum', 'bound by `bind`', 'deffunction average']);

  check('fact-address local (?s <- pattern)',
    await hover(position('?s <-')),
    ['?s', 'fact-address binding', 'defrule check']);

  check('local parameter (?a in body)',
    await hover(position('?a', 1)),
    ['?a', 'parameter', 'deffunction average']);

  check('LHS pattern-bound local: inferred slot type + cross-pattern join + read count',
    await hover(position('?sid', 0)),
    ['?sid', 'type INTEGER', 'from sensor.id', 'also constrains `reading.id`',
     'pattern-bound', 'defrule check', '2 reads']);

  check('multifield parameter is flagged (multifield) with a read count',
    await hover(position('$?rest', 0)),
    ['$?rest', 'parameter (multifield)', 'deffunction tally', '1 read']);

  check('single-field parameter: no (multifield), singular read label',
    await hover(position('?first', 0)),
    ['?first', 'parameter · deffunction tally · 1 read']);

  check('deftemplate slot in LHS pattern (id in (sensor (id ?sid)))',
    await hover(position('id ?sid')),
    ['(slot id)', '(type INTEGER)', 'primary key', 'slot of deftemplate sensor']);

  check('asserted fact head resolves to its deftemplate (sensor in assert)',
    await hover(position('sensor (id 2)')),
    ['(deftemplate sensor)', 'a hardware temperature reading']);

  check('deftemplate backlink counts the asserting rule as well as the matching one',
    await hover(position('sensor', 0)),
    ['(deftemplate sensor)', 'used in 3 rules']);

  check('deftemplate slot in duplicate (mode in (duplicate ?t (mode manual)))',
    await hover(position('mode manual')),
    ['(slot mode)', '(allowed-values auto manual)', 'slot of deftemplate sensor']);

  check('built-in fact action keyword (assert) shows the built-in card',
    await hover(position('assert')),
    ['(assert <RHS-pattern>+)', 'built-in function']);

  check('fact specifier written as a function call is a call (nth$ in (modify (nth$ 1 ?facts) ...))',
    await hover(position('nth$')),
    ['(nth$ ', 'built-in function']);

  check('slot in a deffacts template fact (id in (sensor (id 7) ...))',
    await hover(position('id 7')),
    ['(slot id)', '(type INTEGER)', 'slot of deftemplate sensor']);

  check('call inside an ordered fact (no deftemplate uptime) stays a call',
    await hover(position('+ 1 2')),
    ['(+ <numeric-expression>', 'built-in function']);

  checkNull('bare symbol argument (sensor in printout) -> null',
    await hover(position('sensor', 2)));

  check('ordered fact with no deftemplate (waiting in a pattern)',
    await hover(position('waiting')),
    ['(waiting ...)', 'An ordered fact', 'asserted at 2 sites', 'ordered fact']);
  check('special form keyword (if)', await hover(position('if (')), ['(if <expression>', 'built-in function']);
  check('then/else belong to if', await hover(position('else')), ['(if <expression>']);
  check('operator (> in a call)', await hover(position('> 1 0')), ['(> <numeric-expression>']);
  check('case inside switch -> switch', await hover(position('case 1')), ['(switch <test-expression>']);
  check('fact query keyword (do-for-all-facts)', await hover(position('do-for-all-facts')), ['(do-for-all-facts <fact-set-template>']);
  check('slot in modify of a fact-query variable', await hover(position('level 3')), ['(slot level)', 'gauge']);
  check('MAIN qualifier without a defmodule -> predefined module', await hover(position('MAIN::extra')),
    ['(defmodule MAIN)', 'built-in module']);
  checkNull('the = of a defglobal is not the = function', await hover(position('= 10')));
  check('implicit foreach index variable', await hover(position('?it-index')),
    ['?it-index', 'INTEGER', 'implicit index of the foreach loop variable ?it']);
  check('foreach loop variable is labelled as such', await hover(position('?it ?it-index')),
    ['foreach iteration variable', '1 read']);
  check('inherited class slot in a definstances override', await hover(position('fill 3')),
    ['(slot fill (type INTEGER))', 'slot of defclass Bin · inherited by Crate']);
  check('object pattern is-a keyword', await hover(position('is-a Crate')),
    ['(is-a <class-name>+)', 'object pattern attribute']);
  check('object pattern name keyword', await hover(position('name ?bin')),
    ['(name <constraint>)', 'not a slot of its class']);
  check('slot argument of a built-in (slot-types Crate fill)', await hover(position('fill)))')),
    ['(slot fill (type INTEGER))', 'inherited by Crate']);
  check('class argument of a built-in (slot-types Crate ...)', await hover(position('Crate fill')),
    ['(defclass Crate']);
  check('instance name -> where it is created and its class', await hover(position('[crate-9]')),
    ['([crate-9] of Crate)', 'definstances crate-set', 'instance name']);
  check('instance name created nowhere says it may exist at run time', await hover(position('[nowhere]')),
    ['[nowhere]', 'not created under this literal name']);
  check('built-in class USER', await hover(position('USER)\n  (slot fill')),
    ['(defclass USER (is-a OBJECT))', 'built-in class']);
  check('system message handler in send', await hover(position('print)\n')),
    ['(send <instance> print)', 'system message handler']);
  check('slot accessor in send (no create-accessor facet: get-/put- exist)', await hover(position('get-fill')),
    ['(slot fill (type INTEGER))', 'slot of defclass Bin']);

  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall hover checks passed');
  }
} catch (err) {
  console.error('hover test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
}
