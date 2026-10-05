import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";

/**
 * GUI-launched apps inherit a minimal PATH that usually omits the directories
 * package managers install into, so common ones are appended as a fallback for
 * a bare executable name.
 */
export function augmentedPath(): string {
	const extra = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(os.homedir(), ".local/bin"),
		path.join(os.homedir(), ".bun/bin"),
		path.join(os.homedir(), ".cargo/bin"),
		"/usr/bin",
		"/bin",
	];
	const current = process.env.PATH ? process.env.PATH.split(":") : [];
	const seen = new Set(current);
	for (const dir of extra) {
		if (!seen.has(dir)) {
			current.push(dir);
			seen.add(dir);
		}
	}
	return current.join(":");
}

export interface CaptureOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs: number;
}

/**
 * Runs a short-lived command and resolves with its stdout. Used for the CLIs'
 * own listing commands, which are expected to exit promptly.
 */
export function runCapture(
	command: string,
	args: string[],
	opts: CaptureOptions
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...opts.env, PATH: augmentedPath() },
		});

		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`"${command}" did not respond in time.`)));
		}, opts.timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

		child.on("error", (err) => {
			const message =
				(err as NodeJS.ErrnoException).code === "ENOENT"
					? `Could not run "${command}".`
					: err.message;
			finish(() => reject(new Error(message)));
		});

		child.on("close", (code) => {
			const text = stdout.join("");
			finish(() => {
				// Some CLIs print usage information to stderr yet still exit non-zero
				// while having produced the listing on stdout.
				if (text.trim()) resolve(text);
				else reject(new Error(firstLine(stderr.join("")) || `Exited with code ${code}.`));
			});
		});
	});
}

function firstLine(text: string): string {
	return text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
}
