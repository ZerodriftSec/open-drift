import { Code2, FileJson2 } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { CreateWorkflowButton } from "@/components/workflows/create-workflow-button";
import { listWorkflowDefinitions } from "@/server/workflows";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WorkflowsPage() {
  const workflows = await listWorkflowDefinitions();
  const groups = new Map<string, typeof workflows>();
  for (const workflow of workflows) {
    const category = workflow.category?.trim() || "Uncategorized";
    const group = groups.get(category);
    if (group) group.push(workflow);
    else groups.set(category, [workflow]);
  }
  const workflowGroups = [...groups.entries()].sort(
    ([left], [right]) =>
      Number(left === "Uncategorized") - Number(right === "Uncategorized") ||
      left.localeCompare(right, "en-US"),
  );

  return (
    <AppShell
      activeNav="workflows"
      title="Workflows"
      headerAction={<CreateWorkflowButton />}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid w-full max-w-5xl gap-5">
          <div className="grid gap-5">
            {workflowGroups.map(([category, categoryWorkflows]) => (
              <section key={category} className="grid gap-2">
                <div className="flex items-center gap-3">
                  <h2 className="shrink-0 text-[12px] font-medium text-muted-foreground">
                    {category}
                  </h2>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="grid gap-2">
                  {categoryWorkflows.map((workflow) => (
                    <Link
                      key={workflow.id}
                      href={`/workflows/${encodeURIComponent(workflow.id)}`}
                      className="flex items-center justify-between gap-4 rounded-app border border-border bg-card px-4 py-3 hover:border-app-border-strong hover:bg-muted"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-[13px] font-semibold">
                            {workflow.label}
                          </p>
                          {workflow.source === "code" ? (
                            <Badge tone="primary">
                              <Code2 className="size-3" />
                              Built-in
                            </Badge>
                          ) : (
                            <Badge tone="muted">
                              <FileJson2 className="size-3" />
                              JSON file
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {workflow.stageCount} Stages ·{" "}
                          {workflow.source === "code"
                            ? "Read-only definition"
                            : `.data/workflow/${workflow.id}.json`}
                        </p>
                      </div>
                      <span className="text-[12px] text-primary">
                        {workflow.source === "code" ? "View JSON" : "Edit JSON"}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
