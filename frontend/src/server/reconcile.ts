import { db } from "~/server/db";
import { checkModalStatus } from "~/server/modal";
import { SongStatus, transitionSong } from "~/server/song-status";
import { sendGenerateEvents } from "~/server/song-queue";

const MINUTE = 60 * 1000;

// A queued song this old may never have started an Inngest run
const ORPHAN_AFTER_MS = 10 * MINUTE;
// Give up on songs that never started
const NEVER_STARTED_AFTER_MS = 2 * 60 * MINUTE;
// The Inngest run polls Modal for ~20 min; after that the reconciler takes over
const STALE_PROCESSING_AFTER_MS = 25 * MINUTE;
// Processing without a call id: submit never completed
const NO_CALL_ID_AFTER_MS = 30 * MINUTE;
// Still pending on Modal after this long: treat as lost
const PROCESSING_TIMEOUT_MS = 60 * MINUTE;

const SWEEP_LIMIT = 100;

const ago = (ms: number) => new Date(Date.now() - ms);

// Songs that started processing before processingStartedAt existed fall back
// to updatedAt, which set-status-processing also bumped
const processingStartedBefore = (date: Date) => ({
  OR: [
    { processingStartedAt: { lt: date } },
    { processingStartedAt: null, updatedAt: { lt: date } },
  ],
});

/**
 * Re-send events for queued songs that never got an Inngest run.
 *
 * generateSong allows one run per song id, so a song that is only waiting
 * behind the per-user concurrency limit is not run twice, while a song whose
 * event never started a run gets one. Songs queued for too long are failed
 * instead of being retried forever.
 */
async function sweepOrphans() {
  const neverStarted = await db.song.findMany({
    where: {
      status: SongStatus.queued,
      modalCallId: null,
      createdAt: { lt: ago(NEVER_STARTED_AFTER_MS) },
    },
    select: { id: true },
    take: SWEEP_LIMIT,
  });

  let failed = 0;
  for (const song of neverStarted) {
    if (
      await transitionSong(song.id, [SongStatus.queued], SongStatus.failed, {
        lastError: "Never started",
      })
    ) {
      failed++;
    }
  }

  const orphans = await db.song.findMany({
    where: {
      status: SongStatus.queued,
      modalCallId: null,
      createdAt: { lt: ago(ORPHAN_AFTER_MS), gte: ago(NEVER_STARTED_AFTER_MS) },
    },
    select: { id: true, userId: true },
    take: SWEEP_LIMIT,
  });

  await sendGenerateEvents(orphans);

  return { resent: orphans.length, failed };
}

/**
 * Settle songs whose Inngest run should have finished by now, using Modal's
 * actual job state rather than the song's age.
 */
async function sweepStaleProcessing() {
  const songs = await db.song.findMany({
    where: {
      status: SongStatus.processing,
      modalCallId: { not: null },
      ...processingStartedBefore(ago(STALE_PROCESSING_AFTER_MS)),
    },
    select: {
      id: true,
      modalCallId: true,
      processingStartedAt: true,
      updatedAt: true,
    },
    take: SWEEP_LIMIT,
  });

  let processed = 0;
  let failed = 0;

  for (const song of songs) {
    let result;
    try {
      result = await checkModalStatus(song.modalCallId!);
    } catch (error) {
      console.error(`Could not check Modal status for song ${song.id}`, error);
      continue;
    }
    const startedAt = song.processingStartedAt ?? song.updatedAt;

    if (result.status === "done") {
      if (
        await transitionSong(
          song.id,
          [SongStatus.processing],
          SongStatus.processed,
          {
            s3Key: result.s3_key,
            thumbnailS3Key: result.cover_image_s3_key,
            lastError: null,
          },
        )
      ) {
        processed++;
      }
    } else if (
      result.status === "failed" ||
      startedAt < ago(PROCESSING_TIMEOUT_MS)
    ) {
      if (
        await transitionSong(
          song.id,
          [SongStatus.processing],
          SongStatus.failed,
          {
            lastError:
              result.status === "failed"
                ? (result.error ?? "Generation failed").slice(0, 1000)
                : "Timed out",
          },
        )
      ) {
        failed++;
      }
    }
  }

  return { checked: songs.length, processed, failed };
}

/** Fail songs that started processing but never got a Modal call id. */
async function sweepNeverSubmitted() {
  const { count } = await db.song.updateMany({
    where: {
      status: SongStatus.processing,
      modalCallId: null,
      ...processingStartedBefore(ago(NO_CALL_ID_AFTER_MS)),
    },
    data: { status: SongStatus.failed, lastError: "Submit never completed" },
  });
  return { failed: count };
}

const SWEEPS = {
  orphans: sweepOrphans,
  staleProcessing: sweepStaleProcessing,
  neverSubmitted: sweepNeverSubmitted,
};

/**
 * Recover or settle songs the normal Inngest flow lost track of.
 *
 * Runs from an Inngest cron and from /api/cron/reconcile, so it still works
 * when Inngest itself is the thing that is broken. Each sweep is isolated:
 * one failing (e.g. Modal unreachable) does not stop the others.
 */
export async function reconcileSongs() {
  const results: Record<string, unknown> = {};

  for (const [name, sweep] of Object.entries(SWEEPS)) {
    try {
      results[name] = await sweep();
    } catch (error) {
      console.error(`Reconcile sweep "${name}" failed`, error);
      results[name] = { error: String(error) };
    }
  }

  return results;
}
