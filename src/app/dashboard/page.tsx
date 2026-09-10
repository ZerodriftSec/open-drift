import { QueueStatusPanel } from "@/app/components/dashboard/queue-status-panel";
import { AppShell } from "@/app/components/layout/app-shell";
import { SessionAutoRefresh } from "@/app/components/sessions/session-auto-refresh";
import { getSessionQueue } from "@/server/db/store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  const snapshot = await getSessionQueue().getSnapshot();
  const hasActiveQueues =
    snapshot.totals.activeCount > 0 || snapshot.totals.queuedCount > 0;

  return (
    <AppShell activeNav="dashboard" title="Dashboard">
      <SessionAutoRefresh enabled={hasActiveQueues} />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid w-full max-w-6xl gap-4">
          <QueueStatusPanel snapshot={snapshot} />
        </div>
      </div>
    </AppShell>
  );
}
