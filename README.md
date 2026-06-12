# atree-ng

An AI-native information tree.

`atree-ng` is an experiment in building a personal information platform around
a tree-shaped context model. The tree is the stable structure; files, remote
mounts, chats, media, agents, loops, and external platforms are attached to
nodes in that tree.

## Core Idea

The product starts from a simple interface:

- Left: a tree of important directories or autonomous nodes.
- Right: an AI conversation bound to the selected node.

The full physical file tree may contain documents, images, videos, PDFs,
archives, raw exports, remote mounts, and generated state. The user does not
need to manage every file-level detail. The primary UI focuses on nodes that
have operational meaning.

## Concepts

- **Tree**: the unified information namespace.
- **Mount**: an external source attached to a tree path, such as a local
  directory, remote computer, Git repository, object storage, social platform,
  chat export, or API.
- **Directory**: a local context scope.
- **Autonomous directory**: a directory with its own governance boundary and
  interface agent.
- **Interface agent**: the agent responsible for external communication for a
  directory.
- **Session**: a conversation or task bound to a directory.
- **Loop**: a session that runs periodically or reacts to events.

## Default Access Rule

Parent agents can read child directories transparently by default.

When a child directory is promoted to an autonomous directory, external access
should go through that directory's interface agent unless an explicit debug,
admin, migration, or audit mode is used.

```text
normal directory
  = transparent context

autonomous directory
  = context boundary + interface agent
```

## Information Flow

The intended flow is close to a React component tree:

- Downward flow is assignment, context, constraints, and material distribution.
- Upward flow is explicit reporting, events, requests, and status summaries.

Children should not mutate parent state implicitly. They report upward, and the
parent agent decides whether and how to incorporate the report.

## Product Shape

The first useful version should stay small:

- node tree navigation
- directory-bound AI chat
- persistent sessions
- loops or scheduled sessions
- autonomous directory marker
- interface agent for selected directories

File preview, rich media browsing, graph views, and simulation-style UI can come
later. The first goal is to make directories feel executable.

## References

Core source material:

- `/Users/zexi/workspace/wangzexi/space/知识库的下一步/README.md`
  - Main conceptual source for the next-generation knowledge base idea:
    file trees as persistent local contexts, README as external interface,
    and agents as long-running maintainers inside directories.

Supporting material:

- `/Users/zexi/workspace/wangzexi/space/知识库的下一步/refs/One Folder One Context.md`
  - Early concrete shape: one demand or work item maps to one folder.
- `/Users/zexi/workspace/wangzexi/space/知识库的下一步/refs/企业协作新形态_完整版.md`
  - Long discussion log covering directory-scoped agents, mounted people and
    agents, information flow, and state-tree collaboration.
- `/Users/zexi/workspace/wangzexi/space/知识库的事实与视角解耦/README.md`
  - Fact/perspective split: keep raw facts stable and generate views at query
    time.
- `/Users/zexi/workspace/wangzexi/space/循环工程/README.md`
  - Loop engineering model: autoregressive loop, tool loop, goal loop, and
    scheduled/event loop.
- `/Users/zexi/workspace/wangzexi/space/循环工程/drafts/v1-goal三层.md`
  - Detailed notes on Goal as an explicit completion loop.
- `/Users/zexi/workspace/wangzexi/space/Agent的成长阶梯.draft/README.md`
  - Background thinking on model and harness co-evolution.
- `/Users/zexi/workspace/wangzexi/atree/README.md`
  - Current A-Tree implementation: AI-friendly file-tree S3 gateway with
    mountable backends and config-as-file.

Mirrored or published blog copy:

- `/Users/zexi/workspace/wangzexi/blog/知识库的下一步：从静态文档到持续运行的局部上下文/README.md`

