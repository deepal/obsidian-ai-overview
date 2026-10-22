import type { AgentBridge, CommentHost, CommentSource, MentionJob, MentionRequest } from "./agent-bridge.ts";
import type { CommentResult, NoteChange } from "./comment-output.ts";
import { parseCommentResult } from "./comment-output.ts";

export interface SavedJob extends MentionJob {
	result?: CommentResult;
	outcomes: Array<{ path: string; state: "pending" | "applying" | "applied" | "failed"; error?: string }>;
}
export interface JobDependencies {
	persist(jobs: SavedJob[]): Promise<void>;
	launch(request: MentionRequest, progress: (text: string) => void): { result: Promise<CommentResult>; cancel(): void };
	apply(change: NoteChange): Promise<void>;
}
const active = (job: MentionJob) => ["queued", "running", "applying"].includes(job.state);

export function parseSavedJobs(value: unknown): SavedJob[] {
	if (!Array.isArray(value)) throw new Error("Invalid stored comment history.");
	const jobs = value as SavedJob[];
	for (const job of jobs) {
		const r = job?.request;
		if (!r || typeof r.id !== "string" || typeof r.commentId !== "string" || typeof r.notePath !== "string" ||
			typeof r.message !== "string" || !["comment-block", "inline-review-comment"].includes(r.source) ||
			!Array.isArray(r.thread) || typeof job.tag !== "string" ||
			!["queued", "running", "applying", "completed", "failed", "cancelled"].includes(job.state) || !Array.isArray(job.outcomes)) {
			throw new Error("Invalid stored comment history. Restore the history before running more mentions.");
		}
		if (job.result) {
			parseCommentResult(JSON.stringify(job.result));
			if (job.outcomes.length !== job.result.changes.length) throw new Error("Incomplete stored note change history.");
		}
		if (job.outcomes.some((o) => !o || typeof o.path !== "string" || !["pending", "applying", "applied", "failed"].includes(o.state))) throw new Error("Invalid stored note change outcome.");
	}
	return jobs;
}

/** One queue per Obsidian vault instance; durable IDs make publication idempotent. */
export class CommentJobs implements AgentBridge {
	readonly version = 1 as const;
	tag = "";
	private records = new Map<string, SavedJob>();
	private hosts = new Map<CommentSource, CommentHost>();
	private listeners = new Set<() => void>();
	private pumping = false;
	private stopped = false;
	private running?: { id: string; cancel(): void };
	private writes: Promise<void> = Promise.resolve();

	private readonly deps: JobDependencies;
	constructor(deps: JobDependencies, saved: SavedJob[] = []) {
		this.deps = deps;
		for (const job of parseSavedJobs(saved)) {
			if (active(job)) {
				job.state = "failed";
				job.error = "Interrupted. Retry explicitly; check any changes marked uncertain.";
			}
			this.records.set(job.request.id, job);
		}
	}

	attach(source: CommentSource, host: CommentHost): () => void {
		this.hosts.set(source, host);
		return () => {
			if (this.hosts.get(source) !== host) return;
			this.hosts.delete(source);
			for (const job of this.records.values()) if (job.request.source === source && active(job)) this.cancel(job.request.id);
		};
	}
	jobs(source: CommentSource, notePath: string): SavedJob[] {
		return [...this.records.values()].filter((j) => j.request.source === source && j.request.notePath === notePath);
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	configure(tag: string): void {
		if (tag === this.tag) return;
		this.tag = tag;
		for (const job of this.records.values()) if (active(job)) this.cancel(job.request.id);
		this.notify();
	}
	async submit(request: MentionRequest): Promise<void> {
		if (this.stopped || !this.tag || !this.hosts.has(request.source)) return;
		if ([...this.records.values()].some((j) => j.request.source === request.source && j.request.notePath === request.notePath && j.request.commentId === request.commentId)) return;
		const job: SavedJob = { request, tag: this.tag, state: "queued", outcomes: [] };
		this.records.set(request.id, job);
		try { await this.save(); } catch (error) {
			job.state = "failed"; job.error = `Could not save request: ${String(error)}`;
			this.notify(); return;
		}
		this.notify();
		void this.pump();
	}
	async retry(id: string): Promise<void> {
		const job = this.records.get(id);
		if (!job || job.state !== "failed" || !this.tag || this.stopped) return;
		if (!(await this.valid(job))) {
			job.error = "The initiating comment changed or is unavailable. Send a new mention to ask again.";
			await this.save(); this.notify(); return;
		}
		job.state = "queued";
		delete job.error;
		await this.save(); this.notify(); void this.pump();
	}
	cancel(id: string): void {
		const job = this.records.get(id);
		if (!job || !active(job)) return;
		job.state = "cancelled";
		const applied = job.outcomes.filter((o) => o.state === "applied").map((o) => o.path);
		job.detail = applied.length ? `Cancelled; applied changes remain in: ${applied.join(", ")}.` : "Cancelled.";
		if (this.running?.id === id) this.running.cancel();
		void this.save().catch((error: unknown) => console.error("[ai-overview] Could not persist cancellation", error));
		this.notify();
	}
	rename(oldPath: string, newPath: string): void {
		for (const job of this.records.values()) if (job.request.notePath === oldPath) {
			if (active(job)) this.cancel(job.request.id);
			job.request.notePath = newPath;
		}
		void this.save().catch((error: unknown) => console.error("[ai-overview] Could not persist rename", error));
		this.notify();
	}
	stop(): void {
		this.stopped = true;
		this.tag = "";
		for (const job of this.records.values()) if (active(job)) this.cancel(job.request.id);
		this.listeners.clear(); this.hosts.clear();
	}
	private notify(): void { for (const fn of this.listeners) fn(); }
	private save(): Promise<void> {
		const snapshot = JSON.parse(JSON.stringify([...this.records.values()])) as SavedJob[];
		const write = this.writes.catch(() => undefined).then(() => this.deps.persist(snapshot));
		this.writes = write;
		return write;
	}
	private async valid(job: SavedJob): Promise<boolean> {
		const host = this.hosts.get(job.request.source);
		const valid = await host?.validate(job.request);
		return !this.stopped && !!this.tag && this.hosts.get(job.request.source) === host && !!valid;
	}
	private async pump(): Promise<void> {
		if (this.pumping || this.stopped) return;
		this.pumping = true;
		try {
			for (;;) {
				const job = [...this.records.values()].find((j) => j.state === "queued");
				if (!job || this.stopped) break;
				try { await this.execute(job); } catch (error) {
					if (job.state !== "cancelled") { job.state = "failed"; job.error = error instanceof Error ? error.message : String(error); }
				} finally {
					this.running = undefined;
					if (job.state === "cancelled") {
						const applied = job.outcomes.filter((o) => o.state === "applied").map((o) => o.path);
						if (applied.length) job.detail = `Cancelled; applied changes remain in: ${applied.join(", ")}.`;
					}
					try { await this.save(); } catch (error) { console.error("[ai-overview] Could not persist job", error); }
					this.notify();
				}
			}
		} finally { this.pumping = false; }
	}
	private async execute(job: SavedJob): Promise<void> {
		if (!(await this.valid(job))) { this.cancel(job.request.id); return; }
		if (!job.result) {
			job.state = "running"; this.notify(); await this.save();
			if (!(await this.valid(job)) || !active(job)) { this.cancel(job.request.id); return; }
			const run = this.deps.launch(job.request, (text) => { job.detail = text; this.notify(); });
			this.running = { id: job.request.id, cancel: () => run.cancel() };
			job.result = await run.result;
			job.outcomes = job.result.changes.map((c) => ({ path: c.path, state: "pending" }));
			await this.save();
		}
		if (!(await this.valid(job)) || !active(job)) { this.cancel(job.request.id); return; }
		job.state = "applying"; job.detail = job.result.changes.length ? "Applying note changes…" : "Adding reply…"; this.notify();
		for (let i = 0; i < job.result.changes.length; i++) {
			const outcome = job.outcomes[i];
			if (outcome.state !== "pending") continue;
			if (!(await this.valid(job)) || !active(job)) { this.cancel(job.request.id); return; }
			outcome.state = "applying"; job.detail = `Updating ${outcome.path}`; this.notify(); await this.save();
			try { await this.deps.apply(job.result.changes[i]); outcome.state = "applied"; }
			catch (error) { outcome.state = "failed"; outcome.error = error instanceof Error ? error.message : String(error); }
			await this.save();
		}
		if (!(await this.valid(job)) || !active(job)) { this.cancel(job.request.id); return; }
		const summary = job.outcomes.map((o) => `- ${o.state === "applied" ? "Applied" : o.state === "applying" ? "Uncertain after interruption — check this note" : "Not applied"}: ${o.path}${o.error ? ` — ${o.error}` : ""}`);
		const body = job.result.reply + (summary.length ? `\n\nNote changes:\n\n${summary.join("\n")}` : "");
		await this.hosts.get(job.request.source)!.publish(job.request, job.tag, body);
		job.state = "completed"; delete job.error;
	}
}
