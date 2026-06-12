import { flattenNodes, nextRunAt, patchSessionMeta, scanAtreeTree } from "./atree";
import { broadcastSessionEvent, getPiSession } from "./pi";

export function startScheduler(root: string): () => void {
  const interval = setInterval(() => {
    void tick(root);
  }, 30_000);
  void tick(root);
  return () => clearInterval(interval);
}

async function tick(root: string): Promise<void> {
  const now = new Date();
  for (const node of flattenNodes(scanAtreeTree(root))) {
    for (const meta of node.sessions) {
      if (!meta.schedule) continue;
      const due = meta.next_run_at ? new Date(meta.next_run_at) : undefined;
      if (!due || Number.isNaN(due.getTime())) {
        patchSessionMeta(node.path, meta.id, { next_run_at: nextRunAt(meta.schedule), updated_at: now.toISOString() });
        continue;
      }
      if (due > now) continue;

      try {
        const session = await getPiSession(node.path, meta.id, meta.title);
        await session.sendCustomMessage(
          {
            customType: "atree.schedule",
            content: `atree CRON 唤醒：${meta.schedule}\n当前目录：${node.path}\n请根据这个周期会话此前沉淀的任务继续执行。`,
            display: true,
            details: { schedule: meta.schedule, dueAt: due.toISOString() },
          },
          { triggerTurn: true },
        );
        patchSessionMeta(node.path, meta.id, {
          last_run_at: now.toISOString(),
          next_run_at: nextRunAt(meta.schedule, now),
          updated_at: now.toISOString(),
        });
        broadcastSessionEvent(meta.id, { type: "atree_messages_changed" });
      } catch (error) {
        broadcastSessionEvent(meta.id, {
          type: "atree_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
