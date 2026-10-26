# CLIPS Language Server

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) server for [CLIPS](https://www.clipsrules.net/) 6.4.2, built on the [tree-sitter-CLIPS]() grammar. It speaks plain LSP over stdio, so it works in any editor with an LSP client.

## Features

- **Diagnostics**: syntax errors, plus semantic checks such as undefined functions, templates, slots, classes and globals; unbound or misused variables; wrong argument counts and value types in function calls; duplicate definitions.
- **Hover**: signatures and documentation for built-in functions, and the definition, docstring and reference count for your own constructs.
- **Go-to definition**, across files.
- **Completion**: functions, constructs, slots, variables and keywords that fit the cursor position, with argument placeholders and construct skeletons as snippets.
- **Host-defined names**: when CLIPS is embedded in a C/C++ program, run [scripts/dump-host/dump.clp](scripts/dump-host/dump.clp) inside it to write a `.clpd` declaration file. The server then treats the program's functions and constructs as defined. See the comments at the top of that file.
- **Quick fixes** for unknown names and slots.

## Requirements

- Node.js 20 or later
- A C compiler toolchain (the grammar is a native Node addon compiled on install): Visual Studio Build Tools on Windows, Xcode Command Line Tools on macOS, `gcc`/`make` on Linux

## Building

```sh
npm install
npm run build
```

The grammar is currently referenced as a sibling checkout (same parent folder,`../tree-sitter-CLIPS`, see `package.json`).

This produces `dist/server.js`. To get a `clips-language-server` command on your `PATH`, run `npm link` in this directory. Without it, editors can run `node /path/to/clips-language-server/dist/server.js --stdio` instead.

## Editor setup

The server is started as `clips-language-server --stdio`. File types: `.clp`, `.CLP` and `.clpd`.

### VS Code

The extension in [client/](client/) is still in development. Open this repository in VS Code and press F5 ("Launch CLIPS Client") to start an Extension Development Host with the server attached. Settings go in `settings.json` under `clips.*`.

### Neovim (0.11+)

```lua
vim.filetype.add({ extension = { clp = 'clips', CLP = 'clips', clpd = 'clips' } })

vim.lsp.config('clips', {
  cmd = { 'clips-language-server', '--stdio' },
  filetypes = { 'clips' },
  root_markers = { '.git' },
  settings = {
    clips = {
      diagnostics = { scope = 'openFiles' },
    },
  },
})
vim.lsp.enable('clips')
```

### Helix

In `languages.toml`:

```toml
[language-server.clips]
command = "clips-language-server"
args = ["--stdio"]
config = { clips = { diagnostics = { scope = "openFiles" } } }

[[language]]
name = "clips"
scope = "source.clips"
file-types = ["clp", "CLP", "clpd"]
roots = [".git"]
comment-token = ";"
language-servers = ["clips"]
```

### Other editors

Any LSP client works. Configure it to:

- start `clips-language-server --stdio` for `.clp`/`.CLP`/`.clpd` files,
- use the project folder as the workspace root (all `.clp` files under it are indexed),
- send settings under the `clips` section (see below).

The server reads settings with `workspace/configuration` and picks up changes through `workspace/didChangeConfiguration`. If the client sends no settings, the defaults apply. It registers its own file watcher for `.clp`/`.clpd` files when the client supports dynamic registration, so files changed outside the editor (git checkouts, regenerated `.clpd` files) are re-indexed.

## Settings

| Setting | Values | Default | Description |
|---|---|---|---|
| `clips.diagnostics.scope` | `openFiles`, `workspace` | `openFiles` | Report errors and warnings only for open files, or for every `.clp` file in the workspace. |
| `clips.completion.snippets` | `true`, `false` | `true` | Insert argument placeholders and construct skeletons when accepting a completion. Turn off to insert plain names. Only applies if the client supports snippets. |
| `clips.completion.unlinkedFiles` | `include`, `exclude` | `include` | For a file that no `(load ...)` links to other files: whether completion also suggests constructs from the rest of the workspace. Files that are part of a known program always get exactly that program's constructs. |


