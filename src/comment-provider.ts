import type { ProviderId } from "./providers.ts";
import { realpathSync } from "fs";
import * as path from "path";
import { piArgs } from "./pi-provider.ts";

/** Preserve user tools and permissions while reserving the invocation's transport and task. */
export function commentArgs(provider: ProviderId, args: string[]): string[] {
	if (provider === "pi") return piArgs(args);
	const reserved: Record<Exclude<ProviderId, "pi">, string[]> = {
		codex: ["--output-schema", "--output-last-message", "-o", "--json", "--color", "--cd", "-C", "--worktree"],
		claude: ["--verbose", "--no-verbose", "--output-format", "--input-format", "--json-schema", "--permission-prompts", "--permission-prompt-tool", "--print", "-p", "--continue", "-c", "--resume", "-r", "--session-id", "--fork-session"],
		opencode: ["--format", "--dir", "--command", "--continue", "-c", "--session", "-s", "--fork", "--attach", "--interactive", "-i"],
	};
	const takesValue: Record<Exclude<ProviderId, "pi">, string[]> = {
		codex: ["-c", "--config", "--profile", "-p", "--model", "-m", "--sandbox", "-s", "--add-dir", "--enable", "--disable", "--local-provider", "--thread-source"],
		claude: ["--model", "--effort", "--permission-mode", "--settings", "--setting-sources", "--mcp-config", "--agent", "--agents", "--add-dir", "--tools", "--allowed-tools", "--allowedTools", "--disallowed-tools", "--disallowedTools", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file", "--plugin-dir", "--max-turns", "--max-budget-usd"],
		opencode: ["--model", "-m", "--variant", "--agent", "--file", "-f", "--title", "--port", "--log-level"],
	};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i].split("=", 1)[0];
		const attached = /^-[a-zA-Z].+/.test(flag) && !flag.startsWith("--") ? flag.slice(0, 2) : flag;
		if (reserved[provider].includes(flag) || reserved[provider].includes(attached) || !flag.startsWith("-") || flag === "--") {
			throw new Error(`Comment runs control their prompt, output and session. Remove conflicting extra argument: ${args[i]}`);
		}
		if (!args[i].includes("=") && takesValue[provider].includes(flag)) {
			if (i + 1 >= args.length || args[i + 1].startsWith("-")) throw new Error(`Missing value for comment extra argument: ${flag}`);
			i++;
			if (provider === "claude" && ["--allowed-tools", "--allowedTools", "--disallowed-tools", "--disallowedTools", "--tools", "--add-dir", "--mcp-config", "--plugin-dir"].includes(flag)) {
				while (i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
			}
		}
	}
	// Deny only unresolved prompts; retain the user's permission mode, rules and integrations.
	return provider === "claude" ? [...args, "--permission-prompts", "none"] : [...args];
}

const GENERIC_PERMISSION_ERROR = "The agent needs permission that is not available to this unattended run. Configure the CLI's permissions outside Obsidian, then retry. Earlier actions may already have taken effect.";
const MAX_PERMISSION_ERROR = 500;
const MAX_TOOLS_NAMED = 3;
const MAX_TOOL_NAME = 80;
/** Tool names that may go into --allowed-tools. Anything else is named in the message but never suggested. */
const ALLOWABLE_TOOL = /^[A-Za-z][\w.:@-]{0,79}$/;
const SAFE_COMMAND_WORD = /^[\w./:@%+=~-]{1,80}$/;
/** Commands that run another command, so allowing them would allow anything. */
const WRAPPERS = new Set(["sudo", "su", "doas", "bash", "sh", "zsh", "fish", "env", "eval", "exec", "xargs", "command", "builtin", "nohup", "time", "nice", "timeout", "watch"]);

export interface CommentEventOptions {
	/** Absolute vault root, used to show file targets relative to the vault. */
	vaultRoot?: string;
	/** Spell out the denied tools for Claude Code. Defaults to true. */
	details?: boolean;
}

interface Denial { tool: string; input: Record<string, unknown> }

/** C0, DEL, C1 and bidirectional direction controls. */
function isControl(code: number): boolean {
	return code < 32 || code >= 0x7f && code <= 0x9f || code === 0x200e || code === 0x200f ||
		code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
}

/** Single line of at most `limit` characters (never splitting one), with an ellipsis when cut. */
function clip(text: string, limit: number): string {
	const line = Array.from(text, (char) => isControl(char.codePointAt(0) ?? 0) ? " " : char).join("").replace(/\s+/g, " ").trim();
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : line;
}

/** The Claude Code denials that carry a tool name; anything else is ignored. */
function usableDenials(list: unknown): Denial[] {
	if (!Array.isArray(list)) return [];
	const denials: Denial[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const { tool_name: name, tool_input: input } = item as Record<string, unknown>;
		if (typeof name !== "string" || !name.trim()) continue;
		denials.push({ tool: name.trim(), input: input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {} });
	}
	return denials;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The vault root as given and as resolved, since the CLI may report real paths. */
function vaultRoots(vaultRoot: string): string[] {
	if (!vaultRoot) return [];
	const roots = [vaultRoot];
	try { roots.push(realpathSync(vaultRoot)); } catch { /* A root that cannot be resolved is compared as given. */ }
	return roots;
}

/** The path inside the vault, or null for files outside it. */
function vaultRelative(roots: string[], file: string): string | null {
	for (const root of roots) {
		const relative = path.relative(root, path.resolve(root, file));
		const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
		if (relative !== "" && !outside) return relative.split(path.sep).join("/");
	}
	return null;
}

/** A short hint about what the tool was aimed at. Never edit text or file contents. */
function denialTarget(input: Record<string, unknown>, roots: string[], limit: number): string {
	if (limit <= 0) return "";
	const file = str(input.file_path).trim() || str(input.notebook_path).trim();
	if (file) return clip(vaultRelative(roots, file) ?? path.basename(file), limit);
	const command = str(input.command).split(/[\r\n]/, 1)[0].trim();
	if (command) return clip(command, Math.min(limit, 60));
	const url = str(input.url).trim();
	if (url) {
		try { return clip(new URL(url).hostname, limit); } catch { /* Unparseable URLs get no target. */ }
	}
	const query = str(input.pattern).trim() || str(input.query).trim();
	return query ? clip(query, Math.min(limit, 40)) : "";
}

/**
 * One `Bash(<word> *)` rule per part of each denied command, or null when any part
 * cannot be narrowed safely. Claude Code needs a rule for every part of a compound command.
 */
function bashRules(denials: Denial[]): string[] | null {
	const rules: string[] = [];
	for (const denial of denials) {
		const parts = str(denial.input.command).split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
		if (!parts.length) return null;
		for (const part of parts) {
			const word = part.split(/\s+/, 1)[0];
			if (!SAFE_COMMAND_WORD.test(word) || WRAPPERS.has(word.split("/").pop() ?? "")) return null;
			const rule = `"Bash(${word} *)"`;
			if (!rules.includes(rule)) rules.push(rule);
		}
	}
	return rules;
}

function joinNames(items: string[], more: number): string {
	const all = more ? [...items, `${more} more`] : items;
	return all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/** Hard ceiling and single line, whatever the input. */
function finalCut(message: string): string {
	const line = message.replace(/[\r\n\u2028\u2029]/g, " ");
	if (line.length <= MAX_PERMISSION_ERROR) return line;
	let cut = "";
	for (const char of line) {
		if (cut.length + char.length > MAX_PERMISSION_ERROR - 1) break;
		cut += char;
	}
	return `${cut}…`;
}

/** One line, naming each denied tool, its target and the flag that allows it. */
function detailedPermissionError(denials: Denial[], vaultRoot: string): string {
	const roots = vaultRoots(vaultRoot);
	const first = new Map<string, Denial>();
	for (const denial of denials) if (!first.has(denial.tool)) first.set(denial.tool, denial);
	const all = [...first.values()];
	const bash = denials.filter((denial) => denial.tool === "Bash");
	const build = (count: number, limit: number): string => {
		const named = all.slice(0, count);
		const names = named.map((denial) => {
			const target = denialTarget(denial.input, roots, limit);
			const name = clip(denial.tool, MAX_TOOL_NAME);
			return target ? `${name} (${target})` : name;
		});
		const more = all.length - named.length;
		let complete = true;
		let bashBlocked = false;
		const flags: string[] = [];
		for (const denial of named) {
			if (denial.tool === "Bash") {
				const rules = bashRules(bash);
				if (rules) flags.push(...rules); else { complete = false; bashBlocked = true; }
			} else if (ALLOWABLE_TOOL.test(denial.tool)) flags.push(denial.tool);
			else complete = false;
		}
		const allow = more ? "the tools named" : named.length === 1 ? "it" : "them";
		const rest = bashBlocked ? "the Bash command" : "the rest";
		const advice = !flags.length ? `Allow ${named.length === 1 && named[0].tool === "Bash" ? "the command" : allow} in Claude Code's permission settings, then retry.`
			: complete ? `To allow ${allow}, add --allowed-tools ${flags.join(" ")} to Extra arguments and retry, or update Claude Code's permission settings.`
				: `To allow part of ${allow}, add --allowed-tools ${flags.join(" ")} to Extra arguments, and allow ${rest} in Claude Code's permission settings, then retry.`;
		return `Claude Code denied ${joinNames(names, more)}. ${advice} The reply was not published, and earlier actions may already have taken effect.`;
	};
	// Shorten targets first, then name fewer tools, so the names and the flag stay whole.
	for (let count = Math.min(all.length, MAX_TOOLS_NAMED); count > 0; count--) {
		for (const limit of [120, 60, 40, 24, 12, 0]) {
			const message = build(count, limit);
			if (message.length <= MAX_PERMISSION_ERROR && !/[\r\n\u2028\u2029]/.test(message)) return message;
		}
	}
	return finalCut(build(1, 0));
}

/** Permission errors are execution failures, even when a CLI exits successfully. */
export function commentEventError(provider: ProviderId, event: Record<string, unknown>, options: CommentEventOptions = {}): string | null {
	const type = typeof event.type === "string" ? event.type : "";
	const text = JSON.stringify(event);
	if (type === "permission_denied" || event.subtype === "permission_denied" ||
		Array.isArray(event.permission_denials) && event.permission_denials.length > 0 ||
		provider === "opencode" && ["permission.asked", "permission.rejected"].includes(type)) {
		const denials = provider === "claude" && options.details !== false ? usableDenials(event.permission_denials) : [];
		return denials.length ? detailedPermissionError(denials, options.vaultRoot ?? "") : GENERIC_PERMISSION_ERROR;
	}
	if (provider === "codex" && ["error", "turn.failed"].includes(type)) {
		return /permission|approval|sandbox/i.test(text)
			? "The configured Codex permissions blocked this run. Review its CLI configuration, then retry; earlier actions may already have taken effect."
			: `Codex reported a failure: ${text}`;
	}
	return null;
}
