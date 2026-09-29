import { NonRetriableError } from "inngest";
import { db } from "~/server/db";
import { inngest } from "./client";
import { env } from "~/env";
import { checkModalStatus, modalHeaders } from "~/server/modal";
import { SongStatus, transitionSong } from "~/server/song-status";
import { reconcileSongs } from "~/server/reconcile";

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL = "30s";
const MAX_POLLS = 40; // ~20 minutes

export const generateSong = inngest.createFunction(
  {
    id: "generate-song",
    retries: 2,
    // At most one run per song per 24h. Keyed on runs, not events, so the
    // reconciler can re-send events for stuck songs: a song that already has a
    // run (even one waiting on the concurrency limit) is ignored, while a song
    // whose event never started a run (e.g. sent before the app was synced)
    // gets one.
    idempotency: "event.data.songId",
    concurrency: {
      limit: 1,
      key: "event.data.userId",
    },
    onFailure: async ({ event, error }) => {
      // Guarded so a song that already finished is never overwritten
      await transitionSong(
        (event.data.event.data as { songId: string }).songId,
        [SongStatus.queued, SongStatus.processing],
        SongStatus.failed,
        { lastError: error.message.slice(0, 1000) },
      );
    },
  },
  { event: "generate-song-event" },
  async ({ event, step }) => {
    const { songId } = event.data as {
      songId: string;
      userId: string;
    };

    const { endpoint, body } = await step.run(
      "prepare-request",
      async () => {
        const song = await db.song.findUniqueOrThrow({
          where: {
            id: songId,
          },
          select: {
            prompt: true,
            lyrics: true,
            fullDescribedSong: true,
            describedLyrics: true,
            instrumental: true,
            guidanceScale: true,
            inferStep: true,
            audioDuration: true,
            seed: true,
          },
        });

        type RequestBody = {
          song_id: string;
          guidance_scale?: number;
          infer_step?: number;
          audio_duration?: number;
          seed?: number;
          full_described_song?: string;
          prompt?: string;
          lyrics?: string;
          described_lyrics?: string;
          instrumental?: boolean;
        };

        const commomParams = {
          // Idempotency key: the backend returns the existing job for a song
          // instead of starting a second one
          song_id: songId,
          guidance_scale: song.guidanceScale ?? undefined,
          infer_step: song.inferStep ?? undefined,
          audio_duration: song.audioDuration ?? undefined,
          seed: song.seed ?? undefined,
          instrumental: song.instrumental ?? undefined,
        };

        let endpoint: string;
        let body: RequestBody;

        // Description of a song
        if (song.fullDescribedSong) {
          endpoint = env.GENERATE_FROM_DESCRIPTION;
          body = {
            full_described_song: song.fullDescribedSong,
            ...commomParams,
          };
        }

        // Custom mode: Prompt + described lyrics
        else if (song.prompt && song.describedLyrics) {
          endpoint = env.GENERATE_FROM_DESCRIBED_LYRICS;
          body = {
            described_lyrics: song.describedLyrics,
            prompt: song.prompt,
            ...commomParams,
          };
        }

        // Custom mode: Prompt + lyrics. Lyrics may be empty for instrumentals;
        // the backend replaces them with "[instrumental]"
        else if (song.prompt) {
          endpoint = env.GENERATE_WITH_LYRICS;
          body = {
            lyrics: song.lyrics ?? "",
            prompt: song.prompt,
            ...commomParams,
          };
        } else {
          throw new NonRetriableError("Song has no prompt or description");
        }

        return {
          endpoint: endpoint,
          body: body,
        };
      },
    );

    // Set status to processing. Fails if the song already finished or was
    // marked failed (e.g. by the reconciler), in which case there is nothing to do.
    const started = await step.run("set-status-processing", async () => {
      return await transitionSong(
        songId,
        [SongStatus.queued, SongStatus.processing],
        SongStatus.processing,
        { processingStartedAt: new Date() },
      );
    });

    if (!started) return;

    // Queue the job on Modal. This returns right away with a call id.
    const callId = await step.run("submit-job", async () => {
      // A previous attempt may have submitted before failing to return
      const existing = await db.song.findUniqueOrThrow({
        where: { id: songId },
        select: { modalCallId: true },
      });
      if (existing.modalCallId) return existing.modalCallId;

      const response = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        headers: modalHeaders,
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to submit job: ${response.status} ${await response.text()}`,
        );
      }

      const { call_id } = (await response.json()) as { call_id: string };

      await db.song.update({
        where: { id: songId },
        data: { modalCallId: call_id },
      });

      return call_id;
    });

    // Poll Modal until the job finishes, fails or runs out of time
    for (let i = 0; i < MAX_POLLS; i++) {
      await step.sleep(`wait-${i}`, POLL_INTERVAL);

      const result = await step.run(`check-${i}`, () =>
        checkModalStatus(callId),
      );

      if (result.status === "failed") {
        throw new NonRetriableError(result.error ?? "Generation failed");
      }

      if (result.status === "done") {
        await step.run("update-song-result", async () => {
          await transitionSong(
            songId,
            [SongStatus.processing],
            SongStatus.processed,
            {
              s3Key: result.s3_key,
              thumbnailS3Key: result.cover_image_s3_key,
              lastError: null,
            },
          );
        });
        return;
      }
    }

    throw new NonRetriableError("Generation timed out");
  },
);

// Recovers or settles songs the flow above lost track of. The same sweep is
// also exposed at /api/cron/reconcile so it still runs if Inngest is down.
export const reconcileSongsCron = inngest.createFunction(
  { id: "reconcile-songs" },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    return await step.run("reconcile", () => reconcileSongs());
  },
);
