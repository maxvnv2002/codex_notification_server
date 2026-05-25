import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function jsonOk<T extends Record<string, unknown>>(body: T, status = 200) {
  return NextResponse.json(body, { status });
}

export function jsonError(error: string, status = 400, details?: unknown) {
  return NextResponse.json(
    details === undefined ? { ok: false, error } : { ok: false, error, details },
    { status }
  );
}

export function methodNotAllowed() {
  return jsonError("Method not allowed", 405);
}

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
