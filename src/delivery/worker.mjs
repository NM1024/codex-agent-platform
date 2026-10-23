export function createDeliveryWorker({ store, config }) {
  let current,
    again = false;
  return function deliver() {
    again = true;
    if (current) return current;
    current = (async () => {
      do {
        again = false;
        for (const module of store.registry.modules.values())
          await module.delivery?.reconcile?.({ store, config });
        const rows = store.db
          .prepare(
            "SELECT q.task_id,q.type FROM agent_requests q JOIN agent_deliveries d USING(task_id) WHERE d.status IN ('pending','blocked_configuration')",
          )
          .all();
        for (const row of rows) {
          const module = store.moduleFor(store.raw(row.task_id));
          if (!module.delivery?.execute) continue;
          store.db
            .prepare(
              "UPDATE agent_deliveries SET status='pending' WHERE task_id=? AND status='blocked_configuration'",
            )
            .run(row.task_id);
          try {
            const outcome = await module.delivery.execute({
              store,
              config,
              task: store.get(row.task_id),
            });
            const allowed = [
              "accepted",
              "failed",
              "unknown",
              "partial",
              "pending",
              "blocked_configuration",
            ];
            store.db
              .prepare("UPDATE agent_deliveries SET status=? WHERE task_id=?")
              .run(
                allowed.includes(outcome?.status) ? outcome.status : "unknown",
                row.task_id,
              );
          } catch {
            store.db
              .prepare(
                "UPDATE agent_deliveries SET status='unknown' WHERE task_id=?",
              )
              .run(row.task_id);
          }
        }
      } while (again);
    })().finally(() => {
      current = null;
    });
    return current;
  };
}
