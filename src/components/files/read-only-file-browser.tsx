"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/app/components/ui/empty-state";
import { buttonVariants } from "@/app/components/ui/button";
import { cn } from "@/lib/utils";

type FileTreeEntry = {
  name: string;
  path: string;
  size?: number;
  type: "dir" | "file";
};

type FileTreeResponse = {
  entries: FileTreeEntry[];
  path: string;
};

type FileContentResponse = {
  content: string;
  encoding: "utf-8";
  maxBytes: number;
  name: string;
  path: string;
  size: number;
  truncated: boolean;
};

type HighlightResult = {
  content: string;
  failed: boolean;
  html: string | null;
  path: string;
};

type EndpointBuilder = (path: string) => string;

const DEFAULT_TREE_WIDTH = 320;
const SHIKI_THEME = "github-light";

export function ReadOnlyFileBrowser({
  className,
  defaultTreeWidth = DEFAULT_TREE_WIDTH,
  downloadUrl,
  emptyDirectoryText = "This directory is empty.",
  emptySelectionDescription,
  emptySelectionTitle = "Select a file",
  fileDownloadUrl,
  fileUrl,
  resourceKey,
  showTreeHeader = true,
  treeHeaderAction,
  treeLabel = "Files",
  treeSubtitle,
  treeTitle = "Directory tree",
  treeUrl,
}: {
  className?: string;
  defaultTreeWidth?: number;
  emptyDirectoryText?: string;
  emptySelectionDescription?: string;
  emptySelectionTitle?: string;
  downloadUrl?: EndpointBuilder;
  fileDownloadUrl?: EndpointBuilder;
  fileUrl: EndpointBuilder;
  resourceKey: string;
  showTreeHeader?: boolean;
  treeHeaderAction?: ReactNode;
  treeLabel?: string;
  treeSubtitle?: string;
  treeTitle?: string;
  treeUrl: EndpointBuilder;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set([""]),
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const fileQuery = useQuery({
    enabled: Boolean(selectedPath),
    queryFn: () => fetchJson<FileContentResponse>(fileUrl(selectedPath ?? "")),
    queryKey: ["read-only-file", resourceKey, selectedPath],
    staleTime: 30_000,
  });

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const gridStyle: CSSProperties & { "--file-browser-tree-width": string } = {
    "--file-browser-tree-width": `${defaultTreeWidth}px`,
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-background md:grid md:grid-cols-[var(--file-browser-tree-width)_minmax(0,1fr)]"
        style={gridStyle}
      >
        <aside className="relative flex min-h-44 min-w-0 flex-col overflow-hidden border-b border-border bg-card md:min-h-0 md:border-b-0 md:border-r">
          {showTreeHeader ? (
            <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
              <div className="min-w-0">
                <h2 className="m-0 truncate text-[13px] font-semibold text-card-foreground">
                  {treeTitle}
                </h2>
                {treeSubtitle ? (
                  <p className="m-0 truncate text-[11px] text-muted-foreground">
                    {treeSubtitle}
                  </p>
                ) : null}
              </div>
              {treeHeaderAction}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <DirectoryChildren
              depth={0}
              downloadUrl={downloadUrl}
              emptyDirectoryText={emptyDirectoryText}
              expandedPaths={expandedPaths}
              onSelectFile={setSelectedPath}
              onToggleDirectory={toggleDirectory}
              path=""
              resourceKey={resourceKey}
              selectedPath={selectedPath}
              treeLabel={treeLabel}
              treeUrl={treeUrl}
            />
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <FilePreview
            emptySelectionDescription={emptySelectionDescription}
            emptySelectionTitle={emptySelectionTitle}
            error={fileQuery.error}
            file={fileQuery.data}
            fileDownloadUrl={fileDownloadUrl}
            isLoading={fileQuery.isFetching}
            selectedPath={selectedPath}
          />
        </section>
      </div>
    </div>
  );
}

function DirectoryChildren({
  depth,
  downloadUrl,
  emptyDirectoryText,
  expandedPaths,
  onSelectFile,
  onToggleDirectory,
  path,
  resourceKey,
  selectedPath,
  treeLabel,
  treeUrl,
}: {
  depth: number;
  downloadUrl?: EndpointBuilder;
  emptyDirectoryText: string;
  expandedPaths: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  path: string;
  resourceKey: string;
  selectedPath: string | null;
  treeLabel: string;
  treeUrl: EndpointBuilder;
}) {
  const isRoot = path === "";
  const isExpanded = isRoot || expandedPaths.has(path);
  const treeQuery = useQuery({
    enabled: isExpanded,
    queryFn: () => fetchJson<FileTreeResponse>(treeUrl(path)),
    queryKey: ["read-only-tree", resourceKey, path],
    staleTime: 30_000,
  });

  if (!isExpanded) {
    return null;
  }

  if (treeQuery.isLoading) {
    return (
      <div className="flex h-8 items-center gap-2 px-3 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Load directory
      </div>
    );
  }

  if (treeQuery.error) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] text-app-danger">
        <AlertCircle
          className="mt-0.5 h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 break-words">
          {errorMessage(treeQuery.error)}
        </span>
      </div>
    );
  }

  const entries = treeQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return isRoot ? (
      <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
        {emptyDirectoryText}
      </div>
    ) : null;
  }

  return (
    <div
      role={isRoot ? "tree" : "group"}
      aria-label={isRoot ? treeLabel : undefined}
    >
      {entries.map((entry) => (
        <Fragment key={entry.path}>
          <TreeEntryRow
            depth={depth}
            downloadUrl={downloadUrl}
            entry={entry}
            expanded={expandedPaths.has(entry.path)}
            onSelectFile={onSelectFile}
            onToggleDirectory={onToggleDirectory}
            selected={entry.type === "file" && entry.path === selectedPath}
          />
          {entry.type === "dir" ? (
            <DirectoryChildren
              depth={depth + 1}
              downloadUrl={downloadUrl}
              emptyDirectoryText={emptyDirectoryText}
              expandedPaths={expandedPaths}
              onSelectFile={onSelectFile}
              onToggleDirectory={onToggleDirectory}
              path={entry.path}
              resourceKey={resourceKey}
              selectedPath={selectedPath}
              treeLabel={treeLabel}
              treeUrl={treeUrl}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function TreeEntryRow({
  depth,
  downloadUrl,
  entry,
  expanded,
  onSelectFile,
  onToggleDirectory,
  selected,
}: {
  depth: number;
  downloadUrl?: EndpointBuilder;
  entry: FileTreeEntry;
  expanded: boolean;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  selected: boolean;
}) {
  const isDirectory = entry.type === "dir";
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : FileText;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      className={cn(
        "group flex h-7 w-full min-w-0 items-center pr-1 text-left text-[12px] outline-none transition-colors",
        "hover:bg-muted focus-within:bg-muted",
        selected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
      role="none"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={entry.path}
    >
      <button
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={selected}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left outline-none"
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(entry.path);
          } else {
            onSelectFile(entry.path);
          }
        }}
        role="treeitem"
        type="button"
      >
        {isDirectory ? (
          <Chevron
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isDirectory ? "text-app-info" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {!isDirectory && entry.size !== undefined ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatBytes(entry.size)}
          </span>
        ) : null}
      </button>
      {isDirectory && downloadUrl ? (
        <DirectoryDownloadLink
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          href={downloadUrl(entry.path)}
          label={`Download ${entry.path}`}
        />
      ) : null}
    </div>
  );
}

function DirectoryDownloadLink({
  className,
  href,
  label,
  toastMessage = "Directory archive download started",
}: {
  className?: string;
  href: string;
  label: string;
  toastMessage?: string;
}) {
  return (
    <a
      aria-label={label}
      className={cn(
        buttonVariants({ size: "icon", variant: "ghost" }),
        "h-6 w-6 text-muted-foreground hover:text-foreground",
        className,
      )}
      href={href}
      onClick={() => toast.success(toastMessage)}
      title={label}
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

function FilePreview({
  emptySelectionDescription,
  emptySelectionTitle,
  error,
  file,
  fileDownloadUrl,
  isLoading,
  selectedPath,
}: {
  emptySelectionDescription?: string;
  emptySelectionTitle: string;
  error: Error | null;
  file?: FileContentResponse;
  fileDownloadUrl?: EndpointBuilder;
  isLoading: boolean;
  selectedPath: string | null;
}) {
  const [highlightResult, setHighlightResult] =
    useState<HighlightResult | null>(null);
  const content = file?.content ?? "";
  const hasFile = Boolean(file);
  const currentHighlight =
    highlightResult?.path === selectedPath &&
    highlightResult.content === content
      ? highlightResult
      : null;
  const highlightedHtml = currentHighlight?.html ?? null;
  const highlightFailed = currentHighlight?.failed ?? false;

  useEffect(() => {
    let cancelled = false;

    if (!hasFile || !selectedPath) {
      return () => {
        cancelled = true;
      };
    }

    void highlightFileContent(content, selectedPath)
      .then((html) => {
        if (!cancelled) {
          setHighlightResult({
            content,
            failed: false,
            html,
            path: selectedPath,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightResult({
            content,
            failed: true,
            html: null,
            path: selectedPath,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [content, hasFile, selectedPath]);

  if (!selectedPath) {
    return (
      <EmptyState
        className="m-4 min-h-[220px] flex-1"
        icon={FileText}
        title={emptySelectionTitle}
      >
        {emptySelectionDescription}
      </EmptyState>
    );
  }

  if (error) {
    return (
      <EmptyState
        className="m-4 min-h-[220px] flex-1 border-app-danger-border bg-app-danger-bg"
        icon={AlertCircle}
        title="This file cannot be previewed"
      >
        {errorMessage(error)}
      </EmptyState>
    );
  }

  return (
    <>
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="min-w-0">
          <h2 className="m-0 truncate font-mono text-[12px] font-medium text-foreground">
            {selectedPath}
          </h2>
          <p className="m-0 text-[11px] text-muted-foreground">
            {file ? formatBytes(file.size) : "Loading"}
            {file?.truncated
              ? `, truncated to ${formatBytes(file.maxBytes)}`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isLoading ? (
            <Loader2
              className="h-4 w-4 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          {fileDownloadUrl ? (
            <DirectoryDownloadLink
              href={fileDownloadUrl(selectedPath)}
              label={`Download ${selectedPath}`}
              toastMessage="File download started"
            />
          ) : null}
        </div>
      </div>
      <div className="shiki-code-viewer min-h-0 flex-1 overflow-auto bg-background">
        {file && highlightedHtml && !highlightFailed ? (
          <div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <PlainCodeWithLineNumbers content={content} />
        )}
      </div>
    </>
  );
}

function PlainCodeWithLineNumbers({ content }: { content: string }) {
  return (
    <pre className="shiki plain-shiki-fallback">
      <code>
        {codeLines(content).map((line, index) => (
          <span className="line" key={index}>
            {line || "\u00a0"}
          </span>
        ))}
      </code>
    </pre>
  );
}

async function highlightFileContent(content: string, filePath: string) {
  const { codeToHtml } = await import("shiki");
  const language = languageForFilePath(filePath);

  try {
    return normalizeShikiHtml(
      await codeToHtml(content, {
        lang: language,
        theme: SHIKI_THEME,
      }),
    );
  } catch {
    if (language === "text") {
      throw new Error("Shiki failed to highlight plain text.");
    }

    return normalizeShikiHtml(
      await codeToHtml(content, {
        lang: "text",
        theme: SHIKI_THEME,
      }),
    );
  }
}

function normalizeShikiHtml(html: string) {
  return html.replace(/\n(?=<span class="line")/g, "");
}

function languageForFilePath(filePath: string) {
  const fileName = pathBaseName(filePath).toLowerCase();
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return "dotenv";
  }
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) {
    return "dockerfile";
  }

  const specialLanguage = languageByFileName[fileName];
  if (specialLanguage) {
    return specialLanguage;
  }

  const extension = fileName.includes(".")
    ? (fileName.split(".").pop() ?? "")
    : "";
  return languageByExtension[extension] ?? "text";
}

function pathBaseName(filePath: string) {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}

function codeLines(content: string) {
  return content.split(/\r\n|\r|\n/);
}

const languageByFileName: Record<string, string> = {
  ".gitignore": "gitignore",
  makefile: "make",
};

const languageByExtension: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  csv: "csv",
  env: "dotenv",
  go: "go",
  graphql: "graphql",
  h: "c",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  lock: "text",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sol: "solidity",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  toml: "toml",
  txt: "text",
  vy: "vyper",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "zsh",
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      errorMessageFromBody(body) ?? `Request failed: ${response.status}`,
    );
  }

  return body as T;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "Request failed");
}

function errorMessageFromBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }
  return null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
