import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		// Text-cursor references must not be capitalized as the Cursor product.
		rules: { "obsidianmd/ui/sentence-case": ["warn", { ignoreRegex: ["^Regenerate at cursor$"] }] },
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
	{
		// These desktop-only process modules also run in Node tests and have no window lifecycle.
		files: ["src/agent.ts", "src/spawn.ts"],
		rules: { "obsidianmd/prefer-window-timers": "off" },
	},
];
