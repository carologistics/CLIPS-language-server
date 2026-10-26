/**
 * @file Starts the server over stdio and checks diagnostics for a valid and
 * a broken document.
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

/** The server under test. */
const child = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[server stderr] ${chunk}`);
});

/** JSON-RPC connection to the server. */
const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);
connection.listen();

try {
  const initResult = await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {}
  });
  console.log('initialize response:', JSON.stringify(initResult, null, 2));

  await connection.sendNotification('initialized', {});

  const diagnosticsReceived = new Map();
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    diagnosticsReceived.set(params.uri, params.diagnostics);
  });

  connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///valid.clp',
      languageId: 'clips',
      version: 1,
      text: '(deftemplate foo (slot bar))'
    }
  });

  connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///broken.clp',
      languageId: 'clips',
      version: 1,
      text: '(deftemplate foo (slot bar)'
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  const validDiagnostics = diagnosticsReceived.get('file:///valid.clp');
  const brokenDiagnostics = diagnosticsReceived.get('file:///broken.clp');

  console.log('valid.clp diagnostics:', validDiagnostics);
  console.log('broken.clp diagnostics:', brokenDiagnostics);

  if (!validDiagnostics || validDiagnostics.length !== 0) {
    throw new Error('expected zero diagnostics for valid.clp');
  }
  if (!brokenDiagnostics || brokenDiagnostics.length === 0) {
    throw new Error('expected at least one diagnostic for broken.clp (unclosed paren)');
  }

  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');

  console.log('smoke test passed');
} catch (err) {
  console.error('smoke test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
}
