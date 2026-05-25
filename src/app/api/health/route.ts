import { jsonOk, methodNotAllowed } from "@/lib/api";

export const runtime = "nodejs";
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function GET() {
  return jsonOk({
    ok: true
  });
}
