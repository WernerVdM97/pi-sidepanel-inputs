/**
 * Module-resolution hook mapping pi runtime packages to local test stubs,
 * so the production index.ts can be imported under plain `node --test`
 * (no pi runtime, no npm install).
 *
 * Activate from a test file BEFORE dynamically importing the extension:
 *
 *   import { register } from "node:module";
 *   register("./_harness/stub-hooks.mjs", import.meta.url);
 *   const extension = (await import("../index.ts")).default;
 *
 * The dynamic import is required: static imports resolve before register()
 * runs. Canonical copy lives in pi-sidepanel/test/_harness/.
 */

const STUBS = new Map([
	[
		"@earendil-works/pi-tui",
		new URL("./pi-tui-stub.mjs", import.meta.url).href,
	],
	[
		"@earendil-works/pi-coding-agent",
		new URL("./pi-coding-agent-stub.mjs", import.meta.url).href,
	],
]);

export async function resolve(specifier, context, nextResolve) {
	const stub = STUBS.get(specifier);
	if (stub) return { url: stub, shortCircuit: true };
	return nextResolve(specifier, context);
}
