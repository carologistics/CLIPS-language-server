/**
 * @file VS Code client: starts `dist/server.js` over IPC for CLIPS documents.
 */

import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

/** The running client, stopped in {@link deactivate}. */
let client: LanguageClient;

/**
 * Starts the language server.
 *
 * @param context - The extension context, used to find the server.
 */
export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join('..', 'dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  const clientOptions: LanguageClientOptions = {
    // No file watcher here; the server registers its own.
    documentSelector: [{ scheme: 'file', language: 'clips' }]
  };

  client = new LanguageClient(
    'clipsLanguageServer',
    'CLIPS Language Server',
    serverOptions,
    clientOptions
  );

  client.start();
}

/**
 * Stops the language server.
 *
 * @returns Resolves when the server has stopped.
 */
export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
