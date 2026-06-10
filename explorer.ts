/**
 * pi-sidepanel-inputs — Explorer tree data model and rendering (no pi imports)
 *
 * Pure logic: the pi-tui utilities it needs are injected by the entry
 * point (index.ts), so this module is directly importable in unit tests
 * under plain `node --test`.
 */

import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export interface TreeNode {
	name: string;
	/** Absolute path */
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	expanded: boolean;
	/** Whether this node (or any descendant) was explicitly read by the agent */
	wasRead: boolean;
	/** Character count of file content (only set for file nodes after a read result) */
	fileChars?: number;
	/** Cumulative estimated token count of all read descendant files with known sizes. Set on directories. */
	dirTokens?: number;
}

export interface FlatEntry {
	node: TreeNode;
	depth: number;
	/** Whether this is the last child of its parent */
	isLast: boolean;
	/** The indent prefixes for ancestor levels */
	ancestorLast: boolean[];
}

export interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

/** Injected pi-tui utilities. */
export interface TuiUtils {
	matchesKey: (data: string, key: string) => boolean;
	truncateToWidth: (
		s: string,
		width: number,
		ellipsis?: string,
		pad?: boolean,
	) => string;
	visibleWidth: (s: string) => number;
}

// ── Token size helpers ────────────────────────────────────────────────────

/** Estimate token count from character count (same heuristic as pi core). */
export function est(chars: number): number {
	return Math.ceil(chars / 4);
}

/** Format token count for display. */
export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

// ── Flattening helpers ────────────────────────────────────────────────────

/** Recursively flatten visible (expanded) nodes into a depth-first list. */
export function flattenTree(
	nodes: TreeNode[],
	depth: number,
	ancestorLast: boolean[],
): FlatEntry[] {
	const result: FlatEntry[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const isLast = i === nodes.length - 1;
		const entry: FlatEntry = {
			node: nodes[i]!,
			depth,
			isLast,
			ancestorLast: [...ancestorLast],
		};
		result.push(entry);
		if (
			nodes[i]!.type === "directory" &&
			nodes[i]!.expanded &&
			nodes[i]!.children.length > 0
		) {
			result.push(
				...flattenTree(nodes[i]!.children, depth + 1, [
					...ancestorLast,
					isLast,
				]),
			);
		}
	}
	return result;
}

// ── Tree connectors ───────────────────────────────────────────────────────

export function indentPrefix(ancestorLast: boolean[], depth: number): string {
	let prefix = "";
	for (let d = 0; d < depth; d++) {
		if (d >= ancestorLast.length) {
			prefix += "    ";
		} else {
			prefix += ancestorLast[d] ? "    " : "│   ";
		}
	}
	return prefix;
}

export function connector(isLast: boolean): string {
	return isLast ? "└── " : "├── ";
}

// ── Output parsing ────────────────────────────────────────────────────────

/** Parse find tool output text into an array of file paths. */
export function parseFindOutput(text: string, cwd: string): string[] {
	const paths: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Skip truncation hints and header lines
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;
		if (trimmed.startsWith("...")) continue;
		// Resolve relative paths to absolute
		const resolved = path.isAbsolute(trimmed)
			? trimmed
			: path.resolve(cwd, trimmed);
		paths.push(resolved);
	}
	return paths;
}

/** Parse ls tool output text into {name, isDir} entries. */
export function parseLsOutput(text: string): { name: string; isDir: boolean }[] {
	const entries: { name: string; isDir: boolean }[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed === "(empty directory)" || trimmed.includes("more lines"))
			continue;
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;
		const isDir = trimmed.endsWith("/");
		const name = isDir ? trimmed.slice(0, -1) : trimmed;
		entries.push({ name, isDir });
	}
	return entries;
}

// ── ExplorerComponent ─────────────────────────────────────────────────────

export class ExplorerComponent {
	/** Max number of nodes in the tree. Oldest-inaccessible evicted when exceeded. */
	private static readonly MAX_NODES = 500;
	/** Maximum directory depth to track. Deep paths beyond this are ignored. */
	private static readonly MAX_DEPTH = 12;

	/** Root nodes — top-level directories/files relative to CWD. */
	private roots: TreeNode[] = [];
	/** Quick lookup by absolute path. */
	private nodeMap = new Map<string, TreeNode>();
	/** Insertion order for LRU eviction (oldest first). */
	private nodeOrder: string[] = [];
	/** Paths queued via L key but not yet processed by the agent. */
	private pendingPaths = new Set<string>();
	private scrollOffset = 0;
	private followTail = true;
	private theme: ThemeColors | null = null;

	/** Currently highlighted flat-entry index (0-based). */
	private cursorIdx = 0;

	// cache (keyed by width AND height so a vertical resize re-renders)
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	/** Cached flat list — rebuilt when tree changes. */
	private flatList: FlatEntry[] = [];

	/** Viewport rows incl. footer; set each render from the framework height. */
	private visibleArea = 40;

	/** Callback for on-demand tool invocation (L key). */
	private onInvokeTool?: (
		toolName: string,
		input: Record<string, unknown>,
	) => void;

	private cwd: string;
	private utils: TuiUtils;

	constructor(cwd: string, utils: TuiUtils) {
		this.cwd = cwd;
		this.utils = utils;
	}

	/** Wire the L-key tool invoker from the extension. */
	setToolInvoker(
		fn: (toolName: string, input: Record<string, unknown>) => void,
	): void {
		this.onInvokeTool = fn;
	}

	reset(): void {
		this.roots = [];
		this.nodeMap.clear();
		this.nodeOrder = [];
		this.pendingPaths.clear();
		this.scrollOffset = 0;
		this.followTail = true;
		this.cursorIdx = 0;
		this.flatList = [];
		this.invalidate();
	}

	setTheme(theme: ThemeColors): void {
		this.theme = theme;
	}

	// ── Test/inspection accessors ─────────────────────────────────────

	/** Look up a node by absolute path (read-only inspection). */
	getNode(absolutePath: string): TreeNode | undefined {
		return this.nodeMap.get(absolutePath);
	}

	/** Current flattened (visible) entries (read-only inspection). */
	getFlatEntries(): FlatEntry[] {
		return this.flatList;
	}

	/** Number of tracked nodes. */
	get nodeCount(): number {
		return this.nodeMap.size;
	}

	/** Length of the eviction-order list. Invariant: equals nodeCount. */
	get orderCount(): number {
		return this.nodeOrder.length;
	}

	// ── Tree mutation ─────────────────────────────────────────────────

	/** Ensure a directory node exists in the tree (empty, awaiting ls populate). */
	ensureDir(absolutePath: string): void {
		if (absolutePath === this.cwd) return; // CWD is implicit root
		if (this.nodeMap.has(absolutePath)) return;

		const relativePath = path.relative(this.cwd, absolutePath);
		if (!relativePath || relativePath.startsWith("..")) return;

		const parts = relativePath.split(path.sep);
		this.ensurePath(parts, absolutePath, "directory");
		this.rebuildFlatList();
		this.invalidate();
	}

	/** Set the character count for a file (from read tool result). */
	setFileSize(absolutePath: string, charCount: number): void {
		const node = this.nodeMap.get(absolutePath);
		if (!node || node.type !== "file") return;

		// Compute token delta to propagate up to ancestor directories
		const oldEst = node.fileChars != null ? est(node.fileChars) : 0;
		node.fileChars = charCount;
		const newEst = est(charCount);
		const delta = newEst - oldEst;

		let currentPath = path.dirname(absolutePath);
		let prevPath = absolutePath;
		while (
			currentPath &&
			currentPath !== this.cwd &&
			currentPath !== prevPath
		) {
			const ancestor = this.nodeMap.get(currentPath);
			if (ancestor && ancestor.type === "directory") {
				ancestor.dirTokens = (ancestor.dirTokens ?? 0) + delta;
			}
			prevPath = currentPath;
			currentPath = path.dirname(currentPath);
		}
	}

	/** Mark a path as pending (user pressed L, waiting for agent). */
	markPending(absolutePath: string): void {
		this.pendingPaths.add(absolutePath);
		this.invalidate();
	}

	/** Clear pending marker when agent actually processes the path. */
	clearPending(absolutePath: string): void {
		if (this.pendingPaths.delete(absolutePath)) {
			this.invalidate();
		}
	}

	/** Ensure a file node exists under its parent directory (lazily creating the directory tree). */
	addFile(absolutePath: string): void {
		const existing = this.nodeMap.get(absolutePath);
		if (existing) {
			// File was already in tree from ls — mark it as read and propagate up
			if (!existing.wasRead) {
				existing.wasRead = true;
				this.propagateReadUp(existing);
				this.invalidate();
			}
			return;
		}

		const relativePath = path.relative(this.cwd, absolutePath);
		if (!relativePath || relativePath.startsWith("..")) return;

		const parts = relativePath.split(path.sep);
		const node = this.ensurePath(parts, absolutePath, "file");
		node.wasRead = true;
		this.propagateReadUp(node);
		this.rebuildFlatList();
		this.invalidate();
	}

	/** Walk up from a read node, marking all ancestors as having a read descendant. */
	private propagateReadUp(node: TreeNode): void {
		let currentPath = path.dirname(node.path);
		let prevPath = node.path;
		while (
			currentPath &&
			currentPath !== this.cwd &&
			currentPath !== prevPath
		) {
			const ancestor = this.nodeMap.get(currentPath);
			if (ancestor && !ancestor.wasRead) {
				ancestor.wasRead = true;
			}
			prevPath = currentPath;
			currentPath = path.dirname(currentPath);
		}
	}

	/** Populate a directory's children from ls tool output text.
	 *  The cwd itself is supported: it is the implicit root, so its
	 *  children land directly in the tree roots. */
	populateDirectory(
		dirPath: string,
		entries: { name: string; isDir: boolean }[],
	): void {
		let dirNode: TreeNode | undefined;
		let childList: TreeNode[];

		if (dirPath === this.cwd) {
			// cwd is the implicit root — its children ARE the tree roots.
			childList = this.roots;
		} else {
			dirNode = this.nodeMap.get(dirPath);
			if (!dirNode) {
				// Create the directory node first
				const relativePath = path.relative(this.cwd, dirPath);
				if (!relativePath || relativePath.startsWith("..")) return;
				const parts = relativePath.split(path.sep);
				this.ensurePath(parts, dirPath, "directory");

				dirNode = this.nodeMap.get(dirPath);
				if (!dirNode) return;
			}
			if (dirNode.type !== "directory") return;
			childList = dirNode.children;
		}

		// Merge children — only add new entries, don't clear existing.
		// Cap at 200 children per directory to prevent massive ls results
		// (e.g. node_modules) from blowing up the tree.
		const MAX_CHILDREN = 200;
		const existingNames = new Set(childList.map((c) => c.name));
		for (const entry of entries) {
			if (existingNames.has(entry.name)) continue;
			if (childList.length >= MAX_CHILDREN) break;
			// Evict before adding to stay under global node cap
			this.evictNodes();
			const childPath = path.join(dirPath, entry.name);
			const child: TreeNode = {
				name: entry.name,
				path: childPath,
				type: entry.isDir ? "directory" : "file",
				children: [],
				expanded: false,
				wasRead: false, // listed via ls, not yet read
			};
			childList.push(child);
			// Guard against duplicate nodeOrder entries (a stale duplicate
			// would make eviction remove the freshly re-added node).
			if (!this.nodeMap.has(childPath)) {
				this.nodeOrder.push(childPath);
			}
			this.nodeMap.set(childPath, child);
		}

		// Sort children: dirs first, then files, both alphabetically
		childList.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
		});

		// Auto-expand if not already expanded
		if (dirNode && !dirNode.expanded) {
			dirNode.expanded = true;
		}

		this.rebuildFlatList();
		this.invalidate();
	}

	/** Ensure a path (split into parts) exists in the tree, returning the leaf node. */
	private ensurePath(
		parts: string[],
		absolutePath: string,
		leafType: "file" | "directory",
	): TreeNode {
		// Hard depth cap — truncate to MAX_DEPTH and return deepest ancestor
		const cappedParts = parts.slice(0, ExplorerComponent.MAX_DEPTH);
		const cappedPath = path.join(this.cwd, ...cappedParts);

		// Walk from root
		let currentList = this.roots;
		let builtPath = this.cwd;

		for (let i = 0; i < cappedParts.length; i++) {
			const name = cappedParts[i]!;
			builtPath = path.join(builtPath, name);
			const isLast = i === cappedParts.length - 1;
			const nodeType = isLast ? leafType : "directory";

			let node = this.nodeMap.get(builtPath);
			if (node) {
				currentList = node.children;
			} else {
				// Evict oldest nodes if at capacity
				this.evictNodes();

				node = {
					name: name,
					path: builtPath,
					type: nodeType,
					children: [],
					expanded: !isLast, // auto-expand intermediate dirs
					wasRead: false,
				};
				this.nodeMap.set(builtPath, node);
				this.nodeOrder.push(builtPath);
				currentList.push(node);
				// Sort the list after insert
				currentList.sort((a, b) => {
					if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
					return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				});
				currentList = node.children;
			}
		}

		return this.nodeMap.get(cappedPath)!;
	}

	/** Remove all descendants of a node from nodeMap and nodeOrder
	 *  (the node itself stays). Used before re-populating a directory. */
	private pruneDescendants(node: TreeNode): void {
		const removed = new Set<string>();
		const stack = [...node.children];
		while (stack.length > 0) {
			const child = stack.pop()!;
			removed.add(child.path);
			this.nodeMap.delete(child.path);
			stack.push(...child.children);
		}
		if (removed.size > 0) {
			this.nodeOrder = this.nodeOrder.filter((p) => !removed.has(p));
		}
	}

	/** Evict oldest nodes when over MAX_NODES. Keeps root nodes if possible. */
	private evictNodes(): void {
		let stuck = 0;
		while (this.nodeMap.size >= ExplorerComponent.MAX_NODES) {
			const oldestPath = this.nodeOrder.shift();
			if (!oldestPath) break;

			const node = this.nodeMap.get(oldestPath);
			if (!node) continue;

			// Don't evict root nodes (direct children of cwd) unless we're desperate
			if (this.roots.includes(node) && stuck < 3) {
				// Move to end of order to give it more time, try next
				this.nodeOrder.push(oldestPath);
				stuck++;
				continue;
			}

			// Remove from parent's children
			const parentPath = path.dirname(oldestPath);
			const parent = this.nodeMap.get(parentPath);
			if (parent) {
				const idx = parent.children.indexOf(node);
				if (idx >= 0) parent.children.splice(idx, 1);
			} else {
				// Orphaned root — remove from roots array
				const rootIdx = this.roots.indexOf(node);
				if (rootIdx >= 0) this.roots.splice(rootIdx, 1);
			}

			this.nodeMap.delete(oldestPath);
			stuck = 0;
		}
	}

	private rebuildFlatList(): void {
		this.flatList = flattenTree(this.roots, 0, []);
		// Clamp cursor
		if (this.cursorIdx >= this.flatList.length) {
			this.cursorIdx = Math.max(0, this.flatList.length - 1);
		}
	}

	// ── Component interface ───────────────────────────────────────────

	handleInput(data: string): void {
		const { matchesKey } = this.utils;

		// l/L: invoke ls on directory or read on file
		if (data === "l" || data === "L") {
			const entry = this.flatList[this.cursorIdx];
			if (entry && this.onInvokeTool) {
				// Guard: don't re-queue files already pending or read.
				// Pending is marked HERE (not in the invoker callback) so the
				// guard holds regardless of how the invoker is wired.
				if (entry.node.type === "file") {
					if (this.pendingPaths.has(entry.node.path) || entry.node.wasRead) {
						return;
					}
					this.markPending(entry.node.path);
					this.onInvokeTool("read", { path: entry.node.path });
				} else {
					// Clear stale children, re-populate from fresh ls.
					// Prune descendants from the bookkeeping too — otherwise
					// they leak in nodeMap/nodeOrder, and the re-populate
					// would push duplicate nodeOrder entries that make
					// eviction remove freshly re-added nodes.
					this.pruneDescendants(entry.node);
					entry.node.children = [];
					entry.node.expanded = false;
					this.markPending(entry.node.path);
					this.onInvokeTool("ls", { path: entry.node.path });
				}
			}
			return;
		}

		if (matchesKey(data, "enter")) {
			this.toggleCurrent();
			return;
		}

		const moved = this.moveCursor(data);
		if (!moved) return;

		this.invalidate();
	}

	private moveCursor(data: string): boolean {
		const { matchesKey } = this.utils;
		let moved = false;

		if (data === "j" || matchesKey(data, "down")) {
			if (this.cursorIdx < this.flatList.length - 1) {
				this.cursorIdx++;
				moved = true;
			}
		} else if (data === "k" || matchesKey(data, "up")) {
			if (this.cursorIdx > 0) {
				this.cursorIdx--;
				moved = true;
			}
		} else if (data === "g" || matchesKey(data, "home")) {
			if (this.cursorIdx !== 0) {
				this.cursorIdx = 0;
				moved = true;
			}
		} else if (data === "G" || matchesKey(data, "end")) {
			const last = Math.max(0, this.flatList.length - 1);
			if (this.cursorIdx !== last) {
				this.cursorIdx = last;
				moved = true;
			}
		} else if (matchesKey(data, "pageup")) {
			const tgt = Math.max(0, this.cursorIdx - (this.visibleArea - 1));
			if (this.cursorIdx !== tgt) {
				this.cursorIdx = tgt;
				moved = true;
			}
		} else if (matchesKey(data, "pagedown")) {
			const tgt = Math.min(
				this.flatList.length - 1,
				this.cursorIdx + (this.visibleArea - 1),
			);
			if (this.cursorIdx !== tgt) {
				this.cursorIdx = tgt;
				moved = true;
			}
		}

		// Auto-scroll to keep cursor visible
		if (moved) {
			this.scrollToCursor();
		}

		return moved;
	}

	private toggleCurrent(): void {
		const entry = this.flatList[this.cursorIdx];
		if (!entry || entry.node.type !== "directory") return;

		entry.node.expanded = !entry.node.expanded;
		this.rebuildFlatList();
		this.scrollToCursor();
		this.invalidate();
	}

	private scrollToCursor(): void {
		// Reserve 1 line for keymap footer
		const treeViewH = this.visibleArea - 1;
		if (this.cursorIdx < this.scrollOffset) {
			this.scrollOffset = this.cursorIdx;
		} else if (this.cursorIdx >= this.scrollOffset + treeViewH) {
			this.scrollOffset = this.cursorIdx - treeViewH + 1;
		}
		// Clamp
		const maxScroll = Math.max(0, this.flatList.length - treeViewH);
		this.scrollOffset = Math.min(maxScroll, Math.max(0, this.scrollOffset));
	}

	render(width: number, height = 40): string[] {
		const { truncateToWidth, visibleWidth } = this.utils;
		const H = Math.max(3, Math.floor(height));
		this.visibleArea = H;
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedHeight === H
		)
			return this.cachedLines;

		const th = this.theme ?? defaultTheme;
		const lines: string[] = [];

		if (this.flatList.length === 0) {
			lines.push(
				th.fg("dim", truncateToWidth(" No files explored yet", width, "")),
			);
			lines.push("");
			lines.push(
				th.fg("dim", truncateToWidth(" Tree builds as agent uses", width, "")),
			);
			lines.push(
				th.fg("dim", truncateToWidth(" read and ls tools.", width, "")),
			);
		} else {
			// Reserve 1 line for the keymap footer
			const treeViewH = this.visibleArea - 1;
			const visible = this.flatList.slice(
				this.scrollOffset,
				this.scrollOffset + treeViewH,
			);

			for (let i = 0; i < visible.length; i++) {
				const entry = visible[i]!;
				const { node, depth, isLast, ancestorLast } = entry;
				const prefix = indentPrefix(ancestorLast, depth);
				const conn = connector(isLast);

				const isCursor = this.scrollOffset + i === this.cursorIdx;
				const cursor = isCursor ? th.fg("accent", ">") : " ";

				let name: string;
				const isPending = this.pendingPaths.has(node.path);
				if (node.type === "directory") {
					// Folders: warning if pending, orange if read, dim otherwise
					if (isPending) {
						name = th.fg("warning", node.name) + "/";
					} else if (node.wasRead) {
						name = th.fg("syntaxNumber", th.bold(node.name)) + "/";
					} else {
						name = th.fg("dim", node.name) + "/";
					}
				} else if (node.name.endsWith(".md")) {
					// Markdown: warning if pending, blue if read, dim otherwise
					if (isPending) {
						name = th.fg("warning", node.name);
					} else if (node.wasRead) {
						name = th.fg("syntaxFunction", node.name);
					} else {
						name = th.fg("dim", node.name);
					}
				} else {
					if (isPending) {
						name = th.fg("warning", node.name);
					} else if (node.wasRead) {
						name = node.name;
					} else {
						name = th.fg("dim", node.name);
					}
				}

				const base = `${cursor}${prefix}${conn}`;
				const baseVw = visibleWidth(base);

				// Token badge: files get dim, directories get purple (syntaxKeyword)
				let tokenEst: number | null = null;
				let tokenColor = "dim";
				if (node.type === "file" && node.wasRead && node.fileChars != null) {
					tokenEst = est(node.fileChars);
				} else if (
					node.type === "directory" &&
					node.wasRead &&
					node.dirTokens != null &&
					node.dirTokens > 0
				) {
					tokenEst = node.dirTokens;
					tokenColor = "syntaxKeyword";
				}

				if (tokenEst != null) {
					const tokenStr = th.fg(tokenColor, fmtTokens(tokenEst));
					const tokenVw = visibleWidth(tokenStr);
					const maxNameW = width - baseVw - 1 - tokenVw;
					const nameDisplay =
						maxNameW > 0 ? truncateToWidth(name, maxNameW, "…", false) : name;
					const nameVw = visibleWidth(nameDisplay);
					const padding = " ".repeat(
						Math.max(1, width - baseVw - nameVw - tokenVw),
					);
					lines.push(base + nameDisplay + padding + tokenStr);
				} else {
					const line = `${base}${name}`;
					const vw = visibleWidth(line);
					lines.push(
						vw > width ? truncateToWidth(line, width, "…", false) : line,
					);
				}
			}
		}

		// Keymap footer (pinned to the bottom of the viewport)
		const th2 = this.theme ?? defaultTheme;
		while (lines.length < H - 1) lines.push("");
		lines.push(
			th2.fg(
				"dim",
				truncateToWidth(
					" j/k navigate │ Enter expand │ l ls/read │ g/G top/bot",
					width,
					"",
				),
			),
		);

		this.cachedWidth = width;
		this.cachedHeight = H;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}
