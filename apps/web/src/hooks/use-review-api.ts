// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  review,
} from "@/lib/api";

// ── Review ──────────────────────────────────────────────────────────

export function useReviewAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; type?: string; action: "approve" | "reject"; reason?: string; category?: string }) => {
      if (vars.type === "agent") {
        return vars.action === "approve"
          ? review.approveAgent(vars.id, vars.category ? { category: vars.category } : undefined)
          : review.rejectAgent(vars.id, { reason: vars.reason ?? "" });
      }
      return vars.action === "approve"
        ? review.approve(vars.id)
        : review.reject(vars.id, { reason: vars.reason ?? "" });
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success(vars.action === "approve" ? "Submission approved" : "Submission rejected");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Review action failed");
    },
  });
}
// ── Bundle Review ──────────────────────────────────────────────────

export function useBundleReviewAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; action: "approve" | "reject"; reason?: string }) =>
      vars.action === "approve"
        ? review.approveBundle(vars.id)
        : review.rejectBundle(vars.id, { reason: vars.reason ?? "" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success(vars.action === "approve" ? "Bundle approved" : "Bundle rejected");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Bundle review action failed");
    },
  });
}

// ── Review (single change) ───────────────────────────────────

export function useReviewDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["review", "detail", id],
    enabled: !!id,
    queryFn: () => review.get(id!),
  });
}

export function useRelatedSkills(id: string | undefined) {
  return useQuery({
    queryKey: ["review", "related-skills", id],
    enabled: !!id,
    queryFn: () => review.relatedSkills(id!).then((r) => r.skills),
  });
}

export function useApproveWithSkills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; skillIds: string[] }) =>
      review.approveWithSkills(vars.id, { skill_ids: vars.skillIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success("MCP and related skills approved");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Bulk approve failed");
    },
  });
}

// ── Review issues: resolvable feedback attached to a change ─────────

export function useReviewIssues(subjectId: string | undefined, versionId?: string) {
  return useQuery({
    queryKey: ["review", "issues", subjectId, versionId ?? "all"],
    enabled: !!subjectId,
    queryFn: () => review.issues(subjectId!, versionId ? { version_id: versionId } : undefined),
  });
}

export function useCreateReviewIssue(subjectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; body?: string; version_id?: string; context?: string }) =>
      review.createIssue(subjectId!, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review", "issues", subjectId] }),
  });
}

export function useSetReviewIssueStatus(subjectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, status }: { issueId: string; status: "open" | "resolved" }) =>
      review.setIssueStatus(issueId, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review", "issues", subjectId] }),
  });
}

export function useCommentReviewIssue(subjectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: string }) => review.commentIssue(issueId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review", "issues", subjectId] }),
  });
}
