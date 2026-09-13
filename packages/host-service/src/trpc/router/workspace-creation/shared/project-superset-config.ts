import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT_SUPERSET_DIR_NAME = ".superset";

/**
 * Mirror V1's `copySupersetConfigToWorktree()`: copy the main repo's
 * repo-local `.superset` directory into a new/imported worktree when the
 * worktree has none of its own. Many projects locally ignore `.superset`, so
 * `git worktree add` does not materialize setup/run/ports files. Not a hard
 * override — an existing worktree `.superset` is left untouched.
 */
export function copyProjectSupersetConfigToWorktree(
	repoPath: string,
	worktreePath: string,
): void {
	const source = join(repoPath, PROJECT_SUPERSET_DIR_NAME);
	const target = join(worktreePath, PROJECT_SUPERSET_DIR_NAME);

	if (!existsSync(source) || existsSync(target)) return;

	try {
		cpSync(source, target, { recursive: true });
	} catch (error) {
		console.warn(
			`Failed to copy ${PROJECT_SUPERSET_DIR_NAME} to worktree: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
