import { describe, expect, it } from "bun:test";
import type { DashboardNewWorkspaceDraft } from "../../../../../DashboardNewWorkspaceDraftContext";
import { resolveNames } from "./resolveNames";

function makeDraft(
	overrides: Partial<DashboardNewWorkspaceDraft>,
): DashboardNewWorkspaceDraft {
	return {
		selectedProjectId: "p1",
		isSession: false,
		hostId: null,
		checkout: "worktree",
		environmentId: null,
		prompt: "",
		baseBranch: null,
		baseBranchSource: null,
		workspaceName: "",
		workspaceNameEdited: false,
		branchName: "",
		branchNameEdited: false,
		branchNameFromProvider: false,
		linkedIssues: [],
		linkedPR: null,
		selectedAgentId: null,
		attachments: [],
		...overrides,
	};
}

describe("resolveNames", () => {
	it("derives a branch slug from the typed workspace name when branch is blank", () => {
		const result = resolveNames(
			makeDraft({ workspaceName: "Fix auth flow", workspaceNameEdited: true }),
		);
		expect(result.workspaceName).toBe("Fix auth flow");
		expect(result.branchName).toBe("fix-auth-flow");
	});

	it("preserves an explicitly typed branch name when both fields are present", () => {
		const result = resolveNames(
			makeDraft({
				workspaceName: "Fix auth flow",
				workspaceNameEdited: true,
				branchName: "my-branch",
				branchNameEdited: true,
			}),
		);
		expect(result.branchName).toBe("my-branch");
	});

	it("returns null branch when nothing was typed", () => {
		const result = resolveNames(makeDraft({}));
		expect(result.branchName).toBeNull();
		expect(result.workspaceName).toBeNull();
	});
});