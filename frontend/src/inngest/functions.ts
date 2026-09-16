import { NonRetriableError } from "inngest";
import { db } from "~/server/db";
import { inngest } from "./client";
import { env } from "~/env";

const SUBMIT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const POLL_INTERVAL = "30s";
const MAX_POLLS = 40; // ~20 minutes
// Must be longer than queue wait + the polling window above
const STALE_AFTER_MS = 30 * 60 * 1000;

export const generateSong = inngest.createFunction(
  {
    id: "generate-song",
    retries: 2,
    concurrency: {
      limit: 1,
      key: "event.data.userId",
    },
    onFailure: async ({ event }) => {
      // updateMany so a song that already finished is never overwritten
      await db.song.updateMany({
        where: {
          id: (event?.data?.event?.data as { songId: string }).songId,
          status: { not: "processed" },
        },
        data: {
          status: "failed",
        },
      });
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

        let endpoint = "";
        let body: RequestBody = {};

        const commomParams = {
          guidance_scale: song.guidanceScale ?? undefined,
          infer_step: song.inferStep ?? undefined,
          audio_duration: song.audioDuration ?? undefined,
          seed: song.seed ?? undefined,
          instrumental: song.instrumental ?? undefined,
        };

        // Description of a song
        if (song.fullDescribedSong) {
          endpoint = env.GENERATE_FROM_DESCRIPTION;
          body = {
            full_described_song: song.fullDescribedSong,
            ...commomParams,
          };
        }

        // Custom mode: Lyrics + prompt
        else if (song.lyrics && song.prompt) {
          endpoint = env.GENERATE_WITH_LYRICS;
          body = {
            lyrics: song.lyrics,
            prompt: song.prompt,
            ...commomParams,
          };
        }

        // Custom mode: Prompt + described lyrics
        else if (song.describedLyrics && song.prompt) {
          endpoint = env.GENERATE_FROM_DESCRIBED_LYRICS;
          body = {
            described_lyrics: song.describedLyrics,
            prompt: song.prompt,
            ...commomParams,
          };
        }

        return {
          endpoint: endpoint,
          body: body,
        };
      },
    );

    // Set status to processing
    await step.run("set-status-processing", async () => {
      return await db.song.update({
        where: {
          id: songId,
        },
        data: {
          status: "processing",
        },
      });
    });

    const modalHeaders = {
      "Content-Type": "application/json",
      "Modal-Key": env.MODAL_KEY,
      "Modal-Secret": env.MODAL_SECRET,
    };

    // Queue the job on Modal. This returns right away with a call id.
    const callId = await step.run("submit-job", async () => {
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

      const result = await step.run(`check-${i}`, async () => {
        const url = new URL(env.GENERATION_STATUS_URL);
        url.searchParams.set("call_id", callId);

        const response = await fetch(url, {
          headers: modalHeaders,
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to check job status: ${response.status} ${await response.text()}`,
          );
        }

        return (await response.json()) as {
          status: "pending" | "done" | "failed";
          s3_key?: string;
          cover_image_s3_key?: string;
          error?: string;
        };
      });

      if (result.status === "failed") {
        throw new NonRetriableError(result.error ?? "Generation failed");
      }

      if (result.status === "done") {
        await step.run("update-song-result", async () => {
          await db.song.update({
            where: { id: songId },
            data: {
              s3Key: result.s3_key,
              thumbnailS3Key: result.cover_image_s3_key,
              status: "processed",
            },
          });
        });
        return;
      }
    }

    throw new NonRetriableError("Generation timed out");
  },
);

// Safety net for runs that vanished without reaching onFailure
// (e.g. the Inngest dev server was stopped mid-run)
export const cleanupStaleSongs = inngest.createFunction(
  { id: "cleanup-stale-songs" },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    return await step.run("mark-stale-songs-failed", async () => {
      const { count } = await db.song.updateMany({
        where: {
          status: { in: ["queued", "processing"] },
          updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
        },
        data: { status: "failed" },
      });
      return { markedFailed: count };
    });
  },
);
