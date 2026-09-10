"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  MessageSquareText,
  PencilLine,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { errorMessage, requestJson } from "@/app/components/lib/api-client";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/app/components/ui/dialog";
import { Textarea } from "@/app/components/ui/field";
import { cn } from "@/lib/utils";

type FindingView =
  | "ai-confirmed"
  | "human-confirmed"
  | "human-rejected"
  | "onchain-confirmed"
  | "pending";
type ReviewAction = "confirm" | "pass";
type ReviewMutationAction = ReviewAction | "reset";
type HumanFindingStatus = "fp" | "tp";
type FindingState = {
  findingId: number | string;
  findingKey: string;
  humanStatus: HumanFindingStatus | null;
  note: string | null;
  sessionId: string;
};

const findingStateResponseSchema = z.object({
  findingId: z.union([z.number(), z.string()]),
  findingKey: z.string(),
  humanStatus: z.enum(["fp", "tp"]).nullable(),
  note: z.string().nullable(),
  sessionId: z.string(),
});
const findingReviewResponseSchema = z.object({
  action: z.enum(["confirm", "pass", "reset"]),
  findingKey: z.string(),
  findingView: z.enum([
    "ai-confirmed",
    "human-confirmed",
    "human-rejected",
    "onchain-confirmed",
    "pending",
  ]),
  humanStatus: z.enum(["fp", "tp"]).nullable(),
  message: z.string(),
  redirectTo: z.string(),
  sessionId: z.string(),
  source: z.enum(["confirmed", "pending"]),
});
const findingNoteResponseSchema = z.object({
  finding: z
    .object({
      note: z.string().nullable().optional(),
    })
    .passthrough(),
  message: z.string(),
  redirectTo: z.string(),
  sessionId: z.string(),
});
type FindingReviewResponse = z.infer<typeof findingReviewResponseSchema>;
type FindingNoteResponse = z.infer<typeof findingNoteResponseSchema>;
type FindingMutationContext = {
  previous?: FindingState;
};

export function FindingInteractions({
  duplicateOfId,
  findingId,
  findingKey,
  findingTitle,
  findingView,
  initialHumanStatus,
  initialNote,
  readOnly = false,
  sessionId,
}: {
  duplicateOfId?: number | string | null;
  findingId?: number | string;
  findingKey: string;
  findingTitle: string;
  findingView: FindingView;
  initialHumanStatus?: HumanFindingStatus | null;
  initialNote?: string | null;
  readOnly?: boolean;
  sessionId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(initialNote ?? "");
  const noteCloseRequestedRef = useRef(false);
  const queryKey = findingStateQueryKey(sessionId, findingKey);
  const initialState: FindingState = {
    findingId: findingId ?? findingKey,
    findingKey,
    humanStatus: initialHumanStatus ?? null,
    note: initialNote?.trim() || null,
    sessionId,
  };
  const stateQuery = useQuery({
    enabled: findingId !== undefined,
    initialData: initialState,
    queryFn: () =>
      findingId === undefined
        ? Promise.resolve(initialState)
        : requestJson(
            findingStateUrl({ findingId, findingKey, sessionId }),
            {},
            findingStateResponseSchema,
            "Failed to read Finding status",
          ),
    queryKey,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const state = stateQuery.data;
  const humanStatus = state.humanStatus;
  const hasNote = Boolean(state.note?.trim());
  const isNoteDirty =
    normalizeNote(noteDraft) !== normalizeNote(state.note ?? "");
  const isTpSelected = humanStatus === "tp";
  const isFpSelected = humanStatus === "fp";
  const showReviewActions =
    !readOnly &&
    findingId !== undefined &&
    (findingView === "ai-confirmed" ||
      findingView === "human-confirmed" ||
      findingView === "human-rejected" ||
      findingView === "onchain-confirmed" ||
      findingView === "pending");

  const reviewMutation = useMutation<
    FindingReviewResponse,
    Error,
    ReviewMutationAction,
    FindingMutationContext
  >({
    mutationFn: (action: ReviewMutationAction) =>
      requestJson(
        `/api/sessions/${sessionId}/finding-review`,
        {
          json: { action, findingId },
          method: "POST",
        },
        findingReviewResponseSchema,
        "Failed to update Finding review",
      ),
    onError: (error, action, context) => {
      void action;
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      toast.error(errorMessage(error, "Failed to update Finding review"));
    },
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FindingState>(queryKey);
      queryClient.setQueryData<FindingState>(queryKey, (current) => ({
        ...(current ?? initialState),
        humanStatus:
          action === "confirm" ? "tp" : action === "pass" ? "fp" : null,
      }));
      return { previous };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: (response) => {
      queryClient.setQueryData<FindingState>(queryKey, (current) => ({
        ...(current ?? initialState),
        humanStatus: response.humanStatus,
      }));
      toast.success(response.message);
      router.refresh();
    },
  });

  const noteMutation = useMutation<
    FindingNoteResponse,
    Error,
    string,
    FindingMutationContext
  >({
    mutationFn: (note: string) =>
      requestJson(
        `/api/sessions/${sessionId}/finding-note`,
        {
          json: { findingId, findingView, note },
          method: "POST",
        },
        findingNoteResponseSchema,
        "Failed to save Finding Note",
      ),
    onError: (error, note, context) => {
      void note;
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      toast.error(errorMessage(error, "Failed to save Finding Note"));
    },
    onMutate: async (note) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FindingState>(queryKey);
      queryClient.setQueryData<FindingState>(queryKey, (current) => ({
        ...(current ?? initialState),
        note: note.trim() || null,
      }));
      return { previous };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: (response) => {
      const note = response.finding.note?.trim() || null;
      queryClient.setQueryData<FindingState>(queryKey, (current) => ({
        ...(current ?? initialState),
        note,
      }));
      setNoteDraft(note ?? "");
      setNoteOpen(false);
      toast.success(response.message);
    },
  });

  function openNote() {
    noteCloseRequestedRef.current = false;
    setNoteDraft(state.note ?? "");
    setNoteOpen(true);
  }

  function requestCloseNote() {
    if (noteMutation.isPending || noteCloseRequestedRef.current) return;

    if (!isNoteDirty) {
      setNoteOpen(false);
      return;
    }

    noteCloseRequestedRef.current = true;
    noteMutation.mutate(noteDraft, {
      onSettled: () => {
        noteCloseRequestedRef.current = false;
      },
    });
  }

  function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    noteMutation.mutate(noteDraft);
  }

  function updateReview(action: ReviewAction) {
    const selectedStatus = action === "confirm" ? "tp" : "fp";
    reviewMutation.mutate(humanStatus === selectedStatus ? "reset" : action);
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1.5">
          {duplicateOfId ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="warning">Duplicate</Badge>
              <span className="font-mono text-[11px] text-app-text-muted">
                #{findingId ?? "?"} → canonical #{duplicateOfId}
              </span>
            </div>
          ) : null}
          {humanStatus ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {humanStatus === "tp" ? (
                <Badge tone="success">
                  Current review · TP · Valid finding
                </Badge>
              ) : (
                <Badge tone="danger">
                  Current review · FP · Invalid finding
                </Badge>
              )}
            </div>
          ) : null}
          <h4 className="m-0 break-words text-[13px] font-semibold leading-snug text-app-text">
            {findingTitle}
          </h4>
        </div>

        {findingId || showReviewActions ? (
          <div
            aria-busy={reviewMutation.isPending || undefined}
            className="flex shrink-0 flex-wrap items-center justify-end gap-1.5"
            data-query-fetching={stateQuery.isFetching || undefined}
          >
            {findingId ? (
              <Button
                aria-label={
                  hasNote
                    ? "Edit Finding Note (note exists)"
                    : "Add Finding Note"
                }
                className={cn(
                  "font-semibold",
                  hasNote
                    ? "border-app-border bg-app-surface text-app-text-secondary hover:border-app-border-strong hover:bg-app-surface-muted"
                    : "border-app-border bg-app-surface text-app-text-secondary hover:border-app-info-border hover:bg-app-info-bg hover:text-app-info",
                )}
                icon={MessageSquareText}
                onClick={openNote}
                size="sm"
                title={hasNote ? (state.note ?? undefined) : "Add Finding Note"}
                variant="outline"
              >
                Note
                {hasNote ? (
                  <span
                    aria-label="Note exists"
                    className="size-1.5 rounded-full bg-app-info"
                  />
                ) : null}
              </Button>
            ) : null}
            {findingId && showReviewActions ? (
              <span
                aria-hidden="true"
                className="mx-0.5 h-5 w-px bg-app-border-faint"
              />
            ) : null}
            {showReviewActions ? (
              <Button
                aria-label={
                  isTpSelected
                    ? "Clear TP review (valid finding)"
                    : "Mark as TP (valid finding)"
                }
                aria-pressed={isTpSelected}
                className={cn(
                  "min-w-14 font-semibold tracking-wide",
                  isTpSelected
                    ? "border-app-success bg-app-success text-white disabled:border-app-success disabled:bg-app-success disabled:text-white disabled:opacity-100"
                    : "border-app-border bg-app-surface text-app-text-secondary hover:border-app-success-border hover:bg-app-success-bg hover:text-app-success",
                )}
                disabled={reviewMutation.isPending}
                icon={CheckCircle2}
                loading={
                  reviewMutation.isPending &&
                  (reviewMutation.variables === "confirm" ||
                    (reviewMutation.variables === "reset" && isTpSelected))
                }
                onClick={() => updateReview("confirm")}
                size="sm"
                title={
                  isTpSelected
                    ? "Click again to clear TP review"
                    : "TP: confirm as valid"
                }
                variant="outline"
              >
                {isTpSelected ? "TP · Current" : "TP"}
              </Button>
            ) : null}
            {showReviewActions ? (
              <Button
                aria-label={
                  isFpSelected
                    ? "Clear FP review (invalid finding)"
                    : "Mark as FP (invalid finding)"
                }
                aria-pressed={isFpSelected}
                className={cn(
                  "min-w-14 font-semibold tracking-wide",
                  isFpSelected
                    ? "border-app-danger bg-app-danger text-white disabled:border-app-danger disabled:bg-app-danger disabled:text-white disabled:opacity-100"
                    : "border-app-border bg-app-surface text-app-text-secondary hover:border-app-danger-border hover:bg-app-danger-bg hover:text-app-danger",
                )}
                disabled={reviewMutation.isPending}
                icon={XCircle}
                loading={
                  reviewMutation.isPending &&
                  (reviewMutation.variables === "pass" ||
                    (reviewMutation.variables === "reset" && isFpSelected))
                }
                onClick={() => updateReview("pass")}
                size="sm"
                title={
                  isFpSelected
                    ? "Click again to clear FP review"
                    : "FP: confirm as invalid"
                }
                variant="outline"
              >
                {isFpSelected ? "FP · Current" : "FP"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {hasNote ? (
        <div
          className="grid gap-1 text-[12px] leading-snug md:grid-cols-[112px_minmax(0,1fr)]"
          data-slot="finding-note"
        >
          <div className="text-[11px] font-medium text-app-text-muted">
            Note
          </div>
          <button
            aria-label="Edit Finding Note"
            className="group flex min-w-0 items-start gap-2 rounded-app-sm border border-app-border-faint bg-app-surface-muted px-2 py-1.5 text-left text-app-text-secondary outline-none transition-colors hover:border-app-border hover:bg-app-surface focus-visible:ring-2 focus-visible:ring-ring/25"
            onClick={openNote}
            title="Click to edit Note"
            type="button"
          >
            <span className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">
              {state.note}
            </span>
            <PencilLine
              aria-hidden="true"
              className="mt-0.5 size-3 shrink-0 text-app-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </button>
        </div>
      ) : null}

      <Dialog
        open={noteOpen}
        onOpenChange={(open) => {
          if (open) {
            setNoteOpen(true);
            return;
          }
          requestCloseNote();
        }}
        size="md"
      >
        <DialogHeader
          description={findingTitle}
          onClose={requestCloseNote}
          title="Finding Note"
        />
        <form
          aria-busy={noteMutation.isPending || undefined}
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={submitNote}
        >
          <DialogBody className="grid content-start gap-2">
            <label
              className="text-[12px] font-medium text-app-text-secondary"
              htmlFor={`finding-note-${findingId ?? findingKey}`}
            >
              Manual note
            </label>
            <Textarea
              autoFocus
              className="min-h-32 text-[12px]"
              id={`finding-note-${findingId ?? findingKey}`}
              maxLength={4_000}
              name="note"
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Add review rationale, reproduction details, or follow-up actions; save an empty value to clear"
              value={noteDraft}
            />
            <p
              className={cn(
                "m-0 text-[11px]",
                isNoteDirty ? "text-app-warning" : "text-app-text-muted",
              )}
            >
              {isNoteDirty
                ? "There are unsaved changes; closing the dialog will save them automatically."
                : "Notes are for manual records only; changes are saved automatically when the dialog closes."}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={noteMutation.isPending}
              onClick={requestCloseNote}
              size="sm"
              type="button"
              variant="ghost"
            >
              {isNoteDirty ? "Save and close" : "Close"}
            </Button>
            <Button
              loading={noteMutation.isPending}
              size="sm"
              type="submit"
              variant="primary"
            >
              Save Note
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}

function findingStateQueryKey(sessionId: string, findingKey: string) {
  return ["session-finding-state", sessionId, findingKey] as const;
}

function normalizeNote(note: string) {
  return note.trim();
}

function findingStateUrl({
  findingId,
  findingKey,
  sessionId,
}: {
  findingId: number | string;
  findingKey: string;
  sessionId: string;
}) {
  const query = new URLSearchParams({
    findingId: String(findingId),
    findingKey,
  });
  return `/api/sessions/${sessionId}/finding-state?${query.toString()}`;
}
