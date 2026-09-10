import { runWorkflow } from "@/audit/runner";
import { getSessionQueue } from "@/server/db/store";
import { isAppRuntimeShuttingDown } from "@/server/runtime/cleanup";
import { recordSessionQueueConsumerFailure } from "@/server/sessions/queue-failure";

const queue = getSessionQueue();

queue.consume(async (item, control) => {
  try {
    await runWorkflow(item, control);
  } catch (error) {
    if (!isAppRuntimeShuttingDown()) {
      try {
        await recordSessionQueueConsumerFailure(item.sessionId, error);
      } catch (recordError) {
        console.error("Failed to record Session queue consumer failure", {
          error: recordError,
          sessionId: item.sessionId,
        });
      }
    }
    throw error;
  }
});
