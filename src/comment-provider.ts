import type { ProviderId } from "./providers.ts";

/** Comment jobs accept model tuning only, never tool, session or permission overrides. */
export function restrictedCommentArgs(provider: ProviderId, args: string[], reader = "aio-comment-reader"): string[] {
	for (let i = 0; i < args.length; i++) {
		if (provider === "codex" && ["-c", "--config"].includes(args[i]) && /^model_verbosity=(low|medium|high)$/.test(args[i + 1] ?? "")) { i++; continue; }
		throw new Error("Comment agents cannot use these extra arguments. Remove tool, session, directory and permission overrides in AI Overview settings; only Codex model_verbosity tuning is supported for comments.");
	}
	if (provider === "codex") return [
		...args, "--ignore-user-config", "--ignore-rules",
		"-c", "approval_policy=\"never\"", "-c", "features.apps=false", "-c", "features.hooks=false",
		"-c", "features.multi_agent=false", "-c", "allow_login_shell=false", "-c", "features.shell_snapshot=false", "-c", "web_search=\"disabled\"",
	];
	if (provider === "claude") return [
		"--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--setting-sources", "",
		"--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
	];
	return ["--pure", "--agent", reader];
}

export function restrictedCommentEnv(provider: ProviderId, reader = "aio-comment-reader"): Record<string, string> {
	if (provider !== "opencode") return {};
	return {
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			default_agent: reader, share: "disabled", snapshot: false,
			permission: "deny",
			agent: { [reader]: { mode: "primary", permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" } } },
		}),
	};
}
