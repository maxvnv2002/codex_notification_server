import { jsonError, jsonOk, methodNotAllowed } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { expirePairingCodes } from "@/lib/pairing";

export const runtime = "nodejs";
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization");

    if (authorization !== `Bearer ${getServerEnv().CRON_SECRET}`) {
      return jsonError("Unauthorized", 401);
    }

    const result = await expirePairingCodes();

    return jsonOk({
      ok: true,
      ...result
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Internal server error", 500);
  }
}
