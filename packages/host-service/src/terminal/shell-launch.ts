/**
 * Shell launch configuration for v2 terminals.
 *
 * Behavioral reference: packages/agent-setup/src/shell-wrappers.ts
 *
 * Upstream patterns:
 * - VS Code: ZDOTDIR for zsh, --init-file for bash, --init-command for fish
 * - Kitty: KITTY_ORIG_ZDOTDIR for zsh, ENV for bash, XDG_DATA_DIRS for fish
 */
import cp from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	type ResolveConfiguredShellOptions,
	resolveConfiguredShell,
} from "./user-shell.ts";

/** Read a Windows env var case-insensitively (Path vs PATH, SystemRoot vs SYSTEMROOT). */
function getWinEnv(
	env: Record<string, string | undefined>,
	key: string,
): string | undefined {
	const direct = env[key];
	if (direct !== undefined) return direct;
	const lowerKey = key.toLowerCase();
	for (const [k, v] of Object.entries(env)) {
		if (k.toLowerCase() === lowerKey) return v;
	}
	return undefined;
}

/** Verify a candidate is a real PowerShell 7+ (`pwsh`), not a legacy shim/alias. */
function isValidPwsh(candidate: string): boolean {
	const base = path.basename(candidate).toLowerCase();
	if (base !== "pwsh.exe" && base !== "pwsh") return false;
	try {
		const out = cp.execFileSync(
			candidate,
			["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
			{ encoding: "utf8", windowsHide: true, timeout: 5000 },
		);
		return Number.parseInt(out.trim(), 10) >= 7;
	} catch {
		return false;
	}
}

/** Candidate real install paths for PowerShell 7 (`pwsh`), most-preferred first. */
function collectPwshCandidates(
	env: Record<string, string | undefined>,
): string[] {
	const candidates: string[] = [];
	const programFiles = getWinEnv(env, "ProgramFiles");
	const systemRoot = getWinEnv(env, "SystemRoot") ?? "C:\\Windows";
	const localAppData = getWinEnv(env, "LOCALAPPDATA");

	if (programFiles) {
		candidates.push(path.join(programFiles, "PowerShell", "7", "pwsh.exe"));
		candidates.push(
			path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
		);
		// Packaged Store installs under WindowsApps.
		const windowsApps = path.join(programFiles, "WindowsApps");
		try {
			for (const entry of readdirSync(windowsApps)) {
				if (
					entry.startsWith("Microsoft.PowerShell_") &&
					entry.endsWith("__8wekyb3d8bbwe")
				) {
					candidates.push(path.join(windowsApps, entry, "pwsh.exe"));
				}
			}
		} catch {
			// EPERM enumerating WindowsApps — resolve Store PowerShell via Get-AppxPackage.
			try {
				const out = cp.execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"Get-AppxPackage Microsoft.PowerShell | Sort-Object Version -Descending | ForEach-Object { Join-Path $_.InstallLocation 'pwsh.exe' }",
					],
					{ encoding: "utf8", windowsHide: true, timeout: 5000 },
				);
				for (const line of out.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (trimmed) candidates.push(trimmed);
				}
			} catch {
				// No Store PowerShell resolvable.
			}
		}
	}

	// Search PATH/Path using PATHEXT-style extensions.
	const pathValue = getWinEnv(env, "PATH");
	if (pathValue) {
		for (const dir of pathValue.split(path.delimiter)) {
			if (!dir) continue;
			candidates.push(path.join(dir, "pwsh.exe"));
			candidates.push(path.join(dir, "pwsh"));
		}
	}

	// Last-resort app execution alias — Windows Terminal's PS Core profile
	// resolves to the real packaged pwsh.exe, not this alias, so keep it last.
	if (localAppData) {
		candidates.push(
			path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
		);
	}

	void systemRoot; // legacy powershell.exe is never auto-selected (Patch 33)
	return candidates;
}

let cachedWindowsShell: string | undefined;

/**
 * Resolve the Windows shell for v2 terminals.
 *
 * Policy (Patch 33): honor SUPERSET_TERMINAL_SHELL first; otherwise resolve
 * only a validated PowerShell 7 (`pwsh`); if none is found fall back to
 * COMSPEC/cmd.exe. Legacy Windows PowerShell (`powershell.exe`) is never
 * auto-selected — it is opt-in only via SUPERSET_TERMINAL_SHELL.
 */
function resolveWindowsShell(env: Record<string, string | undefined>): string {
	const override = getWinEnv(env, "SUPERSET_TERMINAL_SHELL")?.trim();
	if (override) return override;

	if (cachedWindowsShell) return cachedWindowsShell;

	for (const candidate of collectPwshCandidates(env)) {
		if (existsSync(candidate) && isValidPwsh(candidate)) {
			cachedWindowsShell = candidate;
			return candidate;
		}
	}

	return getWinEnv(env, "COMSPEC") ?? "cmd.exe";
}

/** Does not default to /bin/zsh — falls back to /bin/sh (POSIX-guaranteed). */
export function resolveLaunchShell(
	baseEnv: Record<string, string>,
	options?: ResolveConfiguredShellOptions,
): string {
	if ((options?.platform ?? process.platform) === "win32") {
		return resolveWindowsShell(baseEnv);
	}
	return resolveConfiguredShell(baseEnv, options);
}

export function getSupersetShellPaths(supersetHomeDir: string): {
	BIN_DIR: string;
	ZSH_DIR: string;
	BASH_DIR: string;
} {
	return {
		BIN_DIR: path.join(supersetHomeDir, "bin"),
		ZSH_DIR: path.join(supersetHomeDir, "zsh"),
		BASH_DIR: path.join(supersetHomeDir, "bash"),
	};
}

function getShellName(shell: string): string {
	return path.basename(shell);
}

const SHELL_READY_MARKER_SCRIPT = "\\033]133;A\\007";

function fileContainsShellReadyMarker(filePath: string): boolean {
	try {
		return readFileSync(filePath, "utf8").includes(SHELL_READY_MARKER_SCRIPT);
	} catch {
		return false;
	}
}

/**
 * Matches desktop shell-wrappers.ts fish init: idempotent PATH prepend +
 * OSC 133;A prompt marker (FinalTerm standard) for shell readiness.
 *
 * Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
 */
function buildFishInitCommand(binDir: string): string {
	const escaped = binDir
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$");
	return [
		`set -l _superset_bin "${escaped}"`,
		`contains -- "$_superset_bin" $PATH`,
		`or set -gx PATH "$_superset_bin" $PATH`,
		`function _superset_prompt_mark --on-event fish_prompt`,
		`printf '\\033]133;A\\007'`,
		`end`,
	].join("; ");
}

export interface ShellBootstrapParams {
	shell: string;
	baseEnv: Record<string, string>;
	supersetHomeDir: string;
}

/**
 * Private bootstrap env for shell startup redirection.
 * Only zsh needs env vars (ZDOTDIR). Bash/fish use args only.
 */
export function getShellBootstrapEnv(
	params: ShellBootstrapParams,
): Record<string, string> {
	const { shell, baseEnv, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		const zshrc = path.join(paths.ZSH_DIR, ".zshrc");
		if (existsSync(zshrc)) {
			return {
				SUPERSET_ORIG_ZDOTDIR: baseEnv.ZDOTDIR || baseEnv.HOME || homedir(),
				ZDOTDIR: paths.ZSH_DIR,
			};
		}
	}

	return {};
}

export interface ShellLaunchParams {
	shell: string;
	supersetHomeDir: string;
}

/**
 * Whether this exact launch configuration installs Superset's prompt marker.
 *
 * Shell name alone is not enough: stale or missing wrapper files mean zsh and
 * bash never emit OSC 133;A. Callers use this capability check to decide
 * whether automation can safely wait for the first prompt without risking an
 * indefinite stall on an unwrapped shell.
 */
export function shellLaunchExpectsReadyMarker(
	params: ShellLaunchParams,
): boolean {
	const { shell, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		return (
			existsSync(path.join(paths.ZSH_DIR, ".zshrc")) &&
			fileContainsShellReadyMarker(path.join(paths.ZSH_DIR, ".zlogin"))
		);
	}

	if (shellName === "bash") {
		return fileContainsShellReadyMarker(path.join(paths.BASH_DIR, "rcfile"));
	}

	// Fish receives the marker hook directly in --init-command, so it does not
	// depend on wrapper files on disk.
	return shellName === "fish";
}

export function getShellLaunchArgs(params: ShellLaunchParams): string[] {
	const { shell, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		return ["-l"];
	}

	if (shellName === "bash") {
		const rcfile = path.join(paths.BASH_DIR, "rcfile");
		if (existsSync(rcfile)) {
			return ["--rcfile", rcfile];
		}
		return ["-l"];
	}

	if (shellName === "fish") {
		return ["-l", "--init-command", buildFishInitCommand(paths.BIN_DIR)];
	}

	if (shellName === "sh" || shellName === "ksh") {
		return ["-l"];
	}

	return [];
}
