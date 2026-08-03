import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, asAppError } from "@/lib/errors";
import { noStoreHeaders } from "@/lib/security/request";

export function jsonNoStore<T>(body: T, init: ResponseInit = {}): NextResponse<T> {
  return NextResponse.json(body, { ...init, headers: noStoreHeaders(init.headers) });
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return jsonNoStore(
      { error: { code: "BAD_REQUEST", message: "The request was invalid.", retryable: false } },
      { status: 400 },
    );
  }
  const appError = error instanceof AppError ? error : asAppError(error);
  return jsonNoStore(
    {
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
      },
    },
    { status: appError.status },
  );
}
