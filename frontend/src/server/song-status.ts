import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";

export const SongStatus = {
  queued: "queued",
  processing: "processing",
  processed: "processed",
  failed: "failed",
} as const;

export type SongStatus = (typeof SongStatus)[keyof typeof SongStatus];

/**
 * Move a song between statuses, only if it is currently in one of `from`.
 *
 * The WHERE clause is the guard: Postgres serialises concurrent UPDATEs to a
 * row, so when the Inngest run and the reconciler race on the same song only
 * one of them wins. Returns false when the song was not in an expected status.
 */
export async function transitionSong(
  id: string,
  from: SongStatus[],
  to: SongStatus,
  data: Omit<Prisma.SongUpdateManyMutationInput, "status"> = {},
): Promise<boolean> {
  const { count } = await db.song.updateMany({
    where: { id, status: { in: from } },
    data: { ...data, status: to },
  });
  return count === 1;
}
