import type pg from "pg";
import type { Config } from "./config.js";

// DESIGN.md §9.11: polls PENDING rows and ships them independently of the
// synchronous call's outcome — the DB row is the durable record.
export function startOutboxWorker(pool: pg.Pool, config: Config): NodeJS.Timeout {
  return setInterval(async () => {
    const pending = await pool.query(
      `SELECT * FROM outbox_event WHERE status = 'PENDING' ORDER BY id LIMIT 20`
    );

    for (const event of pending.rows) {
      try {
        if (event.target === "commercial-to-search-sub") {
          // No real search index in this build — logging stands in for the
          // Pub/Sub publish the design specifies (§4's open item: Pub/Sub
          // retry/DLQ specifics are TBD at implementation time).
          console.log(`[outbox] would publish ${event.event_type} for ${event.aggregate_type}:${event.aggregate_id} to commercial-to-search-sub`);
        } else if (event.target === "api-governance-svc") {
          await fetch(`${config.governanceSvcUrl}/health`);
        }
        await pool.query(`UPDATE outbox_event SET status = 'SENT', sent_at = now() WHERE id = $1`, [event.id]);
      } catch (err) {
        console.error(`[outbox] delivery failed for event ${event.id}:`, err);
        await pool.query(`UPDATE outbox_event SET attempts = attempts + 1 WHERE id = $1`, [event.id]);
      }
    }
  }, config.outboxPollIntervalMs);
}
