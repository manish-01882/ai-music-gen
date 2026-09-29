"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "~/lib/auth";
import { db } from "~/server/db";
import { queueSongs, type GenerateRequest } from "~/server/song-queue";
import { getPresignedUrl } from "~/server/s3";

export type { GenerateRequest };

export async function generateSong(generateRequest: GenerateRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) redirect("/auth/sign-in");

  await queueSongs(generateRequest, [7.5, 15], session.user.id);

  revalidatePath("/create");
}

export async function getPlayUrl(songId: string) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) redirect("/auth/sign-in");

  const song = await db.song.findUniqueOrThrow({
    where: {
      id: songId,
      userId: session.user.id,
      s3Key: {
        not: null,
      },
    },
    select: {
      s3Key: true,
    },
  });

  return await getPresignedUrl(song.s3Key!);
}
