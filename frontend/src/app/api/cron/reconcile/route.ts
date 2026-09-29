import { env } from "~/env";
import { reconcileSongs } from "~/server/reconcile";

// Called by an external scheduler (GitHub Actions, Vercel Cron, cron-job.org)
// so stuck songs are recovered even when Inngest is not running.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!env.CRON_SECRET) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json(await reconcileSongs());
}
