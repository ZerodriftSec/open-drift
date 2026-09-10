import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { WorkflowJsonEditor } from "@/components/workflows/workflow-json-editor";
import { getWorkflowDocument } from "@/server/workflows";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId: routeWorkflowId } = await params;
  const workflowId = decodeRouteSegment(routeWorkflowId);
  let workflow;
  try {
    workflow = await getWorkflowDocument(workflowId);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(" not found.")) {
      notFound();
    }
    throw error;
  }
  return (
    <AppShell
      activeNav="workflows"
      title="Workflow"
      subtitle="View the diagram or edit the complete JSON definition"
    >
      <WorkflowJsonEditor initialWorkflow={workflow} />
    </AppShell>
  );
}

function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
