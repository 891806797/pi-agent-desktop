import { z } from "zod";

export const RecoveryAction = z.enum(["continue", "retryRecovery", "abandon"]);
export const RunIssueSchema = z.object({
	issueId: z.string(),
	attemptId: z.string(),
	revision: z.int().min(1),
	kind: z.enum(["model", "recovery", "uncertain"]),
	message: z.string(),
	createdAt: z.number(),
	allowedActions: z.array(RecoveryAction),
});
export type RunIssue = z.infer<typeof RunIssueSchema>;
export const RecoveryActionInput = z.object({
	actionId: z.uuid(),
	issueId: z.string().min(1),
	expectedRevision: z.int().min(1),
	action: RecoveryAction,
});
export type RecoveryActionInput = z.infer<typeof RecoveryActionInput>;
