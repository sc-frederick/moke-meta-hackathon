import {
  Context,
  Effect,
  Layer,
  PubSub,
  Queue,
  Schedule,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  CloudReviewUpdate,
  cloudReviewLocksWorkspace,
  latestCloudReviewStatus,
  type CloudReviewError,
  type CloudReviewStatus,
} from "#lib/review/cloud.ts";
import { CloudReviews } from "./service.ts";

/** Backend-owned cloud reconciliation continues without a renderer subscription. */
export class CloudReviewSynchronization extends Context.Service<
  CloudReviewSynchronization,
  {
    readonly observe: Stream.Stream<CloudReviewUpdate>;
    readonly retry: Effect.Effect<void, CloudReviewError>;
  }
>()("app/CloudReviewSynchronization") {
  /** The application supplies its serialized, recovery-aware package return operation. */
  static layer(returnResults: (id: string) => Effect.Effect<CloudReviewStatus, CloudReviewError>) {
    return Layer.effect(
      CloudReviewSynchronization,
      Effect.gen(function* () {
        const cloud = yield* CloudReviews;
        const initial = yield* cloud.status;

        const updates = yield* SubscriptionRef.make(
          new CloudReviewUpdate({ status: initial, error: initial?.syncFailure ?? null }),
        );

        const wakeups = yield* Queue.sliding<void>(1);
        const control = yield* Semaphore.make(1);
        let blocked: string | null = null;
        let returning: string | null = null;
        yield* Effect.addFinalizer(() => PubSub.shutdown(updates.pubsub));
        yield* Effect.addFinalizer(() => Queue.shutdown(wakeups));

        const publish = (status: CloudReviewStatus | null, error: CloudReviewError | null) =>
          SubscriptionRef.update(updates, (value) =>
            latestCloudReviewStatus(value.status, status) === status
              ? new CloudReviewUpdate({ status, error })
              : value,
          );

        const reconcile = Effect.gen(function* () {
          const recorded = yield* cloud.status;

          if (
            recorded === null ||
            !cloudReviewLocksWorkspace(recorded.phase) ||
            recorded.phase === "failed" ||
            recorded.syncFailure !== null ||
            blocked === recorded.id
          )
            return;

          yield* Effect.gen(function* () {
            const status = yield* cloud.refresh(recorded.id);

            if (status.phase === "ready" || status.phase === "importing") {
              returning = status.id;
              yield* returnResults(status.id).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    returning = null;
                  }),
                ),
              );
            }

            const current = yield* cloud.status;
            yield* publish(current, null);
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("cloud_sync_deferred", { reason: error.reason });
                const status = yield* cloud.status;
                const locked = status !== null && cloudReviewLocksWorkspace(status.phase);

                let reported = error;

                if (locked && error.reason !== "unavailable") {
                  blocked = recorded.id;
                  yield* cloud.pauseSynchronization(recorded.id, error).pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        reported = failure;
                      }),
                    ),
                  );
                }

                const current = yield* cloud.status;
                yield* publish(
                  current,
                  current?.id === recorded.id && cloudReviewLocksWorkspace(current.phase)
                    ? reported
                    : null,
                );
              }),
            ),
          );
        }).pipe(Semaphore.withPermit(control));

        yield* cloud.observe.pipe(
          Stream.runForEach((status) =>
            status?.id === returning && !cloudReviewLocksWorkspace(status.phase)
              ? Effect.void
              : SubscriptionRef.update(updates, (value) =>
                  latestCloudReviewStatus(value.status, status) !== status
                    ? value
                    : new CloudReviewUpdate({
                        status,
                        error:
                          value.status?.id === status?.id &&
                          value.status?.revision === status?.revision &&
                          status !== null &&
                          cloudReviewLocksWorkspace(status.phase)
                            ? (status.syncFailure ?? value.error)
                            : null,
                      }),
                ),
          ),
          Effect.forkScoped,
        );

        // One watcher per active owner. Changes are hints; initial reads and periodic reconciliation
        // also cover completed-offline jobs, missing notifications, and unsupported watch backends.
        yield* cloud.observe.pipe(
          Stream.map((status) =>
            status !== null &&
            cloudReviewLocksWorkspace(status.phase) &&
            status.phase !== "failed" &&
            status.syncFailure === null
              ? {
                  id: status.id,
                  watching: status.phase === "dispatching" || status.phase === "running",
                }
              : null,
          ),
          Stream.changesWith((a, b) => a?.id === b?.id && a?.watching === b?.watching),
          Stream.switchMap((owner) => {
            if (owner === null) return Stream.empty;
            const periodic = Stream.tick("10 seconds");

            const changes = !owner.watching
              ? periodic
              : Stream.merge(
                  cloud.watch(owner.id).pipe(
                    Stream.catch(() => Stream.empty),
                    Stream.repeat(Schedule.spaced("10 seconds")),
                  ),
                  periodic,
                );

            return Stream.concat(Stream.succeed(undefined), changes);
          }),
          Stream.runForEach(() => Queue.offer(wakeups, undefined)),
          Effect.forkScoped,
        );
        yield* Stream.fromQueue(wakeups).pipe(
          Stream.runForEach(() => reconcile),
          Effect.forkScoped,
        );

        return CloudReviewSynchronization.of({
          observe: SubscriptionRef.changes(updates),
          retry: Effect.gen(function* () {
            yield* cloud.retrySynchronization;
            blocked = null;
            const status = yield* cloud.status;
            yield* publish(status, null);
            yield* Queue.offer(wakeups, undefined);
          }).pipe(Semaphore.withPermit(control)),
        });
      }),
    );
  }
}
