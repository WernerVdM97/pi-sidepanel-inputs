/**
 * Test stub for @earendil-works/pi-tui, resolved in place of the real
 * package by stub-hooks.mjs.
 *
 * Width handling is ANSI-aware but simplified (no wide-character or
 * grapheme support) — good enough for behavioural assertions, not for
 * pixel-perfect layout. Canonical copy lives in pi-sidepanel/test/_harness/.
 */

const ANSI_RE = /\x1b\[[0-9;?=]*[A-Za-z]/g;

export function visibleWidth(str) {
	let width = 0;
	for (const _ch of String(str).replace(ANSI_RE, "")) width++;
	return width;
}

export function truncateToWidth(str, width, ellipsis = "...", _pad) {
	str = String(str);
	if (visibleWidth(str) <= width) return str;
	const target = Math.max(0, width - visibleWidth(ellipsis));
	let out = "";
	let w = 0;
	let i = 0;
	while (i < str.length && w < target) {
		if (str[i] === "\x1b") {
			const m = str.slice(i).match(/^\x1b\[[0-9;?=]*[A-Za-z]/);
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		out += str[i];
		w++;
		i++;
	}
	return out + ellipsis;
}

/** Key-name → raw byte sequences, covering the keys sidepanel code uses. */
const KEYMAP = {
	tab: ["\t"],
	"shift+tab": ["\x1b[Z"],
	enter: ["\r", "\n"],
	escape: ["\x1b"],
	backspace: ["\x7f", "\b"],
	up: ["\x1b[A"],
	down: ["\x1b[B"],
	left: ["\x1b[D"],
	right: ["\x1b[C"],
	pageup: ["\x1b[5~"],
	pagedown: ["\x1b[6~"],
	home: ["\x1b[H", "\x1b[1~"],
	end: ["\x1b[F", "\x1b[4~"],
	f2: ["\x1bOQ", "\x1b[12~"],
	f3: ["\x1bOR", "\x1b[13~"],
	"ctrl+c": ["\x03"],
};

export function matchesKey(data, key) {
	return (KEYMAP[key] ?? []).includes(data);
}
