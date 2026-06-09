/**
 * pi-sidepanel-explorer — File explorer tree tab for pi-sidepanel
 *
 * Builds a collapsible tree of directories and files as the agent
 * explores them via `read` and `ls` tool invocations. Navigation:
 * j/k (or down/up), Enter to toggle directory collapse/expand.
 *
 * Registers via `sidepanel:register` — requires pi-sidepanel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

interface TreeNode {
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
}

// ── Token size helpers ────────────────────────────────────────────────────

/** Estimate token count from character count (same heuristic as pi core). */
function est(chars: number): number {
	return Math.ceil(chars / 4);
}

/** Format token count for display. */
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

// ── Theme helpers ─────────────────────────────────────────────────────────

interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

// ── Flattening helpers ────────────────────────────────────────────────────

interface FlatEntry {
	node: TreeNode;
	depth: number;
	/** Whether this is the last child of its parent */
	isLast: boolean;
	/** The indent prefixes for ancestor levels */
	ancestorLast: boolean[];
}

/** Recursively flatten visible (expanded) nodes into a depth-first list. */
function flattenTree(
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

function indentPrefix(ancestorLast: boolean[], depth: number): string {
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

function connector(isLast: boolean): string {
	return isLast ? "└── " : "├── ";
}

// ── ExplorerComponent ─────────────────────────────────────────────────────

class ExplorerComponent {
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
	private scrollOffset = 0;
	private followTail = true;
	private theme: ThemeColors | null = null;

	/** Currently highlighted flat-entry index (0-based). */
	private cursorIdx = 0;

	// cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Cached flat list — rebuilt when tree changes. */
	private flatList: FlatEntry[] = [];

	private visibleArea = 40;

	/** Callback for on-demand tool invocation (L key). */
	private onInvokeTool?: (toolName: string, input: Record<string, unknown>) => void;

	constructor(private cwd: string) {}

	/** Wire the L-key tool invoker from the extension. */
	setToolInvoker(fn: (toolName: string, input: Record<string, unknown>) => void): void {
		this.onInvokeTool = fn;
	}

	reset(): void {
		this.roots = [];
		this.nodeMap.clear();
		this.nodeOrder = [];
		this.scrollOffset = 0;
		this.followTail = true;
		this.cursorIdx = 0;
		this.flatList = [];
		this.invalidate();
	}

	setTheme(theme: ThemeColors): void {
		this.theme = theme;
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
		if (node && node.type === "file") {
			node.fileChars = charCount;
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

	/** Populate a directory's children from ls tool output text. */
	populateDirectory(
		dirPath: string,
		entries: { name: string; isDir: boolean }[],
	): void {
		let dirNode = this.nodeMap.get(dirPath);
		if (!dirNode) {
			// Create the directory node first
			const relativePath = path.relative(this.cwd, dirPath);
			if (!relativePath) return;
			const parts = relativePath.split(path.sep);
			this.ensurePath(parts, dirPath, "directory");

			dirNode = this.nodeMap.get(dirPath);
			if (!dirNode) return;
		}

		if (dirNode.type !== "directory") return;

		// Merge children — only add new entries, don't clear existing.
		// Cap at 200 children per directory to prevent massive ls results
		// (e.g. node_modules) from blowing up the tree.
		const MAX_CHILDREN = 200;
		const existingNames = new Set(dirNode.children.map((c) => c.name));
		for (const entry of entries) {
			if (existingNames.has(entry.name)) continue;
			if (dirNode.children.length >= MAX_CHILDREN) break;
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
			dirNode.children.push(child);
			this.nodeMap.set(childPath, child);
			this.nodeOrder.push(childPath);
		}

		// Sort children: dirs first, then files, both alphabetically
		dirNode.children.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
		});

		// Auto-expand if not already expanded
		if (!dirNode.expanded) {
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
		let parent: TreeNode | undefined;
		let currentList = this.roots;
		let builtPath = this.cwd;

		for (let i = 0; i < cappedParts.length; i++) {
			const name = cappedParts[i]!;
			builtPath = path.join(builtPath, name);
			const isLast = i === cappedParts.length - 1;
			const nodeType = isLast ? leafType : "directory";

			let node = this.nodeMap.get(builtPath);
			if (node) {
				parent = node;
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
				parent = node;
				currentList = node.children;
			}
		}

		return this.nodeMap.get(cappedPath)!;
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

	// ── Component interface ──────────────────────────────────────────

	handleInput(data: string): void {
		// L: invoke ls on directory or read on file
		if (data === "L") {
			const entry = this.flatList[this.cursorIdx];
			if (entry && this.onInvokeTool) {
				if (entry.node.type === "directory") {
					this.onInvokeTool("ls", { path: entry.node.path });
				} else {
					this.onInvokeTool("read", { path: entry.node.path });
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
			const target = Math.max(0, this.cursorIdx - this.visibleArea);
			if (this.cursorIdx !== target) {
				this.cursorIdx = target;
				moved = true;
			}
		} else if (matchesKey(data, "pagedown")) {
			const target = Math.min(
				this.flatList.length - 1,
				this.cursorIdx + this.visibleArea,
			);
			if (this.cursorIdx !== target) {
				this.cursorIdx = target;
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
		if (this.cursorIdx < this.scrollOffset) {
			this.scrollOffset = this.cursorIdx;
		} else if (this.cursorIdx >= this.scrollOffset + this.visibleArea) {
			this.scrollOffset = this.cursorIdx - this.visibleArea + 1;
		}
		// Clamp
		const maxScroll = Math.max(0, this.flatList.length - this.visibleArea);
		this.scrollOffset = Math.min(maxScroll, Math.max(0, this.scrollOffset));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

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
			const visible = this.flatList.slice(
				this.scrollOffset,
				this.scrollOffset + this.visibleArea,
			);

			for (const entry of visible) {
				const { node, depth, isLast, ancestorLast } = entry;
				const prefix = indentPrefix(ancestorLast, depth);
				const conn = connector(isLast);

				const isCursor = this.flatList.indexOf(entry) === this.cursorIdx;
				const cursor = isCursor ? th.fg("accent", ">") : " ";

				let name: string;
				if (node.type === "directory") {
					// Folders: orange
					if (node.wasRead) {
						name = th.fg("syntaxNumber", th.bold(node.name)) + "/";
					} else {
						name = th.fg("dim", node.name) + "/";
					}
				} else if (node.name.endsWith(".md")) {
					// Markdown: blue
					if (node.wasRead) {
						name = th.fg("syntaxFunction", node.name);
					} else {
						name = th.fg("dim", node.name);
					}
				} else {
					name = node.wasRead ? node.name : th.fg("dim", node.name);
				}

				const base = `${cursor}${prefix}${conn}`;
				const baseVw = visibleWidth(base);

				// Token size badge: right-aligned for read files
				if (node.type === "file" && node.wasRead && node.fileChars != null) {
					const tokenStr = th.fg("dim", fmtTokens(est(node.fileChars)));
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

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── LS output parsing ─────────────────────────────────────────────────────

/** Parse find tool output text into an array of file paths. */
function parseFindOutput(text: string, cwd: string): string[] {
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
function parseLsOutput(text: string): { name: string; isDir: boolean }[] {
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

/** Extract text content from tool result content blocks. */
function extractTextContent(
	content: Array<{ type: string; text?: string }>,
): string {
	if (!content || !Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const explorer = new ExplorerComponent(cwd);
	let registered = false;

	// Wire L-key tool invoker: exec ls/cat directly via pi.exec
	explorer.setToolInvoker(async (toolName, input) => {
		if (toolName === "ls") {
			const dirPath = input.path as string;
			try {
				const result = await pi.exec("ls", ["-1", dirPath]);
				if (result.stdout) {
					const entries = parseLsOutput(result.stdout);
					if (entries.length > 0) {
						explorer.populateDirectory(dirPath, entries);
						pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
					}
				}
			} catch {
				// ls failed — silently ignore
			}
		} else if (toolName === "read") {
			const filePath = input.path as string;
			try {
				const result = await pi.exec("cat", [filePath]);
				if (result.stdout) {
					explorer.addFile(filePath);
					explorer.setFileSize(filePath, result.stdout.length);
					pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
				}
			} catch {
				// read failed — silently ignore
			}
		}
	});

	function registerTab(): void {
		if (registered) return;
		registered = true;

		try {
			const themedComponent = {
				handleInput(data: string): void {
					explorer.handleInput(data);
				},
				render(width: number): string[] {
					return explorer.render(width);
				},
				invalidate(): void {
					explorer.invalidate();
				},
				setTheme(t: ThemeColors): void {
					explorer.setTheme(t);
				},
			};

			pi.events.emit("sidepanel:register", {
				id: "explorer",
				label: "Inputs",
				component: themedComponent,
			});
		} catch {
			// Registration failed — silently ignore
		}
	}

	// ── Session start — replay history to survive pi restarts ─────────

	pi.on("session_start", async (_event: any, ctx: any) => {
		registered = false;
		explorer.reset();

		try {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type: string;
				message?: {
					role: string;
					toolName?: string;
					toolCallId?: string;
					content?: Array<{
						type: string;
						name?: string;
						id?: string;
						text?: string;
						arguments?: { path?: string; command?: string };
					}>;
				};
			}>;

			// Map toolCallId → dirPath for ls/find results to look up
			const lsPaths = new Map<string, string>();
			const findPaths = new Map<string, string>();
			const readPaths = new Map<string, string>();

			// Cap at last 300 entries to prevent memory blowup on large sessions
			const capped = entries.slice(-300);
			let nodeCount = 0;
			for (const e of capped) {
				// Hard stop: don't build more than 500 nodes during replay
				if (nodeCount >= 500) break;
				if (e.type !== "message") continue;
				const m = e.message;
				if (!m) continue;

				if (m.role === "assistant") {
					const blocks = Array.isArray(m.content) ? m.content : [];
					for (const b of blocks) {
						if (b.type !== "toolCall") continue;

						if (b.name === "read") {
							const filePath = b.arguments?.path;
							if (filePath) {
								explorer.addFile(filePath);
								if (b.id) readPaths.set(b.id, filePath);
							}
						} else if (b.name === "ls") {
							const dirPath = path.resolve(cwd, b.arguments?.path || ".");
							explorer.ensureDir(dirPath);
							if (b.id) lsPaths.set(b.id, dirPath);
						} else if (b.name === "find") {
							const findDir = path.resolve(cwd, b.arguments?.path || ".");
							explorer.ensureDir(findDir);
							if (b.id) findPaths.set(b.id, findDir);
						}
					}
				} else if (m.role === "toolResult" && m.toolName === "ls") {
					const dirPath = lsPaths.get(m.toolCallId ?? "");
					if (!dirPath) continue;

					const blocks = Array.isArray(m.content) ? m.content : [];
					const rawText = blocks
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text ?? "")
						.join("");
					if (!rawText) continue;

					// Cap ls output to first 100 entries
					const parsed = parseLsOutput(rawText).slice(0, 100);
					if (parsed.length > 0) {
						explorer.populateDirectory(dirPath, parsed);
						nodeCount += parsed.length;
					}
				} else if (m.role === "toolResult" && m.toolName === "read") {
					const filePath = readPaths.get(m.toolCallId ?? "");
					if (!filePath) continue;

					const blocks = Array.isArray(m.content) ? m.content : [];
					const rawText = blocks
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text ?? "")
						.join("");
					if (rawText) {
						explorer.setFileSize(filePath, rawText.length);
					}
				} else if (m.role === "toolResult" && m.toolName === "find") {
					// find results are flat file paths — add each to the tree
					const blocks = Array.isArray(m.content) ? m.content : [];
					const rawText = blocks
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text ?? "")
						.join("");
					if (!rawText) continue;

					// Cap find results to first 100 paths
					const foundPaths = parseFindOutput(rawText, cwd).slice(0, 100);
					for (const fp of foundPaths) {
						explorer.addFile(fp);
						nodeCount++;
					}
				}
			}
		} finally {
			// Always register — tree might be empty but tab must exist
			registerTab();
		}
	});

	// ── Tool call: capture read + ls paths ────────────────────────────

	pi.on("tool_call", (event) => {
		if (event.toolName === "read") {
			const input = event.input as { path?: string };
			if (input.path) {
				explorer.addFile(input.path);
			}
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		} else if (event.toolName === "ls") {
			// Ensure directory node exists before results return.
			const input = event.input as { path?: string };
			const dirPath = path.resolve(cwd, input.path || ".");
			explorer.ensureDir(dirPath);
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		} else if (event.toolName === "find") {
			// Ensure search directory node exists.
			const input = event.input as { path?: string };
			const dirPath = path.resolve(cwd, input.path || ".");
			explorer.ensureDir(dirPath);
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		}
	});

	// ── Tool result: capture read content size + ls/find output ────────

	pi.on("tool_result", (event) => {
		if (event.toolName === "read") {
			const input = event.input as { path?: string };
			if (input.path) {
				const rawText = extractTextContent(event.content);
				if (rawText) {
					explorer.setFileSize(input.path, rawText.length);
					pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
				}
			}
			return;
		}
		if (event.toolName === "ls") {
			const input = event.input as { path?: string };
			const dirPath = path.resolve(cwd, input.path || ".");

			const rawText = extractTextContent(event.content);
			if (!rawText) return;

			const entries = parseLsOutput(rawText);
			if (entries.length > 0) {
				explorer.populateDirectory(dirPath, entries);
				pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
			}
		} else if (event.toolName === "find") {
			const rawText = extractTextContent(event.content);
			if (!rawText) return;

			// find returns flat file paths — add each to the tree
			const foundPaths = parseFindOutput(rawText, cwd).slice(0, 100);
			for (const fp of foundPaths) {
				explorer.addFile(fp);
			}
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		}
	});

	// ── Fallback registration ────────────────────────────────────────

	pi.events.on("sidepanel:ready", () => {
		if (!registered) registerTab();
	});
}
