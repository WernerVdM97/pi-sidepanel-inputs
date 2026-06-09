# pi-sidepanel-inputs

Interactive file explorer tree tab for [pi-sidepanel](../pi-sidepanel). Builds a collapsible tree of directories and files as the agent explores them via `read` and `ls` tool invocations. Vim-style keyboard navigation, color-coded by read status with theme support. Session-persistent — tree replays on restart.

<p align="center"><em>👆 Interactive — use keyboard to navigate, Enter to expand/collapse directories</em></p>

## Keybindings

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `Enter` | Expand / collapse directory |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `PgUp` | Page up |
| `PgDn` | Page down |

## Display

Files and directories appear as the agent discovers them. Directories auto-expand when their contents are listed via `ls`. Files change color from dim to normal when explicitly read by the agent, and the *was-read* state propagates up to ancestor directories.

```
>├── dotVault/
 │   ├── .pi/
 │   │   └── agent/
 │   │       ├── AGENTS.md      ← agent read this file
 │   │       └── settings.json
 │   └── README.md
 └── projects/
     └── pi-sidepanel/
         ├── bash/
         │   └── index.ts
         └── index.ts
```

### Color coding

| Element | Color | Meaning |
|---------|-------|---------|
| Directory (read) | **orange bold** | Directory has at least one read descendant |
| Directory (unread) | dim | Listed but not yet explored |
| File (read) | normal | Explicitly read by the agent |
| File (unread) | dim | Listed via `ls` but not yet read |
| Markdown file (read) | **blue** | Special highlight for `.md` files |
| Cursor (`>`) | **accent** | Current selection |

## Session persistence

On `session_start`, the tab replays all `read` and `ls` invocations from the session history to rebuild the tree. Capped at last 1,000 entries.

## Memory safety

Tree capped at **2,000 nodes** with LRU eviction of oldest leaf nodes. Root-level directories are preserved to maintain tree structure.

## Architecture

```
pi-sidepanel-inputs
  └── index.ts   — tree data model, rendering, event wiring
```

## License

MIT
