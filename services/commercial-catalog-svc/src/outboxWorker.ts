import type pg from "pg";
import { PubSub } from "@google-cloud/pubsub";
import type { Config } from "./config.js";
import { createApigeeProduct, attachAppToProduct } from "./governanceClient.js";

// DESIGN.md §9.11: polls PENDING rows and ships them independently of any
// synchronous call's outcome — the DB row is the durable record. Subscribing
// is fully async: POST /subscriptions only ever inserts a 'subscription' row
// (PENDING) and an 'apigee-provisioning' outbox row, in one transaction. This
// worker is the only thing that ever talks to Apigee for a subscription.
export function startOutboxWorker(pool: pg.Pool, config: Config): NodeJS.Timeout {
  const pubsub = config.pubsubSearchSyncTopic
    ? new PubSub({ projectId: config.gcpProjectId })
    : undefined;

  return setInterval(async () => {
    // Atomic claim: two Cloud Run instances can run this poller concurrently
    // (maxScale: 2) against the same DB. FOR UPDATE SKIP LOCKED means each
    // instance claims a disjoint set of PENDING rows instead of double-
    // processing the same one; the UPDATE commits immediately (no explicit
    // BEGIN held open), so no lock is held while the slow external calls
    // below run.
    const claimed = await pool.query(
      `UPDATE outbox_event SET status = 'PROCESSING'
       WHERE id IN (
         SELECT id FROM outbox_event WHERE status = 'PENDING' ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );

    for (const event of claimed.rows) {
      try {
        if (event.target === "commercial-to-search-sub") {
          await publishSearchSync(pubsub, config, event);
        } else if (event.target === "apigee-provisioning") {
          await provisionApigee(pool, config, event);
        }
        await pool.query(`UPDATE outbox_event SET status = 'SENT', sent_at = now() WHERE id = $1`, [event.id]);
      } catch (err) {
        console.error(`[outbox] delivery failed for event ${event.id} (target=${event.target}):`, err);
        const attempts = event.attempts + 1;
        if (attempts >= config.outboxMaxAttempts) {
          await pool.query(`UPDATE outbox_event SET status = 'FAILED', attempts = $2 WHERE id = $1`, [event.id, attempts]);
          if (event.target === "apigee-provisioning") {
            await pool.query(`UPDATE subscription SET status = 'FAILED' WHERE id = $1`, [event.aggregate_id]);
          }
        } else {
          await pool.query(`UPDATE outbox_event SET status = 'PENDING', attempts = $2 WHERE id = $1`, [event.id, attempts]);
        }
      }
    }
  }, config.outboxPollIntervalMs);
}

async function publishSearchSync(pubsub: PubSub | undefined, config: Config, event: pg.QueryResultRow): Promise<void> {
  if (!pubsub || !config.pubsubSearchSyncTopic) {
    throw new Error("PUBSUB_SEARCH_SYNC_TOPIC is not configured");
  }
  await pubsub.topic(config.pubsubSearchSyncTopic).publishMessage({
    json: {
      event_type: event.event_type,
      aggregate_type: event.aggregate_type,
      aggregate_id: event.aggregate_id,
      payload: event.payload,
    },
  });
}

// Idempotent: safe to re-run after a partial failure. Re-fetches current DB
// state by subscription id rather than trusting the payload snapshot, since
// the tier/app details could have changed since the event was enqueued and
// the subscriber_app row is required either way. createApigeeProduct is
// idempotent on api-governance-svc's side (reuses the existing product for
// this tier), so re-calling it on retry is safe without commercial-catalog-svc
// needing its own record of the apigee_product id (that table lives in
// api-governance-svc's database, not this service's).
async function provisionApigee(pool: pg.Pool, config: Config, event: pg.QueryResultRow): Promise<void> {
  const subscriptionId = event.aggregate_id;
  const sub = (await pool.query(`SELECT * FROM subscription WHERE id = $1`, [subscriptionId])).rows[0];
  if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
  if (sub.status === "ACTIVE") return; // already fully provisioned — nothing to do

  const subscriberApp = (await pool.query(`SELECT * FROM subscriber_app WHERE app_id = $1`, [sub.app_id])).rows[0];
  if (!subscriberApp) throw new Error(`subscriber_app "${sub.app_id}" not found`);

  const offer = (await pool.query(`SELECT * FROM offer_version WHERE id = $1`, [sub.offer_version_id])).rows[0];
  if (!offer) throw new Error(`offer_version ${sub.offer_version_id} not found`);
  const apiIds = (await pool.query<{ api_id: string }>(`SELECT api_id FROM bundle_asset WHERE bundle_id = $1`, [sub.bundle_id])).rows.map((r) => r.api_id);

  const productResp = await createApigeeProduct(config, {
    bundle_id: sub.bundle_id,
    offer_version_id: offer.id,
    tier_name: offer.tier_name,
    quota_limit: offer.quota_limit,
    quota_interval: offer.quota_interval,
    api_ids: apiIds,
  });
  if (sub.status === "PENDING") {
    await pool.query(`UPDATE subscription SET status = 'PRODUCT_CREATED' WHERE id = $1`, [subscriptionId]);
  }

  await attachAppToProduct(config, productResp.apigee_product.id, subscriberApp.apigee_developer_email, subscriberApp.apigee_app_name);
  const activated = await pool.query(`UPDATE subscription SET status = 'ACTIVE' WHERE id = $1 RETURNING *`, [subscriptionId]);

  // Search-sync only fires once the subscription is genuinely usable —
  // enqueued here rather than at subscribe time, so a downstream index never
  // sees a subscription that later failed to provision.
  await pool.query(
    `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, target)
     VALUES ('subscription', $1, 'SubscriptionActivated', $2, 'commercial-to-search-sub')`,
    [String(subscriptionId), JSON.stringify(activated.rows[0])]
  );
}
