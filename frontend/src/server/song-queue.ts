import { inngest } from "~/inngest/client";
import { db } from "~/server/db";

export interface GenerateRequest {
  prompt?: string;
  lyrics?: string;
  fullDescribedSong?: string;
  describedLyrics?: string;
  instrumental?: boolean;
}

type QueuedSong = { id: string; userId: string };

/**
 * Send the generation event for each song.
 *
 * The event id is derived from the song id, so Inngest drops repeats of the
 * same song for 24h. That makes it safe for the reconciler to re-send events
 * for songs that look stuck: if Inngest already has the event, nothing happens.
 */
export async function sendGenerateEvents(songs: QueuedSong[]) {
  if (songs.length === 0) return;

  await inngest.send(
    songs.map((song) => ({
      id: `generate-${song.id}`,
      name: "generate-song-event",
      data: { songId: song.id, userId: song.userId },
    })),
  );
}

/**
 * Create one song row per guidance scale, then send their events.
 *
 * The rows are the source of truth. If the send fails, the songs stay "queued"
 * and the reconciler re-sends their events, so the caller is not told to retry
 * (which would create duplicate songs).
 */
export async function queueSongs(
  generateRequest: GenerateRequest,
  guidanceScales: number[],
  userId: string,
) {
  let title = "Untitled";
  if (generateRequest.describedLyrics) title = generateRequest.describedLyrics;
  if (generateRequest.fullDescribedSong)
    title = generateRequest.fullDescribedSong;

  title = title.charAt(0).toUpperCase() + title.slice(1);

  const songs = await db.$transaction(
    guidanceScales.map((guidanceScale) =>
      db.song.create({
        data: {
          userId: userId,
          title: title,
          prompt: generateRequest.prompt,
          lyrics: generateRequest.lyrics,
          describedLyrics: generateRequest.describedLyrics,
          fullDescribedSong: generateRequest.fullDescribedSong,
          instrumental: generateRequest.instrumental,
          guidanceScale: guidanceScale,
          audioDuration: 180,
        },
        select: { id: true, userId: true },
      }),
    ),
  );

  try {
    await sendGenerateEvents(songs);
  } catch (error) {
    console.error(
      "Failed to send generation events; the reconciler will retry",
      { songIds: songs.map((song) => song.id) },
      error,
    );
  }
}
