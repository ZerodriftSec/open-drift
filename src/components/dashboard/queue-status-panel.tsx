import { Badge } from "@/app/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/app/components/ui/card";
import type { QueueSnapshot } from "@/audit/queue";
import { Activity } from "lucide-react";

export function QueueStatusPanel({ snapshot }: { snapshot: QueueSnapshot }) {
  const hasQueues = snapshot.queues.length > 0;
  const activeTone =
    snapshot.totals.activeCount > 0
      ? "success"
      : snapshot.totals.queuedCount > 0
        ? "warning"
        : "muted";

  return (
    <section aria-labelledby="runtime-queues-title" className="grid gap-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" />
          <h2
            className="m-0 text-[13px] font-semibold text-app-text"
            id="runtime-queues-title"
          >
            Runtime Queues
          </h2>
        </span>
        <Badge tone={activeTone}>
          {snapshot.totals.activeCount} running / {snapshot.totals.queuedCount}{" "}
          queued
        </Badge>
      </div>

      {hasQueues ? (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.queues.map((queue) => (
            <Card className="min-w-0" key={queue.key}>
              <CardHeader
                action={
                  <QueueStatusBadge
                    activeCount={queue.activeCount}
                    queuedCount={queue.queuedCount}
                  />
                }
              >
                <span
                  className="min-w-0 truncate font-mono text-[13px] font-semibold text-app-text"
                  title={queue.key}
                >
                  {queue.key}
                </span>
              </CardHeader>
              <CardBody>
                <div className="grid grid-cols-3 gap-2">
                  <QueueMetric label="Running" value={queue.activeCount} />
                  <QueueMetric label="Queued" value={queue.queuedCount} />
                  <QueueMetric label="Concurrency" value={queue.concurrency} />
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : (
        <Card variant="flat">
          <CardBody className="text-[12px] text-app-text-muted">
            No queues are currently running or queued.
          </CardBody>
        </Card>
      )}
    </section>
  );
}

function QueueMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="truncate font-mono text-[12px] font-semibold text-app-text">
        {value}
      </span>
      <span className="truncate text-[10px] text-app-text-muted">{label}</span>
    </div>
  );
}

function QueueStatusBadge({
  activeCount,
  queuedCount,
}: {
  activeCount: number;
  queuedCount: number;
}) {
  if (activeCount > 0) {
    return (
      <Badge tone="success" dot>
        running
      </Badge>
    );
  }

  if (queuedCount > 0) {
    return (
      <Badge tone="warning" dot>
        queued
      </Badge>
    );
  }

  return (
    <Badge tone="muted" dot>
      idle
    </Badge>
  );
}
