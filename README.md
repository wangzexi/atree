# atree-ng

atree-ng is an experimental local Web workspace built on top of OpenCode.

The product direction is:

- one local HTTP service;
- a Web GUI, not Electron;
- a left-side atree directory tree for governed knowledge/work nodes;
- OpenCode's mature session, chat, tool call, streaming, and file runtime reused underneath;
- persistent sessions and scheduled sessions attached to directories.

## Development

Install dependencies:

```sh
bun install
```

Run the local Web service:

```sh
bun run web --hostname 0.0.0.0 --port 3001
```

The service hosts both the Web app and API on the same port.

## Current Status

This branch starts from upstream OpenCode and removes unrelated official distribution surfaces.
The first atree work should focus on replacing OpenCode's outer project/session navigation with
the atree directory tree while keeping the chat runtime intact.
