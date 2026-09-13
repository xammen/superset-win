/**
 * Force `windowsHide: true` for all child_process spawns on Windows.
 *
 * Many third-party libraries invoke child_process.{exec,spawn,execFile,…}
 * without passing `windowsHide: true`, which flashes a cmd.exe/console window
 * for every console-subsystem child on Windows. Rather than patch each caller,
 * monkey-patch node:child_process at the very start of the main-process entry
 * point so every spawn variant defaults to `windowsHide: true`. Callers that
 * explicitly pass `windowsHide: false` are still respected.
 *
 * Diagnostics: every thread that installs the patch appends one line to
 * %TEMP%\superset-spawn-trace.log (always). With SUPERSET_TRACE_SPAWN=1 every
 * spawn is also logged there with its variant, command, whether the caller
 * passed windowsHide itself, and the emitting thread — so unpatched spawn
 * paths (worker threads with their own module registry, captured references)
 * become attributable.
 */

import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

const IS_WINDOWS = process.platform === "win32";
// Spawn logging is always on (file only — cheap append per spawn) so unpatched
// or external spawn paths are attributable from a packaged install without
// needing env vars. Console tracing stays behind SUPERSET_TRACE_SPAWN=1.
const TRACE = process.env.SUPERSET_TRACE_SPAWN === "1";

const TRACE_LOG_PATH = path.join(os.tmpdir(), "superset-spawn-trace.log");

function traceLog(line: string): void {
	try {
		appendFileSync(TRACE_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Logging must never break spawning.
	}
}

function threadLabel(): string {
	return `pid=${process.pid} ${isMainThread ? "main" : `worker-${threadId}`}`;
}

let installed = false;

function withWindowsHide<T>(options: T): T {
	if (options && typeof options === "object") {
		const opts = options as Record<string, unknown>;
		if (!("windowsHide" in opts) || opts.windowsHide === undefined) {
			opts.windowsHide = true;
		}
		return options;
	}
	return { windowsHide: true } as unknown as T;
}

/**
 * The spawn variants share a loose signature: (command, args?, options?).
 * `args` may be omitted or may itself be the options object. We locate the
 * options object (last arg when it's a plain non-array object, or inject one)
 * and ensure windowsHide defaults to true.
 */
function patchVariant(
	obj: Record<string, unknown>,
	name: string,
	hasArgs: boolean,
): void {
	const original = obj[name];
	if (typeof original !== "function") return;
	const orig = original as (...args: unknown[]) => unknown;

	obj[name] = function patched(...callArgs: unknown[]) {
		// Find an existing options object: the last argument that is a plain
		// object (not an array). If none, append one.
		let optionsIndex = -1;
		for (let i = callArgs.length - 1; i >= (hasArgs ? 1 : 1); i--) {
			const candidate = callArgs[i];
			if (
				candidate &&
				typeof candidate === "object" &&
				!Array.isArray(candidate)
			) {
				optionsIndex = i;
				break;
			}
		}

		const hadWindowsHide =
			optionsIndex >= 0 &&
			(callArgs[optionsIndex] as Record<string, unknown> | undefined)
				?.windowsHide !== undefined;

		const cmd = String(callArgs[0]);
		const args = hasArgs ? ` ${String(callArgs[1]).slice(0, 120)}` : "";
		traceLog(
			`spawn ${name} [${threadLabel()}] hide-before=${hadWindowsHide} : ${cmd}${args}`,
		);
		if (TRACE) {
			console.log(`[spawn-trace] ${name}: ${cmd}`);
		}

		if (optionsIndex >= 0) {
			callArgs[optionsIndex] = withWindowsHide(callArgs[optionsIndex]);
		} else {
			callArgs.push(withWindowsHide({}));
		}

		return orig.apply(this, callArgs);
	};
}

export function installWindowsChildProcessPatch(): void {
	if (!IS_WINDOWS || installed) return;
	installed = true;

	const cp = childProcess as unknown as Record<string, unknown>;
	patchVariant(cp, "spawn", true);
	patchVariant(cp, "exec", false);
	patchVariant(cp, "execFile", true);
	patchVariant(cp, "spawnSync", true);
	patchVariant(cp, "execSync", false);
	patchVariant(cp, "execFileSync", true);

	traceLog(`patch-installed [${threadLabel()}]`);
}

// Auto-install on import. Bundler module bodies run in dependency order, so
// any module that captures child_process references at load time (e.g.
// `util.promisify(childProcess.execFile)`) must see the patched functions.
// Explicit installWindowsChildProcessPatch() calls in entry points are
// harmless no-ops thanks to the `installed` guard, but the side-effect import
// guarantees the patch is applied before ANY other module body runs — as long
// as this import is the first statement of the entry file.
installWindowsChildProcessPatch();
