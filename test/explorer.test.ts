/**
 * pi-sidepanel-explorer unit tests
 *
 * Tests the REAL tree data model from ../explorer.ts (no mirrors):
 * tree building, flattening, wasRead propagation, ls parsing, input
 * handling, rendering, and the prune/eviction bookkeeping invariants.
 *
 * Run: node --test test/explorer.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ExplorerComponent,
	connector,
	indentPrefix,
	parseLsOutput,
	parseFindOutput,
} from "../explorer.ts";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "./_harness/pi-tui-stub.mjs";

const CWD = "/cwd";

function makeComp(): ExplorerComponent {
	return new ExplorerComponent(CWD, {
		matchesKey,
		truncateToWidth,
		visibleWidth,
	});
}

/** Content lines of a render: drop trailing padding and the footer row. */
function contentLines(
	comp: ExplorerComponent,
	width = 40,
	height = 12,
): string[] {
	const lines = comp.render(width, height);
	return lines.slice(0, -1).filter((l) => l !== "");
}

// ── Tree data model ───────────────────────────────────────────────────────

describe("Tree data model", () => {
	it("starts empty", () => {
		const c = makeComp();
		assert.equal(c.getFlatEntries().length, 0);
		assert.ok(c.render(40, 8).some((l) => l.includes("No files explored yet")));
	});

	it("addFile creates file and parent dirs", () => {
		const c = makeComp();
		c.addFile("/cwd/src/app.ts");

		const flat = c.getFlatEntries();
		assert.equal(flat.length, 2); // src/ + app.ts

		assert.equal(flat[0]!.node.name, "src");
		assert.equal(flat[0]!.node.type, "directory");
		assert.equal(flat[0]!.depth, 0);
		assert.equal(flat[0]!.isLast, true);

		assert.equal(flat[1]!.node.name, "app.ts");
		assert.equal(flat[1]!.node.type, "file");
		assert.equal(flat[1]!.depth, 1);
		assert.equal(flat[1]!.isLast, true);
	});

	it("multiple files in same directory share parent", () => {
		const c = makeComp();
		c.addFile("/cwd/src/a.ts");
		c.addFile("/cwd/src/b.ts");

		const flat = c.getFlatEntries();
		assert.equal(flat.length, 3); // src/, a.ts, b.ts
		assert.equal(flat[0]!.node.name, "src");
		assert.equal(flat[1]!.node.name, "a.ts");
		assert.equal(flat[1]!.isLast, false);
		assert.equal(flat[2]!.node.name, "b.ts");
		assert.equal(flat[2]!.isLast, true);
	});

	it("nested directories work", () => {
		const c = makeComp();
		c.addFile("/cwd/a/b/c/d.ts");

		const flat = c.getFlatEntries();
		assert.equal(flat.length, 4);
		assert.deepEqual(
			flat.map((e) => e.node.name),
			["a", "b", "c", "d.ts"],
		);
		assert.deepEqual(
			flat.map((e) => e.depth),
			[0, 1, 2, 3],
		);
	});

	it("files outside cwd are ignored", () => {
		const c = makeComp();
		c.addFile("/tmp/outside.ts");
		assert.equal(c.getFlatEntries().length, 0);
	});

	it("addFile on already-present ls file marks it as read", () => {
		const c = makeComp();
		c.populateDirectory(CWD, [{ name: "readme.md", isDir: false }]);
		assert.equal(c.getNode("/cwd/readme.md")!.wasRead, false);

		c.addFile("/cwd/readme.md");
		assert.equal(c.getNode("/cwd/readme.md")!.wasRead, true);
	});
});

// ── wasRead propagation ───────────────────────────────────────────────────

describe("wasRead propagation", () => {
	it("propagates up to all ancestors", () => {
		const c = makeComp();
		c.addFile("/cwd/very/deep/path/file.ts");

		assert.equal(c.getNode("/cwd/very/deep/path/file.ts")!.wasRead, true);
		assert.equal(c.getNode("/cwd/very/deep/path")!.wasRead, true);
		assert.equal(c.getNode("/cwd/very/deep")!.wasRead, true);
		assert.equal(c.getNode("/cwd/very")!.wasRead, true);
	});

	it("does not mark siblings as read", () => {
		const c = makeComp();
		c.populateDirectory(CWD, [
			{ name: "pkg", isDir: true },
			{ name: "main.ts", isDir: false },
		]);
		assert.equal(c.getNode("/cwd/pkg")!.wasRead, false);
		assert.equal(c.getNode("/cwd/main.ts")!.wasRead, false);

		c.addFile("/cwd/main.ts");
		assert.equal(c.getNode("/cwd/main.ts")!.wasRead, true);
		assert.equal(c.getNode("/cwd/pkg")!.wasRead, false);
	});
});

// ── populateDirectory / ls parsing ────────────────────────────────────────

describe("populateDirectory / ls parsing", () => {
	it("parses ls output with dirs and files", () => {
		const output = ".git/\nsrc/\nindex.ts\npackage.json\nREADME.md\n";
		const entries = parseLsOutput(output);

		assert.equal(entries.length, 5);
		assert.deepEqual(entries[0], { name: ".git", isDir: true });
		assert.deepEqual(entries[1], { name: "src", isDir: true });
		assert.deepEqual(entries[3], { name: "package.json", isDir: false });
	});

	it("skips (empty directory) and truncation notices", () => {
		const output = "(empty directory)\ndata.ts\nmore lines";
		const entries = parseLsOutput(output);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.name, "data.ts");
	});

	it("skips truncation bracket notices", () => {
		const output = "file.ts\n[Truncated: 500 entries limit]";
		const entries = parseLsOutput(output);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.name, "file.ts");
	});

	it("parseFindOutput resolves relative paths against cwd", () => {
		const paths = parseFindOutput("src/a.ts\n/abs/b.ts\n[truncated]", CWD);
		assert.deepEqual(paths, ["/cwd/src/a.ts", "/abs/b.ts"]);
	});

	it("populates the cwd itself: children become tree roots (regression — ls of the project root used to be ignored)", () => {
		const c = makeComp();
		c.populateDirectory(CWD, [
			{ name: "src", isDir: true },
			{ name: "index.ts", isDir: false },
		]);

		const flat = c.getFlatEntries();
		assert.equal(flat.length, 2);
		assert.equal(flat[0]!.node.name, "src"); // dirs first
		assert.equal(flat[0]!.depth, 0);
		assert.equal(flat[1]!.node.name, "index.ts");
		assert.equal(flat[1]!.depth, 0);
	});

	it("merges with existing children on repeat populate", () => {
		const c = makeComp();
		c.populateDirectory(CWD, [{ name: "a.ts", isDir: false }]);
		c.populateDirectory(CWD, [{ name: "b.ts", isDir: false }]);

		const flat = c.getFlatEntries();
		assert.deepEqual(
			flat.map((e) => e.node.name),
			["a.ts", "b.ts"],
		);
	});

	it("auto-creates a missing subdirectory and expands it", () => {
		const c = makeComp();
		c.populateDirectory("/cwd/sub", [{ name: "file.ts", isDir: false }]);

		const subNode = c.getNode("/cwd/sub")!;
		assert.equal(subNode.type, "directory");
		assert.equal(subNode.expanded, true);
		assert.equal(subNode.children.length, 1);
		assert.equal(subNode.children[0]!.name, "file.ts");
	});
});

// ── Flattening and collapse ───────────────────────────────────────────────

describe("Flattening and collapse", () => {
	it("Spacebar collapses the direct parent, not the root", () => {
		const c = makeComp();
		// Tree: src/ → sub/ → deep/ → a.ts, b.ts
		c.addFile("/cwd/src/sub/deep/a.ts");
		c.addFile("/cwd/src/sub/deep/b.ts");
		// Cursor on a.ts (depth 3). Spacebar should collapse deep/ (parent).
		c.handleInput("j"); // → sub/
		c.handleInput("j"); // → deep/
		c.handleInput("j"); // → a.ts
		c.handleInput(" ");

		const flat = c.getFlatEntries();
		// src/ (expanded), sub/ (expanded), deep/ (collapsed) — 3 entries
		assert.equal(flat.length, 3);
		assert.equal(flat[0]!.node.name, "src");
		assert.equal(flat[0]!.node.expanded, true);
		assert.equal(flat[1]!.node.name, "sub");
		assert.equal(flat[1]!.node.expanded, true, "sub/ should still be expanded");
		assert.equal(flat[2]!.node.name, "deep");
		assert.equal(flat[2]!.node.expanded, false, "deep/ should be collapsed");
	});

	it("Spacebar on the root itself collapses it", () => {
		const c = makeComp();
		c.addFile("/cwd/src/a.ts");
		c.addFile("/cwd/src/b.ts");
		// Cursor on src/ (depth 0). Spacebar collapses src/.
		c.handleInput(" ");

		const flat = c.getFlatEntries();
		assert.equal(flat.length, 1);
		assert.equal(flat[0]!.node.name, "src");
		assert.equal(flat[0]!.node.expanded, false);
	});

	it("Enter toggles only the cursor dir, not ancestors", () => {
		const c = makeComp();
		// Create two separate roots: modules/ (with child) and src/ (with child)
		c.addFile("/cwd/modules/pi/index.ts");
		c.addFile("/cwd/src/app.ts");
		// Flat: modules/, pi/, index.ts, src/, app.ts (5 entries)
		assert.equal(c.getFlatEntries().length, 5);

		// Move cursor to modules/ (index 0) → j → pi/ (depth 1)
		c.handleInput("j");
		// Now on pi/. Enter → collapse pi/ only.
		c.handleInput("\r");

		const flat = c.getFlatEntries();
		// modules/ still expanded (shows pi/ + src/ + app.ts), pi/ collapsed
		assert.equal(flat[0]!.node.name, "modules");
		assert.equal(
			flat[0]!.node.expanded,
			true,
			"modules/ should still be expanded",
		);
		const piEntry = flat.find((e) => e.node.name === "pi");
		assert.ok(piEntry, "pi/ should still be visible (collapsed)");
		assert.equal(piEntry!.node.expanded, false, "pi/ should be collapsed");
		// index.ts should NOT be visible (child of collapsed pi/)
		assert.ok(
			!flat.some((e) => e.node.name === "index.ts"),
			"index.ts should be hidden when pi/ is collapsed",
		);
	});

	it("Enter collapses and re-expands the directory under the cursor", () => {
		const c = makeComp();
		c.addFile("/cwd/src/a.ts");
		c.addFile("/cwd/src/b.ts");
		assert.equal(c.getFlatEntries().length, 3);

		// Cursor starts at index 0 (src/) — Enter collapses it.
		c.handleInput("\r");
		assert.equal(c.getFlatEntries().length, 1);

		c.handleInput("\r");
		assert.equal(c.getFlatEntries().length, 3);
	});

	it("ancestorLast tracks non-last ancestors correctly", () => {
		const c = makeComp();
		c.addFile("/cwd/a-src/a.ts");
		c.addFile("/cwd/a-src/b.ts");
		c.addFile("/cwd/z-lib/x.ts");

		const flat = c.getFlatEntries();
		const srcEntry = flat.find((e) => e.node.name === "a-src")!;
		assert.equal(srcEntry.isLast, false);

		const libEntry = flat.find((e) => e.node.name === "z-lib")!;
		assert.equal(libEntry.isLast, true);

		const aEntry = flat.find((e) => e.node.name === "a.ts")!;
		assert.equal(aEntry.ancestorLast[0], false);
	});

	it("all entries are last in a single-branch tree", () => {
		const c = makeComp();
		c.addFile("/cwd/src/sub/deep/file.ts");

		for (const e of c.getFlatEntries()) {
			assert.equal(e.isLast, true, `${e.node.name} should be last`);
		}
	});
});

// ── ensureDir ─────────────────────────────────────────────────────────────

describe("ensureDir", () => {
	it("creates empty directory node", () => {
		const c = makeComp();
		c.ensureDir("/cwd/pkg");

		const node = c.getNode("/cwd/pkg")!;
		assert.equal(node.type, "directory");
		assert.equal(node.children.length, 0);
		assert.equal(node.wasRead, false);
	});

	it("is idempotent", () => {
		const c = makeComp();
		c.ensureDir("/cwd/pkg");
		c.ensureDir("/cwd/pkg");
		assert.equal(c.getFlatEntries().length, 1);
		assert.equal(c.nodeCount, 1);
	});

	it("treats the cwd as the implicit root (no node)", () => {
		const c = makeComp();
		c.ensureDir(CWD);
		assert.equal(c.nodeCount, 0);
	});
});

// ── Rendering ─────────────────────────────────────────────────────────────

describe("Render output shape", () => {
	it("single-file tree renders with cursor and connectors", () => {
		const c = makeComp();
		c.addFile("/cwd/src/index.ts");

		assert.deepEqual(contentLines(c), [">└── src/", "     └── index.ts"]);
	});

	it("complex tree renders correctly", () => {
		const c = makeComp();
		c.addFile("/cwd/src/sub/deep/file.ts");
		c.addFile("/cwd/src/other.ts");

		assert.deepEqual(contentLines(c), [
			">└── src/",
			"     ├── sub/",
			"     │   └── deep/",
			"     │       └── file.ts",
			"     └── other.ts",
		]);
	});

	it("cursor only appears on the cursor line", () => {
		const c = makeComp();
		c.addFile("/cwd/src/a.ts");
		c.addFile("/cwd/src/b.ts");

		let lines = contentLines(c);
		assert.ok(lines[0]!.startsWith(">"));
		assert.ok(lines.slice(1).every((l) => l.startsWith(" ")));

		c.handleInput("j"); // cursor down → a.ts
		lines = contentLines(c);
		assert.ok(lines[0]!.startsWith(" "));
		assert.ok(lines[1]!.startsWith(">"));
	});

	it("pins the keymap footer to the bottom row", () => {
		const c = makeComp();
		c.addFile("/cwd/a.ts");
		const lines = c.render(50, 10);
		assert.equal(lines.length, 10);
		assert.ok(lines[9]!.includes("j/k navigate"));
	});

	it("connector is always 4 chars; indent multiples of 4", () => {
		assert.equal(connector(true).length, 4);
		assert.equal(connector(false).length, 4);
		assert.equal(indentPrefix([], 0).length, 0);
		assert.equal(indentPrefix([true], 1).length, 4);
		assert.equal(indentPrefix([true, false], 2).length, 8);
		assert.equal(indentPrefix([true, true, true], 3).length, 12);
	});
});

// ── Sorting ───────────────────────────────────────────────────────────────

describe("Sorting", () => {
	it("directories sort before files", () => {
		const c = makeComp();
		c.addFile("/cwd/z-file.ts");
		c.addFile("/cwd/a-dir/x.ts");

		const flat = c.getFlatEntries();
		assert.equal(flat[0]!.node.name, "a-dir");
		assert.equal(flat[1]!.node.name, "x.ts");
		assert.equal(flat[2]!.node.name, "z-file.ts");
	});

	it("alphabetical within same type", () => {
		const c = makeComp();
		c.addFile("/cwd/beta.ts");
		c.addFile("/cwd/alpha.ts");
		c.addFile("/cwd/gamma.ts");

		assert.deepEqual(
			c.getFlatEntries().map((e) => e.node.name),
			["alpha.ts", "beta.ts", "gamma.ts"],
		);
	});

	it("case-insensitive sort", () => {
		const c = makeComp();
		c.addFile("/cwd/Zebra.ts");
		c.addFile("/cwd/apple.ts");

		assert.deepEqual(
			c.getFlatEntries().map((e) => e.node.name),
			["apple.ts", "Zebra.ts"],
		);
	});
});

// ── Bookkeeping invariants (prune + eviction regressions) ─────────────────

describe("nodeMap/nodeOrder bookkeeping", () => {
	it("orderCount always equals nodeCount", () => {
		const c = makeComp();
		c.addFile("/cwd/src/a.ts");
		c.populateDirectory("/cwd/src", [
			{ name: "b.ts", isDir: false },
			{ name: "sub", isDir: true },
		]);
		c.populateDirectory("/cwd/src/sub", [{ name: "deep.ts", isDir: false }]);
		assert.equal(c.orderCount, c.nodeCount);
	});

	it("l-refresh of a directory prunes descendants from the bookkeeping (regression: leak + duplicate order entries)", () => {
		const c = makeComp();
		c.setToolInvoker(() => {});
		c.populateDirectory("/cwd/pkg", [
			{ name: "sub", isDir: true },
			{ name: "x.ts", isDir: false },
		]);
		c.populateDirectory("/cwd/pkg/sub", [{ name: "deep.ts", isDir: false }]);
		const before = c.nodeCount;
		assert.equal(c.orderCount, before);

		// Cursor is on /cwd/pkg (flat index 0); l clears + re-requests ls.
		c.handleInput("l");
		assert.equal(c.getNode("/cwd/pkg/sub"), undefined, "descendant pruned");
		assert.equal(c.getNode("/cwd/pkg/sub/deep.ts"), undefined);
		assert.equal(c.getNode("/cwd/pkg/x.ts"), undefined);
		assert.equal(c.orderCount, c.nodeCount, "no orphaned order entries");

		// Fresh ls result repopulates without duplicate order entries.
		c.populateDirectory("/cwd/pkg", [
			{ name: "sub", isDir: true },
			{ name: "x.ts", isDir: false },
		]);
		assert.ok(c.getNode("/cwd/pkg/sub"));
		assert.equal(c.orderCount, c.nodeCount);
	});

	it("repeat populate of the same directory does not duplicate order entries", () => {
		const c = makeComp();
		c.populateDirectory("/cwd/pkg", [{ name: "a.ts", isDir: false }]);
		c.populateDirectory("/cwd/pkg", [{ name: "a.ts", isDir: false }]);
		assert.equal(c.orderCount, c.nodeCount);
	});
});

// ── L-key tool invocation ─────────────────────────────────────────────────

describe("L-key tool invocation", () => {
	it("requests read for an unread file and marks it pending", () => {
		const c = makeComp();
		const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
		c.setToolInvoker((tool, input) => calls.push({ tool, input }));

		c.populateDirectory(CWD, [{ name: "notes.txt", isDir: false }]);
		c.handleInput("l"); // cursor on notes.txt (only entry)

		assert.deepEqual(calls, [
			{ tool: "read", input: { path: "/cwd/notes.txt" } },
		]);

		// Already pending → no duplicate request.
		c.handleInput("l");
		assert.equal(calls.length, 1);
	});

	it("does not re-request an already-read file", () => {
		const c = makeComp();
		const calls: unknown[] = [];
		c.setToolInvoker((tool, input) => calls.push({ tool, input }));

		c.addFile("/cwd/done.ts"); // wasRead = true, single flat entry... plus none
		// Cursor on the file (flat index 0 is done.ts since no parent dirs)
		c.handleInput("l");
		assert.equal(calls.length, 0);
	});
});

// ── AGENTS.md pre-scan ───────────────────────────────────────────────────

describe("AGENTS.md pre-scan (addDiscoveredFile)", () => {
	it("adds file nodes without marking as read (wasRead=false)", () => {
		const c = makeComp();
		c.addDiscoveredFile("/cwd/AGENTS.md");

		const node = c.getNode("/cwd/AGENTS.md")!;
		assert.ok(node, "AGENTS.md should be in the tree");
		assert.equal(node.type, "file");
		assert.equal(node.wasRead, false, "should NOT be marked as read");
	});

	it("creates parent directories for discovered files", () => {
		const c = makeComp();
		c.addDiscoveredFile("/cwd/src/sub/AGENTS.md");

		const src = c.getNode("/cwd/src")!;
		assert.equal(src.type, "directory");
		assert.equal(src.wasRead, false);

		const sub = c.getNode("/cwd/src/sub")!;
		assert.equal(sub.type, "directory");
		assert.equal(sub.wasRead, false);

		const md = c.getNode("/cwd/src/sub/AGENTS.md")!;
		assert.equal(md.type, "file");
		assert.equal(md.wasRead, false);
	});

	it("pre-scanned file turns wasRead=true when agent reads it", () => {
		const c = makeComp();
		c.addDiscoveredFile("/cwd/AGENTS.md");
		assert.equal(c.getNode("/cwd/AGENTS.md")!.wasRead, false, "pre: not read");

		// Agent reads the file (via addFile)
		c.addFile("/cwd/AGENTS.md");
		assert.equal(c.getNode("/cwd/AGENTS.md")!.wasRead, true, "post: now read");
	});

	it("pre-scanned AGENTS.md appears in the flat list", () => {
		const c = makeComp();
		c.addDiscoveredFile("/cwd/AGENTS.md");
		c.addDiscoveredFile("/cwd/src/AGENTS.md");

		const flat = c.getFlatEntries();
		const names = flat.map((e) => e.node.name);
		assert.ok(names.includes("AGENTS.md"), "root AGENTS.md should be listed");
		assert.ok(names.includes("src"), "src directory should be listed");
	});

	it("addDiscoveredFile is idempotent", () => {
		const c = makeComp();
		c.addDiscoveredFile("/cwd/AGENTS.md");
		const count1 = c.nodeCount;
		c.addDiscoveredFile("/cwd/AGENTS.md");
		assert.equal(c.nodeCount, count1, "should not duplicate");
	});
});
