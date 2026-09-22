import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";

const PROJECT_SUPERSET_DIR_NAME = ".superset";

/**
 * Mirror V1's `copySupersetConfigToWorktree()`: copy the main repo's
 * repo-local `.superset` directory into a new/imported worktree when the
 * worktree has none of its own. Many projects locally ignore `.superset`, so
 * `git worktree add` does not materialize setup/run/ports files. Not a hard
 * override — an existing worktree `.superset` is left untouched.
 */
export async function copyProjectSupersetConfigToWorktree(
	repoPath: string,
	worktreePath: string,
): Promise<void> {
	const source = join(repoPath, PROJECT_SUPERSET_DIR_NAME);
	const target = join(worktreePath, PROJECT_SUPERSET_DIR_NAME);

	if (!existsSync(source) || existsSync(target)) return;

	try {
		// Async `cp`: the tree walk runs on libuv's thread pool, so the
		// host-service event loop keeps serving (rmSync/cpSync would block it).
		await cp(source, target, { recursive: true });
	} catch (error) {
		console.warn(
			`Failed to copy ${PROJECT_SUPERSET_DIR_NAME} to worktree: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
