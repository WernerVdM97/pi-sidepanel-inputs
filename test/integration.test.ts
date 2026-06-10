/**
 * pi-sidepanel-inputs integration tests
 *
 * Loads the REAL extension entry point (index.ts) against the FakePi
 * harness, covering registration, the sidepanel:ready recovery
 * handshake, session replay, live tool events, and the L-key prompt.
 *
 * The component resolves paths against process.cwd(), so fixtures use
 * real cwd-relative paths.
 *
 * Run: node --test test/integration.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as path from "node:path";
import {
	FakePi,
	captureBusy,
	captureRegistrations,
	sessionCtx,
} from "./_harness/fake-pi.ts";

register("./_harness/stub-hooks.mjs", import.meta.url);
const extension = (await import("../index.ts")).default;

const CWD = process.cwd();
const p = (rel: string) => path.join(CWD, rel);

function readCall(id: string, filePath: string) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", id, arguments: { path: filePath } },
			],
		},
	};
}

function readResult(id: string, text: string) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "read",
			toolCallId: id,
			content: [{ type: "text", text }],
		},
	};
}

describe("registration", () => {
	it("registers the explorer tab on session_start", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		assert.equal(regs.length, 1);
		assert.equal(regs[0].id, "explorer");
		assert.equal(regs[0].label, "Inputs");
	});

	it("re-registers on sidepanel:ready (load-order recovery)", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		pi.events.emit("sidepanel:ready", {});
		assert.equal(regs.length, 2);
		assert.equal(regs[1].id, "explorer");
	});

	it("flags busy with a message during replay, then clears", async () => {
		const pi = new FakePi();
		const busy = captureBusy(pi);
		extension(pi as any);

		await pi.fire("session_start", {}, sessionCtx());
		assert.equal(busy.length, 2);
		assert.equal(busy[0].busy, true);
		assert.equal(busy[0].message, "replaying session…");
		assert.equal(busy[1].busy, false);
	});
});

describe("session replay", () => {
	it("rebuilds the tree from read calls and sizes from results", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);

		const ctx = sessionCtx([
			readCall("r1", p("src/app.ts")),
			readResult("r1", "x".repeat(4000)),
		]);
		await pi.fire("session_start", {}, ctx);

		const lines: string[] = regs[0].component.render(50, 15);
		assert.ok(lines.some((l) => l.includes("src/")));
		assert.ok(
			lines.some((l) => l.includes("app.ts") && l.includes("1.0K")),
			`expected file with token badge, got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("live events", () => {
	async function freshTab(pi: FakePi) {
		const regs = captureRegistrations(pi);
		extension(pi as any);
		await pi.fire("session_start", {}, sessionCtx());
		return regs[0].component;
	}

	it("adds files from live read tool calls", async () => {
		const pi = new FakePi();
		const comp = await freshTab(pi);

		await pi.fire("tool_call", {
			toolName: "read",
			input: { path: p("lib/util.ts") },
		});
		const lines: string[] = comp.render(50, 15);
		assert.ok(lines.some((l) => l.includes("util.ts")));
	});

	it("populates the tree from an ls of the project root (regression: used to be ignored)", async () => {
		const pi = new FakePi();
		const comp = await freshTab(pi);

		await pi.fire("tool_call", { toolName: "ls", input: { path: "." } });
		await pi.fire("tool_result", {
			toolName: "ls",
			input: { path: "." },
			content: [{ type: "text", text: "src/\nREADME.md\n" }],
		});

		const lines: string[] = comp.render(50, 15);
		assert.ok(
			lines.some((l) => l.includes("README.md")),
			`root ls results must appear: ${JSON.stringify(lines)}`,
		);
		assert.ok(lines.some((l) => l.includes("src/")));
	});

	it("adds find results as read files", async () => {
		const pi = new FakePi();
		const comp = await freshTab(pi);

		await pi.fire("tool_result", {
			toolName: "find",
			input: { path: "." },
			content: [{ type: "text", text: "src/found.ts\n" }],
		});
		const lines: string[] = comp.render(50, 15);
		assert.ok(lines.some((l) => l.includes("found.ts")));
	});
});

describe("L-key prompt", () => {
	it("sends a follow-up user message asking to read the file", async () => {
		const pi = new FakePi();
		const regs = captureRegistrations(pi);
		extension(pi as any);
		await pi.fire("session_start", {}, sessionCtx());
		const comp = regs[0].component;

		// Surface a not-yet-read file via a root ls, then press l on it.
		await pi.fire("tool_result", {
			toolName: "ls",
			input: { path: "." },
			content: [{ type: "text", text: "notes.txt\n" }],
		});
		comp.handleInput("l");

		assert.equal(pi.sentMessages.length, 1);
		assert.equal(pi.sentMessages[0].text, `read the file ${p("notes.txt")}`);
		assert.deepEqual(pi.sentMessages[0].options, { deliverAs: "followUp" });
	});
});
