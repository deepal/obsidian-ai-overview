import { existsSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "smol-toml";

function literal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (value && typeof value === "object" && !Array.isArray(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${literal(item)}`).join(",")}}`;
	throw new Error("Unsupported Codex model provider configuration for comment mode.");
}

/** Preserve model routing without loading hooks, MCP servers or permission overrides. */
export function safeCodexDefaults(text: string, model: string, effort: string): string[] {
	const config = parse(text);
	const overrides: Record<string, unknown> = {};
	if (config.api_key_helper) throw new Error("Comment mode cannot execute a Codex api_key_helper. Use CLI authentication or an environment credential for comment requests.");
	for (const key of ["model_provider", "cli_auth_credentials_store", "forced_login_method", "model_verbosity"]) {
		if (typeof config[key] === "string") overrides[key] = config[key];
	}
	if (!model && typeof config.model === "string") overrides.model = config.model;
	if (!effort && typeof config.model_reasoning_effort === "string") overrides.model_reasoning_effort = config.model_reasoning_effort;
	const providerId = config.model_provider;
	if (typeof providerId === "string" && config.model_providers && typeof config.model_providers === "object") {
		const providers = config.model_providers as Record<string, unknown>;
		const provider = providers[providerId];
		if (provider && typeof provider === "object" && !Array.isArray(provider)) {
			const allowed = ["name", "base_url", "env_key", "env_key_instructions", "wire_api", "requires_openai_auth", "http_headers", "env_http_headers", "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms", "supports_websockets"];
			const safe = Object.fromEntries(Object.entries(provider).filter(([key]) => allowed.includes(key)));
			overrides[`model_providers.${JSON.stringify(providerId)}`] = safe;
		}
	}
	return Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${literal(value)}`]);
}

export function codexCommentConfig(cwd: string, env: Record<string, string>, model: string, effort: string): string[] {
	const configHome = env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
	const globalConfig = path.resolve(configHome, "config.toml");
	for (let directory = path.resolve(cwd);;) {
		const projectConfig = path.join(directory, ".codex", "config.toml");
		if (projectConfig !== globalConfig && existsSync(projectConfig)) {
			throw new Error("Comment mode cannot load project .codex/config.toml files. Remove the project configuration or use another provider for mentions.");
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	if (!existsSync(globalConfig)) return [];
	return safeCodexDefaults(readFileSync(globalConfig, "utf8"), model, effort);
}
