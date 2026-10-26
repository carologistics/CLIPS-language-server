/**
 * @file Parses every .clp sample in ../tree-sitter-CLIPS/examples. All are
 * valid CLIPS 6.4.2, so any parse error is a grammar regression.
 */

import Parser from 'tree-sitter';
import Clips from 'tree-sitter-clips';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parser for the sample files. */
const parser = new Parser();
parser.setLanguage(Clips);

/** The grammar repository's sample folder. */
const dir = fileURLToPath(new URL('../../tree-sitter-CLIPS/examples', import.meta.url));
/** The sample `.clp` files. */
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.clp'));

/** Whether any sample has a syntax error, or there are none to check. */
let anyError = files.length === 0;
if (anyError) console.log(`ERROR  no .clp samples in ${dir}`);
for (const file of files) {
  const src = readFileSync(`${dir}/${file}`, 'utf8');
  const tree = parser.parse(src);
  const hasError = tree.rootNode.hasError;
  console.log(`${hasError ? 'ERROR' : 'ok   '}  ${file}`);
  if (hasError) anyError = true;
}
process.exitCode = anyError ? 1 : 0;
