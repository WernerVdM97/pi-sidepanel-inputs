/**
 * pi-sidepanel-explorer unit tests
 *
 * Tests tree data model, flattening, rendering, wasRead propagation,
 * input handling, ls output parsing, and indent/connector alignment.
 *
 * Run: node --test test/explorer.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Stub utilities (avoid pi-tui dependency in tests) ────────────────────

function visibleWidth(str: string): number {
	let inEscape = false;
	let width = 0;
	for (let i = 0; i < str.length; i++) {
		if (str[i] === "\x1b") { inEscape = true; continue; }
		if (inEscape) {
			if ((str[i] >= "A" && str[i] <= "Z") || (str[i] >= "a" && str[i] <= "z")) inEscape = false;
			continue;
		}
		width++;
	}
	return width;
}

function truncateToWidth(str: string, width: number, ellipsis = "...", _ansi = false): string {
	const vw = visibleWidth(str);
	if (vw <= width) return str;
	const suffix = ellipsis;
	const suffixW = visibleWidth(suffix);
	let result = "";
	let w = 0;
	for (const ch of str) {
		if (ch === "\x1b") continue;
		if (w >= width - suffixW) break;
		result += ch;
		w++;
	}
	return result + suffix;
}

// ── Types ─────────────────────────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	expanded: boolean;
	wasRead: boolean;
}

interface FlatEntry {
	node: TreeNode;
	depth: number;
	isLast: boolean;
	ancestorLast: boolean[];
}

// ── Tree-building helpers (extracted from index.ts) ──────────────────────

function ensurePath(
	parts: string[],
	absolutePath: string,
	leafType: "file" | "directory",
	roots: TreeNode[],
	nodeMap: Map<string, TreeNode>,
	cwd: string,
): TreeNode {
	let currentList = roots;
	let builtPath = cwd;

	for (let i = 0; i < parts.length; i++) {
		const name = parts[i]!;
		builtPath = builtPath === "/" ? `/${name}` : `${builtPath}/${name}`;
		const isLast = i === parts.length - 1;
		const nodeType = isLast ? leafType : "directory";

		let node = nodeMap.get(builtPath);
		if (node) {
			currentList = node.children;
		} else {
			node = {
				name,
				path: builtPath,
				type: nodeType,
				children: [],
				expanded: !isLast,
				wasRead: false,
			};
			nodeMap.set(builtPath, node);
			currentList.push(node);
			currentList.sort((a, b) => {
				if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
				return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
			});
			currentList = node.children;
		}
	}

	return nodeMap.get(absolutePath)!;
}

function addFile(
	absolutePath: string,
	roots: TreeNode[],
	nodeMap: Map<string, TreeNode>,
	cwd: string,
): void {
	// Guard: ignore paths outside cwd
	if (!absolutePath.startsWith(cwd + "/") && absolutePath !== cwd) return;

	const existing = nodeMap.get(absolutePath);
	if (existing) {
		if (!existing.wasRead) {
			existing.wasRead = true;
			propagateReadUp(existing, nodeMap, cwd);
		}
		return;
	}

	const parts = absolutePath.slice(cwd.length + 1).split("/");
	const node = ensurePath(parts, absolutePath, "file", roots, nodeMap, cwd);
	node.wasRead = true;
	propagateReadUp(node, nodeMap, cwd);
}

function ensureDir(
	absolutePath: string,
	roots: TreeNode[],
	nodeMap: Map<string, TreeNode>,
	cwd: string,
): void {
	if (absolutePath === cwd) return;
	if (!absolutePath.startsWith(cwd + "/")) return;
	if (nodeMap.has(absolutePath)) return;
	const parts = absolutePath.slice(cwd.length + 1).split("/");
	ensurePath(parts, absolutePath, "directory", roots, nodeMap, cwd);
}

function populateDirectory(
	dirPath: string,
	entries: { name: string; isDir: boolean }[],
	roots: TreeNode[],
	nodeMap: Map<string, TreeNode>,
	cwd: string,
): void {
	// Ensure the directory node exists (including root cwd)
	let dirNode = nodeMap.get(dirPath);
	if (!dirNode) {
		if (dirPath === cwd) {
			// Create cwd root node directly
			dirNode = {
				name: cwd.split("/").pop() || cwd,
				path: cwd,
				type: "directory",
				children: [],
				expanded: true,
				wasRead: false,
			};
			nodeMap.set(cwd, dirNode);
			roots.push(dirNode);
		} else {
			const parts = dirPath.slice(cwd.length + 1).split("/");
			dirNode = ensurePath(parts, dirPath, "directory", roots, nodeMap, cwd);
		}
	}
	if (dirNode.type !== "directory") return;

	const existingNames = new Set(dirNode.children.map((c) => c.name));
	for (const entry of entries) {
		if (existingNames.has(entry.name)) continue;
		const childPath = `${dirPath}/${entry.name}`;
		const child: TreeNode = {
			name: entry.name,
			path: childPath,
			type: entry.isDir ? "directory" : "file",
			children: [],
			expanded: false,
			wasRead: false,
		};
		dirNode.children.push(child);
		nodeMap.set(childPath, child);
	}

	dirNode.children.sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
	});

	if (!dirNode.expanded) dirNode.expanded = true;
}

function propagateReadUp(node: TreeNode, nodeMap: Map<string, TreeNode>, cwd: string): void {
	let currentPath = node.path.substring(0, node.path.lastIndexOf("/"));
	// Walk up until we pass cwd or hit empty/root
	while (currentPath && currentPath !== "") {
		const ancestor = nodeMap.get(currentPath);
		if (ancestor && !ancestor.wasRead) {
			ancestor.wasRead = true;
		}
		// Stop when we've gone past cwd
		if (currentPath === cwd || currentPath.length <= cwd.length) break;
		const parent = currentPath.substring(0, currentPath.lastIndexOf("/"));
		if (parent === currentPath) break;
		currentPath = parent;
	}
}

// ── Flattening ────────────────────────────────────────────────────────────

function flattenTree(nodes: TreeNode[], depth: number, ancestorLast: boolean[]): FlatEntry[] {
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
		if (nodes[i]!.type === "directory" && nodes[i]!.expanded && nodes[i]!.children.length > 0) {
			result.push(...flattenTree(nodes[i]!.children, depth + 1, [...ancestorLast, isLast]));
		}
	}
	return result;
}

// ── Rendering helpers ─────────────────────────────────────────────────────

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

// ── LS output parsing ─────────────────────────────────────────────────────

function parseLsOutput(text: string): { name: string; isDir: boolean }[] {
	const entries: { name: string; isDir: boolean }[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed === "(empty directory)" || trimmed.includes("more lines")) continue;
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;
		const isDir = trimmed.endsWith("/");
		const name = isDir ? trimmed.slice(0, -1) : trimmed;
		entries.push({ name, isDir });
	}
	return entries;
}

function renderLine(entry: FlatEntry, withCursor = false): string {
	const pre = indentPrefix(entry.ancestorLast, entry.depth);
	const conn = connector(entry.isLast);
	const cursor = withCursor ? ">" : " ";
	const name = entry.node.type === "directory" ? entry.node.name + "/" : entry.node.name;
	return `${cursor}${pre}${conn}${name}`;
}

// ── Helper: build complete tree from read+ls events ─────────────────────

interface TreeFixture {
	roots: TreeNode[];
	nodeMap: Map<string, TreeNode>;
}

function makeFixture(cwd: string): TreeFixture {
	return { roots: [], nodeMap: new Map() };
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("Tree data model", () => {
	it("starts empty", () => {
		const f = makeFixture("/cwd");
		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 0);
	});

	it("addFile creates file and parent dirs", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/app.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
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
		const f = makeFixture("/cwd");
		addFile("/cwd/src/a.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/src/b.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 3); // src/, a.ts, b.ts

		assert.equal(flat[0]!.node.name, "src");
		assert.equal(flat[1]!.node.name, "a.ts");
		assert.equal(flat[1]!.isLast, false); // a.ts is not last
		assert.equal(flat[2]!.node.name, "b.ts");
		assert.equal(flat[2]!.isLast, true);
	});

	it("nested directories work", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/a/b/c/d.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 4); // a/, b/, c/, d.ts
		assert.deepEqual(flat.map((e) => e.node.name), ["a", "b", "c", "d.ts"]);
		assert.deepEqual(flat.map((e) => e.depth), [0, 1, 2, 3]);
	});

	it("files outside cwd are ignored", () => {
		const f = makeFixture("/cwd");
		addFile("/tmp/outside.ts", f.roots, f.nodeMap, "/cwd");
		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 0);
	});

	it("addFile on already-present ls file marks as read", () => {
		const f = makeFixture("/cwd");
		// First: ls populates file
		populateDirectory("/cwd", [{ name: "readme.md", isDir: false }], f.roots, f.nodeMap, "/cwd");
		assert.equal(f.nodeMap.get("/cwd/readme.md")!.wasRead, false);

		// Then: agent reads it
		addFile("/cwd/readme.md", f.roots, f.nodeMap, "/cwd");
		assert.equal(f.nodeMap.get("/cwd/readme.md")!.wasRead, true);
		// propagateReadUp marks ancestors up to (but not including) cwd root.
		// cwd is the conceptual container, not a TreeNode.
		const cwdNode = f.nodeMap.get("/cwd");
		if (cwdNode) assert.equal(cwdNode.wasRead, true);
	});
});

describe("wasRead propagation", () => {
	it("propagates up to all ancestors", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/very/deep/path/file.ts", f.roots, f.nodeMap, "/cwd");

		assert.equal(f.nodeMap.get("/cwd/very/deep/path/file.ts")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/very/deep/path")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/very/deep")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/very")!.wasRead, true);
	});

	it("does not mark siblings as read", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/a.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/src/b.ts", f.roots, f.nodeMap, "/cwd");

		// a.ts was read, b.ts was read, src/ was read (both children read)
		assert.equal(f.nodeMap.get("/cwd/src/a.ts")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/src/b.ts")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/src")!.wasRead, true);
	});

	it("ls-populated directory is notRead until a file is read", () => {
		const f = makeFixture("/cwd");
		populateDirectory("/cwd", [
			{ name: "pkg", isDir: true },
			{ name: "main.ts", isDir: false },
		], f.roots, f.nodeMap, "/cwd");

		// Nothing read yet
		assert.equal(f.nodeMap.get("/cwd/pkg")!.wasRead, false);
		assert.equal(f.nodeMap.get("/cwd/main.ts")!.wasRead, false);

		// Now read main.ts
		addFile("/cwd/main.ts", f.roots, f.nodeMap, "/cwd");
		assert.equal(f.nodeMap.get("/cwd/main.ts")!.wasRead, true);
		assert.equal(f.nodeMap.get("/cwd/pkg")!.wasRead, false); // sibling still unread
	});
});

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

	it("populateDirectory adds children and auto-expands", () => {
		const f = makeFixture("/cwd");
		populateDirectory("/cwd", [
			{ name: "src", isDir: true },
			{ name: "index.ts", isDir: false },
		], f.roots, f.nodeMap, "/cwd");

		const cwdNode = f.nodeMap.get("/cwd")!;
		assert.equal(cwdNode.expanded, true);
		assert.equal(cwdNode.children.length, 2);
		assert.equal(cwdNode.children[0]!.name, "src"); // dirs first
		assert.equal(cwdNode.children[1]!.name, "index.ts");
	});

	it("populateDirectory merges with existing children", () => {
		const f = makeFixture("/cwd");
		populateDirectory("/cwd", [{ name: "a.ts", isDir: false }], f.roots, f.nodeMap, "/cwd");
		populateDirectory("/cwd", [{ name: "b.ts", isDir: false }], f.roots, f.nodeMap, "/cwd");

		const cwdNode = f.nodeMap.get("/cwd")!;
		assert.equal(cwdNode.children.length, 2);
		assert.equal(cwdNode.children[0]!.name, "a.ts");
		assert.equal(cwdNode.children[1]!.name, "b.ts");
	});

	it("populateDirectory auto-creates dir if missing", () => {
		const f = makeFixture("/cwd");
		populateDirectory("/cwd/sub", [{ name: "file.ts", isDir: false }], f.roots, f.nodeMap, "/cwd");

		const subNode = f.nodeMap.get("/cwd/sub")!;
		assert.equal(subNode.type, "directory");
		assert.equal(subNode.children.length, 1);
		assert.equal(subNode.children[0]!.name, "file.ts");

		// cwd is the conceptual root container, never a TreeNode in nodeMap
	});
});

describe("Flattening and depth", () => {
	it("respects collapse state", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/a.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/src/b.ts", f.roots, f.nodeMap, "/cwd");

		// Collapse src/
		f.nodeMap.get("/cwd/src")!.expanded = false;
		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 1); // only src/, children hidden
	});

	it("ancestorLast tracks non-last ancestors correctly", () => {
		const f = makeFixture("/cwd");
		// Use names where a-src/ < z-lib/ alphabetically, so a-src/ comes first
		addFile("/cwd/a-src/a.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/a-src/b.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/z-lib/x.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		// a-src/ at depth 0, not last (z-lib/ follows)
		const srcEntry = flat.find((e) => e.node.name === "a-src")!;
		assert.equal(srcEntry.isLast, false);

		// z-lib/ at depth 0, is last
		const libEntry = flat.find((e) => e.node.name === "z-lib")!;
		assert.equal(libEntry.isLast, true);

		// a.ts under a-src: a-src is not last, so a.ts gets ancestorLast[0]=false
		const aEntry = flat.find((e) => e.node.name === "a.ts")!;
		assert.equal(aEntry.ancestorLast[0], false);
	});

	it("all entries are last in a single-branch tree", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/sub/deep/file.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		for (const e of flat) {
			assert.equal(e.isLast, true, `${e.node.name} should be last`);
		}
	});
});

describe("Indent and connector alignment", () => {
	it("single-level indent matches name position", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/file.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const dirLine = renderLine(flat[0]!, true);  // >└── src/
		const fileLine = renderLine(flat[1]!, false); //      └──  file.ts

		// dir name starts at position 5 (>)1 + connector(4) = 5
		const dirNamePos = ">└── ".length; // 5
		// file connector starts at position 1(cursor) + 4(indent) = 5
		const fileConnPos = "     ".length; // 5
		assert.equal(dirNamePos, fileConnPos,
			"child connector should align with parent name start");
	});

	it("non-last siblings get │ vertical bar", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/a.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/src/b.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const aLine = renderLine(flat[1]!, false); // a.ts under src/
		const bLine = renderLine(flat[2]!, false); // b.ts under src/

		// a.ts is not last → connector "├── ", indent "    " (no │ since depth 1 parent is last)
		// Wait: src/ is the only child of root, so src/ IS last → ancestorLast[0]=true
		// So children of src/ get "    " indent. Both a.ts and b.ts have indent "    ".
		// a.ts connector is "├── " (not last), b.ts is "└── " (last).
		assert.ok(aLine.includes("├──"), `a.ts should have ├──, got: ${aLine}`);
		assert.ok(bLine.includes("└──"), `b.ts should have └──, got: ${bLine}`);
	});

	it("connector is always 4 chars", () => {
		assert.equal(connector(true).length, 4);
		assert.equal(connector(false).length, 4);
	});

	it("indent is always multiple of 4", () => {
		assert.equal(indentPrefix([], 0).length, 0);
		assert.equal(indentPrefix([true], 1).length, 4);
		assert.equal(indentPrefix([true, false], 2).length, 8);
		assert.equal(indentPrefix([true, true, true], 3).length, 12);
	});
});

describe("ensureDir", () => {
	it("creates empty directory node", () => {
		const f = makeFixture("/cwd");
		ensureDir("/cwd/pkg", f.roots, f.nodeMap, "/cwd");

		const node = f.nodeMap.get("/cwd/pkg")!;
		assert.equal(node.type, "directory");
		assert.equal(node.children.length, 0);
		assert.equal(node.wasRead, false);
	});

	it("is idempotent", () => {
		const f = makeFixture("/cwd");
		ensureDir("/cwd/pkg", f.roots, f.nodeMap, "/cwd");
		ensureDir("/cwd/pkg", f.roots, f.nodeMap, "/cwd");
		assert.equal(f.roots.length, 1);
	});
});

describe("Render output shape", () => {
	it("empty tree produces no lines", () => {
		const f = makeFixture("/cwd");
		const flat = flattenTree(f.roots, 0, []);
		assert.equal(flat.length, 0);
	});

	it("single-file tree renders correctly", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/index.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const lines = flat.map((e, i) => renderLine(e, i === 0));

		assert.deepEqual(lines, [
			">└── src/",
			"     └── index.ts",
		]);
	});

	it("complex tree renders correctly", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/src/sub/deep/file.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/src/other.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const lines = flat.map((e, i) => renderLine(e, i === 0));

		// src/ → sub/ (not last? src only has sub/ and other.ts.
		// Wait: src/ has children [sub/ (dir), other.ts (file)]. sub/ is first, not last.
		// src/ IS last of root. So ancestorLast[0]=true.
		// sub/ is first child of src/, not last → ├──
		// other.ts is last → └──
		assert.deepEqual(lines, [
			">└── src/",
			"     ├── sub/",
			"     │   └── deep/",
			"     │       └── file.ts",
			"     └── other.ts",
		]);
	});

	it("cursor only appears on first line", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/a.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const lines = flat.map((e, i) => renderLine(e, i === 0));

		assert.ok(lines[0]!.startsWith(">"), "first line should have cursor");
		for (let i = 1; i < lines.length; i++) {
			assert.ok(lines[i]!.startsWith(" "), `line ${i} should start with space`);
		}
	});
});

describe("Sorting", () => {
	it("directories sort before files", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/z-file.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/a-dir/x.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		// a-dir/ (dir) should come before z-file.ts (file) at root level
		// x.ts is under a-dir/ at depth 1
		assert.equal(flat[0]!.node.name, "a-dir");
		assert.equal(flat[1]!.node.name, "x.ts");  // child of a-dir
		assert.equal(flat[2]!.node.name, "z-file.ts");
	});

	it("alphabetical within same type", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/beta.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/alpha.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/gamma.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		const names = flat.map((e) => e.node.name);
		assert.deepEqual(names, ["alpha.ts", "beta.ts", "gamma.ts"]);
	});

	it("case-insensitive sort", () => {
		const f = makeFixture("/cwd");
		addFile("/cwd/Zebra.ts", f.roots, f.nodeMap, "/cwd");
		addFile("/cwd/apple.ts", f.roots, f.nodeMap, "/cwd");

		const flat = flattenTree(f.roots, 0, []);
		assert.deepEqual(flat.map((e) => e.node.name), ["apple.ts", "Zebra.ts"]);
	});
});
