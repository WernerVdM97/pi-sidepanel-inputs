/**
 * pi-sidepanel-explorer — File explorer tree tab for pi-sidepanel
 *
 * Builds a collapsible tree of directories and files as the agent
 * explores them via `read` and `ls` tool invocations. Navigation:
 * j/k (or down/up), Enter to toggle directory collapse/expand.
 *
 * Registers via `sidepanel:register` — requires pi-sidepanel.
 * Purely event wiring — tree model and rendering live in ./explorer.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
	ExplorerComponent,
	parseFindOutput,
	parseLsOutput,
	type ThemeColors,
} from "./explorer.ts";

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

// ── AGENTS.md pre-scan ───────────────────────────────────────────────────

/** Maximum directory depth for AGENTS.md pre-scan. */
const MAX_SCAN_DEPTH = 8;
/** Maximum AGENTS.md files to pre-load (perf safety). */
const MAX_AGENTS_FILES = 50;
/** Directories to skip during pre-scan. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"vendor",
	"target", // Rust
	".direnv",
]);

/** Recursively scan a directory for AGENTS.md files, adding them
 *  to the explorer tree as unloaded (wasRead=false). */
async function preScanAgentsMd(
	startDir: string,
	explorer: ExplorerComponent,
): Promise<void> {
	let found = 0;
	const pending: Array<{ dir: string; depth: number }> = [
		{ dir: startDir, depth: 0 },
	];

	while (pending.length > 0 && found < MAX_AGENTS_FILES) {
		const { dir, depth } = pending.shift()!;
		if (depth > MAX_SCAN_DEPTH) continue;

		let entries: fs.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue; // permission denied, etc.
		}

		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
					pending.push({
						dir: path.join(dir, e.name),
						depth: depth + 1,
					});
				}
			} else if (e.name === "AGENTS.md") {
				explorer.addDiscoveredFile(path.join(dir, e.name));
				found++;
				if (found >= MAX_AGENTS_FILES) break;
			}
		}
	}
}

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const explorer = new ExplorerComponent(cwd, {
		matchesKey,
		truncateToWidth,
		visibleWidth,
	});
	let registered = false;

	// Wire L-key tool invoker: send read/ls as user prompt to the agent.
	// Uses deliverAs: "followUp" so it queues when the agent is busy.
	// Marks path as pending (warning color) until agent processes it.
	// Source: pi.sendUserMessage() — extensions.md
	// (The component marks the path pending itself before invoking.)
	explorer.setToolInvoker((toolName, input) => {
		const targetPath = input.path as string;
		pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		if (toolName === "ls") {
			pi.sendUserMessage(`list the contents of ${targetPath}`, {
				deliverAs: "followUp",
			});
		} else if (toolName === "read") {
			pi.sendUserMessage(`read the file ${targetPath}`, {
				deliverAs: "followUp",
			});
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
				render(width: number, height?: number): string[] {
					return explorer.render(width, height);
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

		// Pre-scan project for AGENTS.md files — show them grey until the
		// agent reads them (session replay below marks already-read ones).
		preScanAgentsMd(cwd, explorer).catch(() => {});

		// Register immediately, flag busy, and yield a frame so the loading
		// placeholder paints before the synchronous replay runs.
		registerTab();
		pi.events.emit("sidepanel:busy", {
			tabId: "explorer",
			busy: true,
			message: "replaying session…",
		});
		await new Promise((resolve) => setTimeout(resolve, 24));

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

		} catch {
			// Replay failed — tab already registered with empty state
		} finally {
			// Clear the busy flag and re-render with the replayed tree.
			pi.events.emit("sidepanel:busy", { tabId: "explorer", busy: false });
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		}
	});

	// ── Tool call: capture read + ls paths ────────────────────────────

	pi.on("tool_call", (event) => {
		if (event.toolName === "read") {
			const input = event.input as { path?: string };
			if (input.path) {
				// Resolve to absolute — pre-scan uses absolute paths
				const absPath = path.resolve(cwd, input.path);
				explorer.clearPending(absPath);
				explorer.addFile(absPath);
			}
			pi.events.emit("sidepanel:invalidate", { tabId: "explorer" });
		} else if (event.toolName === "ls") {
			// Ensure directory node exists before results return.
			const input = event.input as { path?: string };
			const dirPath = path.resolve(cwd, input.path || ".");
			explorer.clearPending(dirPath);
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
				const absPath = path.resolve(cwd, input.path);
				const rawText = extractTextContent(event.content);
				if (rawText) {
					explorer.setFileSize(absPath, rawText.length);
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
	//
	// The framework resets its registry on ITS session_start and then emits
	// "sidepanel:ready". If this extension's session_start handler ran first,
	// the registration was wiped — re-register unconditionally (a guard on
	// `registered` would skip the recovery; it's already true). Registration
	// is idempotent: the framework dedups by id.

	pi.events.on("sidepanel:ready", () => {
		registered = false;
		registerTab();
	});
}
