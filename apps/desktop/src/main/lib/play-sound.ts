import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

interface PlaySoundCallbacks {
	onComplete?: () => void;
	isCanceled?: () => boolean;
	onProcessChange?: (process: ChildProcess) => void;
}

/**
 * Plays a sound file at the given volume using platform-specific commands.
 * Returns the primary ChildProcess, or null if playback was skipped.
 *
 * On macOS, volume is controlled via afplay -v (0.0-1.0).
 * On Linux, volume is controlled via paplay --volume (0-65536), with aplay fallback.
 */
export function playSoundFile(
	soundPath: string,
	volume: number = 100,
	callbacks?: PlaySoundCallbacks,
): ChildProcess | null {
	if (!existsSync(soundPath)) {
		console.warn(`[play-sound] Sound file not found: ${soundPath}`);
		return null;
	}

	const volumeDecimal = volume / 100;

	if (process.platform === "darwin") {
		return execFile(
			"afplay",
			["-v", volumeDecimal.toString(), soundPath],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
	}

	if (process.platform === "win32") {
		// Windows PowerShell + WPF MediaPlayer supports mp3/wav/ogg and honors
		// volume. Returned so the ringtone preview can kill it on stop/replace.
		const escapedPath = soundPath.replace(/'/g, "''");
		const script = [
			"Add-Type -AssemblyName PresentationCore;",
			"$player = New-Object System.Windows.Media.MediaPlayer;",
			`$player.Open([System.Uri]::new('${escapedPath}'));`,
			`$player.Volume = ${volumeDecimal};`,
			"Start-Sleep -Milliseconds 200;",
			"$player.Play();",
			"$durationMs = 5000;",
			"if ($player.NaturalDuration.HasTimeSpan) { $durationMs = [int]$player.NaturalDuration.TimeSpan.TotalMilliseconds + 200 }",
			"Start-Sleep -Milliseconds $durationMs;",
			"$player.Stop();",
			"$player.Close();",
		].join(" ");
		return execFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-STA",
				"-Command",
				script,
			],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
	}

	// Linux: paplay --volume accepts 0-65536 (65536 = 100%)
	const paVolume = Math.round(volumeDecimal * 65536);
	return execFile(
		"paplay",
		["--volume", paVolume.toString(), soundPath],
		{ windowsHide: true },
		(error) => {
			if (error) {
				if (callbacks?.isCanceled?.()) {
					callbacks?.onComplete?.();
					return;
				}
				if (volume === 0) {
					callbacks?.onComplete?.();
					return;
				}
				const fallback = execFile(
					"aplay",
					[soundPath],
					{ windowsHide: true },
					() => callbacks?.onComplete?.(),
				);
				callbacks?.onProcessChange?.(fallback);
				return;
			}
			callbacks?.onComplete?.();
		},
	);
}
