import { appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
	type AsyncSubscription,
	type Event as ParcelWatcherEvent,
	subscribe as subscribeToFilesystem,
} from "@parcel/watcher";

/**
 * Runs @parcel/watcher inside a Node worker thread so its native backend never
 * executes on the caller's thread.
 *
 * Why: on Windows, the @parcel/watcher native binding performs its initial
 * recursive directory scan synchronously on the calling thread. When called
 * from the Electron main process (FsWatcherManager.attachNativeSubscription),
 * a cold scan of a worktree blocks the entire main process for seconds —
 * freezing every window, IPC request and menu interaction (observed as ~5.3s
 * RunMicrotasks stalls in Chrome traces, with ~99.9% of profiler samples
 * inside the parcel native subscribe() call).
 *
 * The proxy keeps the exact @parcel/watcher surface used by watch.ts:
 * subscribe(dir, callback, { ignore }) -> Promise<{ unsubscribe(): Promise<void> }> .
 * Events and errors are forwarded over MessagePort; the initial scan and all
 * native read-directory work happen inside the worker.
 *
 * If the worker cannot be created or fails to load the parcel module, the
 * proxy degrades gracefully to a plain in-thread subscribe (the previous
 * behavior), so watching never regresses to "broken". Every lifecycle event
 * and failure reason is appended to a debug log file so fallbacks are
 * diagnosable from a packaged install.
 */

type WorkerInMessage =
	| {
			type: "subscribe";
			id: number;
			dir: string;
			ignore: string[];
			backend?: string;
	  }
	| { type: "unsubscribe"; id: number };

type WorkerOutMessage =
	| { type: "subscribed"; id: number }
	| { type: "subscribe-failed"; id: number; message: string }
	| { type: "unsubscribed"; id: number }
	| {
			type: "events";
			id: number;
			error: string | null;
			events: ParcelWatcherEvent[];
	  }
	| { type: "fatal"; message: string };

type ParcelSubscribeCallback = (
	error: Error | null,
	events: ParcelWatcherEvent[],
) => void;

const UNSUBSCRIBE_ACK_TIMEOUT_MS = 5_000;

const DEBUG_LOG_PATH = path.join(os.tmpdir(), "superset-parcel-worker.log");

function debugLog(message: string): void {
	try {
		appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Debug logging must never break watching.
	}
}

// The worker cannot `require("@parcel/watcher")` by bare specifier reliably
// (eval workers resolve from the process cwd, which is wrong inside a packaged
// app). Resolve the module path here — where require already works — and hand
// the absolute path to the worker. Inside an asar archive, redirect to the
// unpacked copy so the native binding loads from real files.
function resolveWatcherModulePath(): string {
	const candidates: string[] = [];
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const resolved = require.resolve("@parcel/watcher") as string;
		candidates.push(resolved);
		if (
			resolved.includes("app.asar") &&
			!resolved.includes("app.asar.unpacked")
		) {
			const unpacked = resolved.replace("app.asar", "app.asar.unpacked");
			candidates.push(unpacked);
		}
	} catch (error) {
		debugLog(
			`resolveWatcherModulePath: require.resolve failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const usable = candidates.find((candidate) => existsSync(candidate));
	if (usable) {
		debugLog(`resolveWatcherModulePath: using ${usable}`);
		return usable;
	}
	debugLog(
		`resolveWatcherModulePath: no candidate exists on disk (${candidates.join(", ") || "none resolved"}); falling back to bare specifier`,
	);
	return "@parcel/watcher";
}

const WORKER_SOURCE = [
	"const { parentPort, workerData } = require('node:worker_threads');",
	"const candidates = [workerData.watcherPath, '@parcel/watcher'];",
	"let watcher = null;",
	"const errors = [];",
	"for (const candidate of candidates) {",
	"  if (!candidate) continue;",
	"  try {",
	"    watcher = require(candidate);",
	"    break;",
	"  } catch (error) {",
	"    errors.push(candidate + ' => ' + (error && error.message ? error.message : String(error)));",
	"  }",
	"}",
	"if (!watcher) {",
	"  parentPort.postMessage({ type: 'fatal', message: 'all require candidates failed: ' + errors.join(' | ') });",
	"  process.exit(1);",
	"}",
	"parentPort.postMessage({ type: 'ready' });",
	"const subscriptions = new Map();",
	"parentPort.on('message', (msg) => {",
	"  if (msg.type === 'subscribe') {",
	"    let subscription;",
	"    const opts = { ignore: msg.ignore };",
	"    if (msg.backend) opts.backend = msg.backend;",
	"    try {",
	"      subscription = watcher.subscribe(msg.dir, (error, events) => {",
	"        parentPort.postMessage({",
	"          type: 'events',",
	"          id: msg.id,",
	"          error: error ? String(error && error.message ? error.message : error) : null,",
	"          events,",
	"        });",
	"      }, opts);",
	"    } catch (error) {",
	"      parentPort.postMessage({ type: 'subscribe-failed', id: msg.id, message: String(error && error.message ? error.message : error) });",
	"      return;",
	"    }",
	"    Promise.resolve(subscription).then((sub) => {",
	"      subscriptions.set(msg.id, sub);",
	"      parentPort.postMessage({ type: 'subscribed', id: msg.id });",
	"    }, (error) => {",
	"      parentPort.postMessage({ type: 'subscribe-failed', id: msg.id, message: String(error && error.message ? error.message : error) });",
	"    });",
	"  } else if (msg.type === 'unsubscribe') {",
	"    const sub = subscriptions.get(msg.id);",
	"    subscriptions.delete(msg.id);",
	"    const done = () => parentPort.postMessage({ type: 'unsubscribed', id: msg.id });",
	"    if (!sub) { done(); return; }",
	"    Promise.resolve(sub.unsubscribe()).then(done, done);",
	"  }",
	"});",
].join("\n");

let worker: Worker | null = null;
let workerBroken = false;
let nextSubscriptionId = 1;

const pendingSubscribes = new Map<
	number,
	{ callback: ParcelSubscribeCallback; reject: (error: Error) => void }
>();
const activeSubscriptions = new Map<number, ParcelSubscribeCallback>();
const pendingUnsubscribes = new Map<number, () => void>();

function failAllPending(error: Error): void {
	for (const [, pending] of pendingSubscribes) {
		pending.reject(error);
	}
	pendingSubscribes.clear();
	for (const [, resolve] of pendingUnsubscribes) {
		resolve();
	}
	pendingUnsubscribes.clear();
	// Active subscriptions died with the worker — surface an error through
	// each callback so FsWatcherManager's existing recovery machinery kicks
	// in exactly as it would for a dead native backend.
	for (const [, callback] of activeSubscriptions) {
		try {
			callback(error, []);
		} catch {
			// Listener errors must not break the fan-out loop.
		}
	}
	activeSubscriptions.clear();
}

function handleWorkerMessage(message: WorkerOutMessage): void {
	if (message.type === "fatal") {
		workerBroken = true;
		worker = null;
		debugLog(`worker fatal: ${message.message}`);
		failAllPending(
			new Error(`parcel watcher worker failed: ${message.message}`),
		);
		return;
	}
	if (message.type === "subscribe-failed") {
		const pending = pendingSubscribes.get(message.id);
		if (pending) {
			pendingSubscribes.delete(message.id);
			debugLog(`subscribe #${message.id} failed: ${message.message}`);
			pending.reject(new Error(message.message));
		}
		return;
	}
	if (message.type === "events") {
		const callback = activeSubscriptions.get(message.id);
		if (!callback) {
			return;
		}
		const error = message.error ? new Error(message.error) : null;
		try {
			callback(error, message.events);
		} catch {
			// Listener errors must not break the fan-out loop.
		}
		return;
	}
	if (message.type === "unsubscribed") {
		activeSubscriptions.delete(message.id);
		const resolve = pendingUnsubscribes.get(message.id);
		if (resolve) {
			pendingUnsubscribes.delete(message.id);
			resolve();
		}
		return;
	}
	// "subscribed" is handled inline in subscribeInWorkerThread (it needs the
	// proxy subscription instance).
}

function getWorker(): Worker | null {
	if (workerBroken) {
		return null;
	}
	if (worker) {
		return worker;
	}
	try {
		const watcherPath = resolveWatcherModulePath();
		debugLog(`creating worker (watcherPath=${watcherPath})`);
		const created = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { watcherPath },
		});
		created.unref();
		created.on("message", handleWorkerMessage);
		created.on("error", (error) => {
			debugLog(
				`worker error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
			);
			if (worker === created) {
				worker = null;
			}
			failAllPending(error instanceof Error ? error : new Error(String(error)));
		});
		created.on("exit", (code) => {
			if (worker === created) {
				worker = null;
			}
			debugLog(`worker exited (code ${code})`);
			failAllPending(new Error(`parcel watcher worker exited (code ${code})`));
		});
		worker = created;
		debugLog("worker created");
		return created;
	} catch (error) {
		workerBroken = true;
		debugLog(
			`worker creation threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
		return null;
	}
}

function createProxySubscription(
	id: number,
	workerRef: Worker,
): AsyncSubscription {
	return {
		unsubscribe: async () => {
			if (!activeSubscriptions.has(id)) {
				// Already unsubscribed, failed, or the worker died.
				return;
			}
			return new Promise<void>((resolve) => {
				pendingUnsubscribes.set(id, resolve);
				workerRef.postMessage({
					type: "unsubscribe",
					id,
				} satisfies WorkerInMessage);
				const timer = setTimeout(() => {
					if (pendingUnsubscribes.get(id) === resolve) {
						pendingUnsubscribes.delete(id);
						activeSubscriptions.delete(id);
						resolve();
					}
				}, UNSUBSCRIBE_ACK_TIMEOUT_MS);
				timer.unref?.();
			});
		},
	};
}

/**
 * Drop-in replacement for @parcel/watcher's subscribe() that runs the native
 * backend inside a shared worker thread. On any worker failure it degrades to
 * a plain in-thread subscribe so watching never breaks outright.
 *
 * Windows: forces backend "windows". The default backend selection probes for
 * a watchman installation by spawning `cmd.exe /c watchman --output-encoding=bser
 * get-sockname` from native code on every subscribe — a spawn our JS
 * child_process patch cannot cover (it happens inside the C++ binding) and
 * whose console window Windows Terminal's default-terminal handoff flashes
 * even with windowsHide. Pinning the native windows backend skips the probe.
 */
export async function subscribeInWorkerThread(
	dir: string,
	callback: ParcelSubscribeCallback,
	options?: { ignore?: string[]; backend?: string },
): Promise<AsyncSubscription> {
	const backend =
		process.platform === "win32" ? "windows" : (options?.backend as never);
	const workerRef = getWorker();
	if (!workerRef) {
		debugLog(
			`subscribe(${dir}): worker unavailable — falling back to in-thread subscribe`,
		);
		return subscribeToFilesystem(dir, callback, {
			ignore: options?.ignore,
			backend,
		});
	}
	const id = nextSubscriptionId++;
	return new Promise<AsyncSubscription>((resolve, reject) => {
		pendingSubscribes.set(id, { callback, reject });
		const onMessage = (message: WorkerOutMessage) => {
			if (message.type !== "subscribed" || message.id !== id) {
				return;
			}
			workerRef.off("message", onMessage);
			pendingSubscribes.delete(id);
			activeSubscriptions.set(id, callback);
			debugLog(`subscribe #${id} attached in worker (${dir})`);
			resolve(createProxySubscription(id, workerRef));
		};
		workerRef.on("message", onMessage);
		workerRef.postMessage({
			type: "subscribe",
			id,
			dir,
			ignore: options?.ignore ?? [],
			backend,
		} satisfies WorkerInMessage);
	}).catch((error) => {
		// Worker unavailable (fatal/creation failure): degrade to in-thread.
		if (workerBroken) {
			debugLog(
				`subscribe(${dir}): worker failed (${error instanceof Error ? error.message : String(error)}) — falling back to in-thread subscribe`,
			);
			return subscribeToFilesystem(dir, callback, {
				ignore: options?.ignore,
				backend,
			});
		}
		throw error;
	});
}
