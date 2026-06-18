# atree

atree is a local AI workspace organized around a file tree.

The core idea is simple: a knowledge base should not be only a place where
information is stored. The structure of the information, the information
itself, and the agents that execute work around it should live together.

In atree, directories are not just folders. They are working contexts. A
session opened inside a directory inherits that directory as its natural scope.
When a session becomes recurring, it turns into a lightweight automation that
keeps working in that same context.

This makes the file tree both:

- the information structure;
- the execution surface.

## Why

Most knowledge tools are good at recording things, but weak at acting on them.
Most automation tools are good at executing tasks, but detached from the
knowledge structure where the work actually belongs.

atree tries to merge those two layers.

The user manages the outer structure of their information tree. Inside selected
directories, AI sessions can read, write, summarize, transform, schedule, and
continue work. Over time, repeated work can be promoted into scheduled sessions.

The result is a workspace where knowledge is not passive. The same directory
that stores context can also host the execution that maintains or uses it.

## Product Shape

The current MVP is a Web app backed by a local HTTP service.

- The left side is an atree directory tree.
- The main area is a chat workspace.
- A selected directory owns its own session group.
- Sessions can be archived and restored.
- A session can have at most one automation message.
- Automation messages support one-time schedules and recurring cron schedules.
- Scheduled sessions are sorted ahead of ordinary sessions by next run time.

The runtime is based on OpenCode. atree keeps the mature chat, tool execution,
streaming, and file interaction foundation, while replacing the outer product
model with the directory workspace model.

## Design Model

atree intentionally keeps the MVP vocabulary small:

```text
Directory
Session
Automation message
```

A session is the visible form of an agent. There is no separate agent object in
the MVP. A session may be temporary, long-lived, archived, or scheduled.

A scheduled session is just a session with an automation message that will be
sent later or repeatedly.

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

## Documents

Start from:

- `docs/design.md` - core product design
- `docs/mvp.md` - MVP scope
- `docs/future.md` - future idea pool
- `docs/history.md` - branch and design history
- `docs/acceptance/atree-mvp-bdd.md` - BDD acceptance scenarios
- `docs/atree-opencode-pruning.md` - OpenCode pruning notes
- `docs/v2-storage-plan.md` - second-version storage plan

## License

MIT. This project keeps the same license as OpenCode.
