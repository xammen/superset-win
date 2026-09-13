import {
	deriveWorkspaceBranchFromPrompt,
	sanitizeUserBranchName,
} from "@superset/shared/workspace-launch";
import type { DashboardNewWorkspaceDraft } from "../../../../../DashboardNewWorkspaceDraftContext";

interface ResolvedNames {
	/** User-typed (sanitized) branch, or null when not typed. */
	branchName: string | null;
	/** User-typed workspace name, or null when not typed. */
	workspaceName: string | null;
}

/**
 * Returns whatever the user typed; null otherwise. The host-service
 * seeds the branch from a typed name, otherwise creates with a friendly
 * random and applies AI names as a deferred rename.
 */
export function resolveNames(draft: DashboardNewWorkspaceDraft): ResolvedNames {
	const explicitBranch =
		draft.branchNameEdited && draft.branchName.trim()
			? sanitizeUserBranchName(draft.branchName.trim())
			: null;

	const workspaceName =
		draft.workspaceNameEdited && draft.workspaceName.trim()
			? draft.workspaceName.trim()
			: null;

	// If the user typed only the workspace name (no branch, no prompt/agent),
	// derive the branch slug from it instead of letting the host-service fall
	// back to a random friendly branch. An explicit typed branch still wins.
	const branchName =
		explicitBranch ??
		(workspaceName ? deriveWorkspaceBranchFromPrompt(workspaceName) : null);

	return { branchName, workspaceName };
}
