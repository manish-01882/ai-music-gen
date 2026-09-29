import { env } from "~/env";

const STATUS_TIMEOUT_MS = 15_000;

export const modalHeaders = {
  "Content-Type": "application/json",
  "Modal-Key": env.MODAL_KEY,
  "Modal-Secret": env.MODAL_SECRET,
};

export type ModalJobStatus = {
  status: "pending" | "done" | "failed";
  s3_key?: string;
  cover_image_s3_key?: string;
  error?: string;
};

export async function checkModalStatus(callId: string): Promise<ModalJobStatus> {
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

  return (await response.json()) as ModalJobStatus;
}
