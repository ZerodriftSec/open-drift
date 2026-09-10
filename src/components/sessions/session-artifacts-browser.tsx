"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ReadOnlyFileBrowser } from "@/app/components/files/read-only-file-browser";
import { Button, buttonVariants } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/app/components/ui/dialog";
import { cn } from "@/lib/utils";

export function SessionArtifactsBrowser({
  className,
  sessionId,
}: {
  className?: string;
  sessionId: string;
}) {
  return (
    <ReadOnlyFileBrowser
      className={className}
      defaultTreeWidth={260}
      downloadUrl={(treePath) => sessionArtifactArchiveUrl(sessionId, treePath)}
      fileDownloadUrl={(filePath) =>
        sessionArtifactDownloadUrl(sessionId, filePath)
      }
      fileUrl={(filePath) => sessionArtifactFileUrl(sessionId, filePath)}
      resourceKey={`session-artifacts:${sessionId}`}
      treeHeaderAction={
        <SessionArtifactsDownloadButton
          className="h-7 w-7"
          sessionId={sessionId}
        />
      }
      treeLabel="Session artifacts"
      treeTitle="Artifacts"
      treeUrl={(treePath) => sessionArtifactTreeUrl(sessionId, treePath)}
    />
  );
}

export function SessionArtifactsDownloadButton({
  className,
  sessionId,
}: {
  className?: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const archiveUrl = sessionArtifactArchiveUrl(sessionId, "");

  return (
    <>
      <Button
        aria-label="Download all Artifacts"
        className={cn(
          "h-8 w-8 text-muted-foreground hover:text-foreground",
          className,
        )}
        icon={Download}
        onClick={() => setOpen(true)}
        size="icon"
        title="Download all Artifacts"
        type="button"
        variant="ghost"
      />

      <Dialog open={open} onOpenChange={setOpen} size="sm">
        <DialogHeader
          title="Download all Artifacts"
          description="Archive the current Session's artifacts directory and download it as a ZIP file."
          onClose={() => setOpen(false)}
        />
        <DialogBody>
          <p className="m-0 text-[13px] text-app-text-secondary">
            Start archiving and downloading the artifacts?
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <a
            className={buttonVariants({ size: "sm", variant: "primary" })}
            href={archiveUrl}
            onClick={() => {
              setOpen(false);
              toast.success("Artifact archive download started");
            }}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download</span>
          </a>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function sessionArtifactTreeUrl(sessionId: string, path: string) {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }
  const query = params.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/tree${query ? `?${query}` : ""}`;
}

function sessionArtifactFileUrl(sessionId: string, path: string) {
  const params = new URLSearchParams({ path });
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?${params.toString()}`;
}

function sessionArtifactDownloadUrl(sessionId: string, path: string) {
  const params = new URLSearchParams({ path });
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/download?${params.toString()}`;
}

function sessionArtifactArchiveUrl(sessionId: string, path: string) {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }
  const query = params.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/archive${query ? `?${query}` : ""}`;
}
