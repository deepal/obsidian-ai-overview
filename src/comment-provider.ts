import type { ProviderId } from "./providers.ts";

/** Preserve user tools and permissions while reserving the invocation's transport and task. */
export function commentArgs(provider: ProviderId, args: string[]): string[] {
	const reserved: Record<ProviderId, string[]> = {
		codex: ["--output-schema", "--output-last-message", "-o", "--json", "--color", "--cd", "-C", "--worktree"],
		claude: ["--verbose", "--no-verbose", "--output-format", "--input-format", "--json-schema", "--permission-prompts", "--permission-prompt-tool", "--print", "-p", "--continue", "-c", "--resume", "-r", "--session-id", "--fork-session"],
		opencode: ["--format", "--dir", "--command", "--continue", "-c", "--session", "-s", "--fork", "--attach", "--interactive", "-i"],
	};
	const takesValue: Record<ProviderId, string[]> = {
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

/** Permission errors are execution failures, even when a CLI exits successfully. */
export function commentEventError(provider: ProviderId, event: Record<string, unknown>): string | null {
	const type = typeof event.type === "string" ? event.type : "";
	const text = JSON.stringify(event);
	if (type === "permission_denied" || event.subtype === "permission_denied" ||
		Array.isArray(event.permission_denials) && event.permission_denials.length > 0 ||
		provider === "opencode" && ["permission.asked", "permission.rejected"].includes(type)) {
		return "The agent needs permission that is not available to this unattended run. Configure the CLI's permissions outside Obsidian, then retry. Earlier actions may already have taken effect.";
	}
	if (provider === "codex" && ["error", "turn.failed"].includes(type)) {
		return /permission|approval|sandbox/i.test(text)
			? "The configured Codex permissions blocked this run. Review its CLI configuration, then retry; earlier actions may already have taken effect."
			: `Codex reported a failure: ${text}`;
	}
	return null;
}
