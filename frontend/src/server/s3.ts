import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY_ID,
  },
});

/**
 * Sign a read URL for any object in the bucket.
 *
 * Server-only on purpose: it does no ownership check, so it must never be
 * exported from a "use server" file, where clients could call it with any key.
 * Callers check that the user owns the song first (see getPlayUrl).
 */
export async function getPresignedUrl(key: string) {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(s3Client, command, {
    expiresIn: 3600,
  });
}
