/**
 * FakePi — minimal in-process fake of pi's ExtensionAPI, so extension
 * entry points (index.ts) can be exercised under plain `node --test`
 * without the pi runtime.
 *
 * Canonical copy lives in pi-sidepanel/test/_harness/. Tab-plugin repos
 * vendor an identical copy — keep them in sync when extending.
 */

type Handler = (...args: any[]) => unknown;

class FakeEventBus {
	private handlers = new Map<string, Handler[]>();

	on(name: string, handler: Handler): void {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
	}

	emit(name: string, payload?: unknown): void {
		for (const h of this.handlers.get(name) ?? []) h(payload);
	}
}

export class FakePi {
	/** Inter-extension event bus (pi.events). */
	events = new FakeEventBus();

	/** Recorded registrations, for driving and asserting. */
	commands = new Map<string, { description?: string; handler: Handler }>();
	shortcuts = new Map<string, { description?: string; handler: Handler }>();
	sentMessages: Array<{ text: string; options?: unknown }> = [];

	/** Tool definitions served by getAllTools()/getActiveTools(). */
	toolDefs: Array<{
		name: string;
		description?: string;
		parameters?: unknown;
	}> = [];
	activeToolNames: string[] = [];

	private hooks = new Map<string, Handler[]>();

	on(event: string, handler: Handler): void {
		const list = this.hooks.get(event) ?? [];
		list.push(handler);
		this.hooks.set(event, list);
	}

	/** Fire a pi lifecycle event, awaiting async handlers in registration
	 *  order (mirrors pi running extension hooks sequentially). */
	async fire(
		event: string,
		payload: unknown = {},
		ctx: unknown = {},
	): Promise<void> {
		for (const h of this.hooks.get(event) ?? []) {
			await h(payload, ctx);
		}
	}

	registerCommand(
		name: string,
		def: { description?: string; handler: Handler },
	): void {
		this.commands.set(name, def);
	}

	registerShortcut(
		key: string,
		def: { description?: string; handler: Handler },
	): void {
		this.shortcuts.set(key, def);
	}

	sendUserMessage(text: string, options?: unknown): void {
		this.sentMessages.push({ text, options });
	}

	getAllTools(): unknown[] {
		return this.toolDefs;
	}

	getActiveTools(): string[] {
		return this.activeToolNames;
	}
}

/** A ctx whose session manager serves the given (fixture) entries. */
export function sessionCtx(
	entries: unknown[] = [],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { sessionManager: { getEntries: () => entries }, ...extra };
}

/** Identity theme: passes text through without ANSI styling, so render
 *  assertions can match plain strings. */
export const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
};

/** Collect sidepanel:register payloads emitted on the bus. */
export function captureRegistrations(pi: FakePi): any[] {
	const captured: any[] = [];
	pi.events.on("sidepanel:register", (tab: any) => captured.push(tab));
	return captured;
}

/** Collect sidepanel:busy payloads emitted on the bus. */
export function captureBusy(pi: FakePi): any[] {
	const captured: any[] = [];
	pi.events.on("sidepanel:busy", (e: any) => captured.push(e));
	return captured;
}

/** Let setTimeout(…, 0)-scheduled work (e.g. the sidepanel:ready emit)
 *  run before continuing. */
export function tick(ms = 1): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
