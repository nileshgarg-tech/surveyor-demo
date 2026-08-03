import { z } from "zod";
import { AppError } from "@/lib/errors";
import { intakeStateSchema, type IntakeMessage, type IntakeModelResult } from "@/lib/domain/schemas";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import {
  INTAKE_COOKIE,
  readEventAuthority,
  setIntakeCookie,
  verifyIntakeCookie,
} from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { generateIntakeResponse } from "@/lib/services/ai";
import { databaseError, getPublicStudy } from "@/lib/data";
import { getServiceSupabase } from "@/lib/supabase/server";

export const maxDuration = 60;

const messageBodySchema = z
  .object({
    message: z.string().trim().min(2).max(2_000),
    requestId: z.uuid(),
  })
  .strict();
const bodySchema = z.union([
  messageBodySchema,
  z.object({ action: z.literal("restart"), requestId: z.uuid() }).strict(),
  z.object({ action: z.literal("restore"), requestId: z.uuid() }).strict(),
]);

type IntakeRow = {
  id: string;
  event_session_id: string | null;
  messages: IntakeMessage[];
  user_message_count: number;
  previous_interaction_id: string | null;
  status: "open" | "processing" | "ready" | "insufficient" | "consumed";
  ready_payload: IntakeModelResult | null;
  last_request_id: string | null;
  expires_at: string;
  version: number;
  failure_code: string | null;
  updated_at: string;
};

export async function POST(request: import("next/server").NextRequest) {
  let claimed: IntakeRow | undefined;
  try {
    const eventAuthority = await readEventAuthority(request);
    await guardBrowserMutation(request, "intake", eventAuthority?.sessionId);
    const body = bodySchema.parse(await parseJsonBody(request));
    if ("action" in body && body.action === "restart") {
      const response = jsonNoStore({ restarted: true });
      response.cookies.set(INTAKE_COOKIE, "", {
        httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
      });
      return response;
    }
    if ("action" in body) {
      const cookieValue = request.cookies.get(INTAKE_COOKIE)?.value;
      const intakeId = cookieValue ? safelyReadIntakeId(cookieValue) : null;
      if (!intakeId) return jsonNoStore({ state: null, study: null });
      const { data, error } = await getServiceSupabase()
        .from("intake_sessions")
        .select("*")
        .eq("id", intakeId)
        .maybeSingle();
      if (error) throw databaseError("Intake could not be restored.", error);
      if (!data || Date.parse(String(data.expires_at)) <= Date.now()) {
        return jsonNoStore({ state: null, study: null });
      }
      const restored = data as IntakeRow;
      let status = restored.status;
      if (status === "processing" && Date.parse(restored.updated_at) < Date.now() - 2 * 60_000) {
        const { error: resetError } = await getServiceSupabase()
          .from("intake_sessions")
          .update({ status: "open", failure_code: "STALE_INTAKE_RECOVERED",
            failure_message: "An interrupted intake turn was recovered." })
          .eq("id", intakeId)
          .eq("status", "processing");
        if (resetError) throw databaseError("Interrupted intake could not be recovered.", resetError);
        status = "open";
      }
      const { data: studyRow, error: studyError } = await getServiceSupabase()
        .from("studies")
        .select("id")
        .eq("source_intake_id", intakeId)
        .maybeSingle();
      if (studyError) throw databaseError("Study preview could not be restored.", studyError);
      return jsonNoStore({
        state: { messages: restored.messages, userMessageCount: restored.user_message_count, status },
        study: studyRow ? await getPublicStudy(String(studyRow.id)) : null,
      });
    }
    const cookieValue = request.cookies.get(INTAKE_COOKIE)?.value;
    const existingId = cookieValue ? safelyReadIntakeId(cookieValue) : null;
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000);

    if (!existingId) {
      const messages: IntakeMessage[] = [{ role: "user", content: body.message }];
      const { data, error } = await getServiceSupabase()
        .from("intake_sessions")
        .insert({
          event_session_id: eventAuthority?.sessionId ?? null,
          messages,
          user_message_count: 1,
          status: "processing",
          last_request_id: body.requestId,
          expires_at: expiresAt.toISOString(),
          version: 1,
        })
        .select("*")
        .single();
      if (error || !data) throw databaseError("Intake could not be started.", error);
      claimed = data as IntakeRow;
    } else {
      const { data, error } = await getServiceSupabase()
        .from("intake_sessions")
        .select("*")
        .eq("id", existingId)
        .maybeSingle();
      if (error) throw databaseError("Intake could not be loaded.", error);
      if (!data || Date.parse(String(data.expires_at)) <= Date.now()) {
        throw new AppError("FORBIDDEN", "This intake expired. Please restart.", { status: 401 });
      }
      const row = data as IntakeRow;
      const duplicate = row.last_request_id === body.requestId;
      if (duplicate && row.status !== "processing" && !row.failure_code) {
        return jsonNoStore(reconstructResult(row));
      }
      if (row.status === "processing") {
        throw new AppError("CONFLICT", "That intake turn is still processing.", {
          status: 409,
          retryable: true,
        });
      }
      if (row.status !== "open") {
        throw new AppError("CONFLICT", "This intake is already complete.", { status: 409 });
      }

      const messages = duplicate
        ? row.messages
        : [...row.messages, { role: "user" as const, content: body.message }];
      const userCount = messages.filter((message) => message.role === "user").length;
      intakeStateSchema.parse({ messages });
      const { data: updated, error: updateError } = await getServiceSupabase()
        .from("intake_sessions")
        .update({
          messages,
          user_message_count: userCount,
          status: "processing",
          last_request_id: body.requestId,
          version: row.version + 1,
          failure_code: null,
          failure_message: null,
        })
        .eq("id", row.id)
        .eq("version", row.version)
        .eq("status", "open")
        .select("*")
        .maybeSingle();
      if (updateError) throw databaseError("Intake could not be updated.", updateError);
      if (!updated) {
        throw new AppError("CONFLICT", "Another intake turn is already running.", {
          status: 409,
          retryable: true,
        });
      }
      claimed = updated as IntakeRow;
    }

    const generated = await generateIntakeResponse({ messages: claimed.messages });
    const assistantContent =
      generated.result.kind === "clarify"
        ? generated.result.question
        : generated.result.kind === "insufficient"
          ? generated.result.explanation
          : "Your study brief and questions are ready.";
    const finalMessages = [
      ...claimed.messages,
      { role: "assistant" as const, content: assistantContent },
    ];
    const finalStatus =
      generated.result.kind === "ready"
        ? "ready"
        : generated.result.kind === "insufficient"
          ? "insufficient"
          : "open";
    const { error: persistError } = await getServiceSupabase()
      .from("intake_sessions")
      .update({
        messages: finalMessages,
        status: finalStatus,
        ready_payload: generated.result.kind === "ready" ? generated.result : null,
        previous_interaction_id: generated.interactionId ?? null,
        provider: generated.provider,
        model: generated.model,
        failure_code: null,
        failure_message: null,
        version: claimed.version + 1,
      })
      .eq("id", claimed.id)
      .eq("version", claimed.version)
      .eq("status", "processing");
    if (persistError) throw databaseError("Intake result could not be saved.", persistError);

    const response = jsonNoStore({ result: generated.result, userMessageCount: claimed.user_message_count });
    setIntakeCookie(response, claimed.id, expiresAt);
    return response;
  } catch (error) {
    if (claimed) {
      const appError = error instanceof AppError ? error : null;
      await getServiceSupabase()
        .from("intake_sessions")
        .update({
          status: "open",
          failure_code: appError?.code ?? "INTERNAL",
          failure_message: appError?.message ?? "Generation failed.",
          version: claimed.version + 1,
        })
        .eq("id", claimed.id)
        .eq("status", "processing");
    }
    return errorResponse(error);
  }
}

function safelyReadIntakeId(token: string): string | null {
  try {
    return verifyIntakeCookie(token).intakeId;
  } catch {
    return null;
  }
}

function reconstructResult(row: IntakeRow) {
  if (row.status === "ready" && row.ready_payload) {
    return { result: row.ready_payload, userMessageCount: row.user_message_count };
  }
  const lastAssistant = [...row.messages].reverse().find((message) => message.role === "assistant");
  if (row.status === "insufficient") {
    return {
      result: { kind: "insufficient", explanation: lastAssistant?.content ?? "Please restart." },
      userMessageCount: row.user_message_count,
    };
  }
  return {
    result: {
      kind: "clarify",
      question: lastAssistant?.content ?? "What detail should this survey focus on?",
      missing: "additional detail",
    },
    userMessageCount: row.user_message_count,
  };
}
