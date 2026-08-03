import { AppError } from "@/lib/errors";
import { assertLaunchCost } from "@/lib/domain/money";
import { surveySpecSchema, targetingPlanSchema } from "@/lib/domain/schemas";
import { databaseError, getInternalStudy, getPublicStudy } from "@/lib/data";
import { getEnv, requireLiveConfig } from "@/lib/env";
import {
  classifyProlificStudyStatus,
  createProlificClient,
  sanitizeProlificMetadata,
  type ProlificCreateStudyPayload,
} from "@/lib/providers/prolific";
import { ProviderError } from "@/lib/providers/http";
import { ensureEventControlConfigured } from "@/lib/services/control";
import { reconcileStaleLaunches } from "@/lib/services/recovery";
import {
  asRecord,
  claimProviderOperation,
  evidenceRequestId,
  markProviderDispatched,
  recordProviderResult,
  requestFingerprint,
  safeError,
} from "@/lib/services/provider-events";
import { getServiceSupabase } from "@/lib/supabase/server";

export async function launchStudy(options: {
  studyId: string;
  eventSessionId: string;
  requestId: string;
}) {
  requireLiveConfig([
    "PROLIFIC_API_TOKEN",
    "PROLIFIC_WORKSPACE_ID",
    "PROLIFIC_PROJECT_ID",
    "RESEARCH_CONTACT_EMAIL",
  ]);
  await ensureEventControlConfigured();
  await reconcileStaleLaunches();
  let study = await getInternalStudy(options.studyId);
  if (study.event_session_id !== options.eventSessionId) {
    throw new AppError("FORBIDDEN", "This event session does not control that study.", { status: 403 });
  }
  if (["collecting", "ready_to_report", "reporting", "complete"].includes(String(study.status))) {
    return getPublicStudy(options.studyId);
  }
  if (study.status === "reconciling") {
    throw new AppError("CONFLICT", "This launch is being reconciled before it can continue.", {
      status: 409,
      retryable: true,
    });
  }

  const client = createProlificClient();
  if (study.budget_state === "none") {
    const preflight = await persistAuthoritativePreflight(study, options.requestId);
    study = await getInternalStudy(options.studyId);
    const survey = surveySpecSchema.parse(study.survey_spec);
    const targeting = targetingPlanSchema.parse(study.targeting_plan);
    const payload = client.buildStudyPayload({
      localStudyId: options.studyId,
      name: String(study.brief_title),
      description: `${String(study.research_goal)}\n\n${survey.intro}`.slice(0, 10_000),
      totalAvailablePlaces: parseCount(study.participant_count),
      estimatedMinutes: survey.estimatedMinutes,
      rewardCents: Number(study.reward_cents),
      completionCode: String(study.prolific_completion_code),
      filters: targeting.filters,
    });
    const reservation = await reserveLaunch({
      study,
      eventSessionId: options.eventSessionId,
      costEventId: preflight.costEventId,
      balanceEventId: preflight.balanceEventId,
      payload,
    });
    if (reservation.applied) {
      await createDraft(options.studyId, reservation.eventId, payload);
    } else {
      throw new AppError("CONFLICT", "This launch is already in progress.", {
        status: 409,
        retryable: true,
      });
    }
  }

  study = await getInternalStudy(options.studyId);
  if (!study.prolific_study_id) {
    throw new AppError("CONFLICT", "The draft is still being created or reconciled.", {
      status: 409,
      retryable: true,
    });
  }
  if (study.prolific_status !== "UNPUBLISHED") {
    return getPublicStudy(options.studyId);
  }
  if (study.prolific_is_ready_to_publish !== true) {
    await deleteInvalidDraft(options.studyId, String(study.prolific_study_id));
    throw new AppError("PROVIDER_REJECTED", "Prolific found an issue in the draft, so it was safely removed.", {
      status: 422,
    });
  }
  await publishDraft(options.studyId, options.eventSessionId, String(study.prolific_study_id));
  return getPublicStudy(options.studyId);
}

async function persistAuthoritativePreflight(study: Record<string, unknown>, requestId: string) {
  const env = getEnv();
  const client = createProlificClient();
  const launchInput = {
    studyId: String(study.id),
    participantCount: Number(study.participant_count),
    estimatedMinutes: Number(study.estimated_minutes),
    rewardCents: Number(study.reward_cents),
    survey: study.survey_spec,
    targeting: study.targeting_plan,
  };
  const fingerprint = requestFingerprint(launchInput);
  const costOperation = await claimProviderOperation({
    provider: "prolific",
    operation: "calculate_study_cost",
    localOperationKey: `cost:${study.id}:${requestId}`,
    studyId: String(study.id),
    requestFingerprint: fingerprint,
    sanitizedRequest: {
      reward: Number(study.reward_cents),
      total_available_places: Number(study.participant_count),
    },
  });
  const balanceOperation = await claimProviderOperation({
    provider: "prolific",
    operation: "workspace_balance",
    localOperationKey: `balance:${study.id}:${requestId}`,
    studyId: String(study.id),
    requestFingerprint: fingerprint,
    sanitizedRequest: { expectedCurrency: env.EXPECTED_PROLIFIC_CURRENCY },
  });
  const projectOperation = await claimProviderOperation({
    provider: "prolific",
    operation: "project_check",
    localOperationKey: `project:${study.id}:${requestId}`,
    studyId: String(study.id),
    requestFingerprint: fingerprint,
  });
  await Promise.all([
    markProviderDispatched(costOperation.eventId),
    markProviderDispatched(balanceOperation.eventId),
    markProviderDispatched(projectOperation.eventId),
  ]);

  try {
    const [cost, balance, project] = await Promise.all([
      client.calculateStudyCost(Number(study.reward_cents), parseCount(study.participant_count)),
      client.getWorkspaceBalance(),
      client.getProject(),
    ]);
    await Promise.all([
      recordProviderResult({
        eventId: costOperation.eventId,
        status: "succeeded",
        effect: "unknown",
        response: { total_cost: cost.data },
        requestId: evidenceRequestId(cost.evidence),
        observedAmountCents: cost.data,
        observedCurrencyCode: balance.data.currencyCode,
      }),
      recordProviderResult({
        eventId: balanceOperation.eventId,
        status: "succeeded",
        effect: "unknown",
        response: balance.data,
        requestId: evidenceRequestId(balance.evidence),
        observedAmountCents: balance.data.availableBalanceCents,
        observedCurrencyCode: balance.data.currencyCode,
      }),
      recordProviderResult({
        eventId: projectOperation.eventId,
        status: "succeeded",
        effect: "unknown",
        response: project.data,
        requestId: evidenceRequestId(project.evidence),
      }),
    ]);
    if (project.data.workspaceId !== env.PROLIFIC_WORKSPACE_ID) {
      throw new AppError("SETUP_REQUIRED", "The configured Prolific project does not belong to the workspace.", {
        status: 503,
      });
    }
    const { data: control, error: controlError } = await getServiceSupabase()
      .from("event_control")
      .select("reserved_budget_cents,lifetime_committed_budget_cents,max_study_budget_cents,max_event_budget_cents")
      .eq("singleton", true)
      .single();
    if (controlError || !control) throw databaseError("Budget control could not be loaded.", controlError);
    assertLaunchCost(
      {
        authoritativeTotalCents: cost.data,
        currencyCode: balance.data.currencyCode,
        availableBalanceCents: balance.data.availableBalanceCents,
        checkedAt: new Date().toISOString(),
      },
      {
        expectedCurrency: env.EXPECTED_PROLIFIC_CURRENCY,
        maxStudyCents: Number(control.max_study_budget_cents),
        currentReservedCents: Number(control.reserved_budget_cents),
        lifetimeCommittedCents: Number(control.lifetime_committed_budget_cents),
        maxEventCents: Number(control.max_event_budget_cents),
      },
    );
    const checkedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await getServiceSupabase()
      .from("studies")
      .update({
        authoritative_total_cents: cost.data,
        currency_code: balance.data.currencyCode,
        authoritative_cost_checked_at: checkedAt,
        workspace_available_balance_cents: balance.data.availableBalanceCents,
        workspace_balance_checked_at: checkedAt,
        launch_input_fingerprint: fingerprint,
      })
      .eq("id", study.id)
      .eq("status", "draft")
      .eq("budget_state", "none")
      .select("id")
      .maybeSingle();
    if (updateError) throw databaseError("Authoritative launch cost could not be saved.", updateError);
    if (!updated) throw new AppError("CONFLICT", "Study launch already started.", { status: 409 });
    return { costEventId: costOperation.eventId, balanceEventId: balanceOperation.eventId };
  } catch (error) {
    await recordNonPaidFailure([costOperation.eventId, balanceOperation.eventId, projectOperation.eventId], error);
    throw error;
  }
}

async function reserveLaunch(options: {
  study: Record<string, unknown>;
  eventSessionId: string;
  costEventId: string;
  balanceEventId: string;
  payload: ProlificCreateStudyPayload;
}) {
  const createFingerprint = requestFingerprint(options.payload);
  const { data, error } = await getServiceSupabase().rpc("reserve_study_launch", {
    p_study_id: String(options.study.id),
    p_event_session_id: options.eventSessionId,
    p_expected_version: Number(options.study.version),
    p_cost_event_id: options.costEventId,
    p_balance_event_id: options.balanceEventId,
    p_create_request_fingerprint: createFingerprint,
    p_sanitized_create_request: sanitizeProlificMetadata(options.payload),
  });
  if (error) throw databaseError("Launch could not reserve the authorized budget and slot.", error);
  const row = asRecord(data);
  return { applied: row.applied === true, eventId: String(row.providerEventId) };
}

async function createDraft(studyId: string, eventId: string, payload: ProlificCreateStudyPayload) {
  try {
    await markProviderDispatched(eventId);
  } catch (error) {
    await recordProviderResult({
      eventId,
      status: "definitive_failure",
      effect: "request_not_dispatched",
      errorCode: "DISPATCH_EVIDENCE_FAILED",
      errorMessage: "Provider request was not sent.",
    });
    await abandonStudy(studyId, eventId, "create", error);
    throw error;
  }
  try {
    const result = await createProlificClient().createStudy({
      localStudyId: studyId,
      name: payload.name,
      description: payload.description,
      totalAvailablePlaces: payload.total_available_places,
      estimatedMinutes: payload.estimated_completion_time,
      rewardCents: payload.reward,
      completionCode: payload.completion_codes[0]!.code,
      filters: fromPayloadFilters(payload),
    });
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect: "draft_exists",
      response: result.data,
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: result.data.id,
      externalStatus: result.data.status,
    });
    const { error } = await getServiceSupabase().rpc("persist_prolific_draft", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
      p_prolific_study_id: result.data.id,
      p_is_ready_to_publish: result.data.is_ready_to_publish,
      p_sanitized_payload: sanitizeProlificMetadata(payload),
      p_provider_request_id: evidenceRequestId(result.evidence) ?? null,
    });
    if (error) throw databaseError("Created draft evidence could not be saved.", error);
  } catch (error) {
    await handlePaidMutationFailure(studyId, eventId, "create", error, true);
    throw error;
  }
}

async function publishDraft(studyId: string, eventSessionId: string, prolificStudyId: string) {
  const fingerprint = requestFingerprint({ studyId: prolificStudyId, action: "PUBLISH" });
  const { data, error } = await getServiceSupabase().rpc("claim_publish_study", {
    p_study_id: studyId,
    p_event_session_id: eventSessionId,
    p_request_fingerprint: fingerprint,
    p_sanitized_request: { action: "PUBLISH" },
  });
  if (error) throw databaseError("Publish operation could not be claimed.", error);
  const claim = asRecord(data);
  if (claim.applied !== true) {
    throw new AppError("CONFLICT", "Publish is already in progress or awaiting reconciliation.", {
      status: 409,
      retryable: true,
    });
  }
  const eventId = String(claim.eventId);
  let resultRecorded = false;
  try {
    await markProviderDispatched(eventId);
    const result = await createProlificClient().publishStudy(prolificStudyId);
    const disposition = classifyProlificStudyStatus(result.data.status);
    if (disposition === "unpublished_draft") {
      await recordProviderResult({
        eventId,
        status: "definitive_failure",
        effect: "draft_exists",
        response: result.data,
        requestId: evidenceRequestId(result.evidence),
        externalResourceId: prolificStudyId,
        externalStatus: "UNPUBLISHED",
        errorCode: "PUBLISH_NOT_APPLIED",
        errorMessage: "Prolific kept the study unpublished.",
      });
      resultRecorded = true;
      throw new AppError("PROVIDER_REJECTED", "Prolific kept the draft unpublished. It can be retried safely.", {
        status: 422,
        retryable: true,
      });
    }
    if (disposition === "blocked_unknown") {
      throw new AppError("PROVIDER_AMBIGUOUS", "Prolific returned an unresolved publish status.", {
        status: 503,
        retryable: true,
      });
    }
    const effect = disposition === "paid_or_publishing" ? "published_or_spend_possible" : "non_recruiting";
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect,
      response: result.data,
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: result.data.status,
    });
    resultRecorded = true;
    const { error: commitError } = await getServiceSupabase().rpc("commit_study_budget", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
    });
    if (commitError) throw databaseError("Published study budget could not be committed.", commitError);
    if (effect === "non_recruiting") {
      const { error: releaseError } = await getServiceSupabase().rpc("release_study_slot", {
        p_study_id: studyId,
        p_provider_event_id: eventId,
        p_reason: "provider_non_recruiting",
      });
      if (releaseError) throw databaseError("Recruiting slot could not be released.", releaseError);
    }
  } catch (error) {
    if (!resultRecorded) await handlePaidMutationFailure(studyId, eventId, "publish", error, false);
    throw error;
  }
}

async function deleteInvalidDraft(studyId: string, prolificStudyId: string) {
  const operation = await claimProviderOperation({
    provider: "prolific",
    operation: "delete_draft",
    localOperationKey: `delete:${studyId}`,
    studyId,
    requestFingerprint: requestFingerprint({ prolificStudyId, action: "DELETE" }),
    sanitizedRequest: { reason: "not_ready_to_publish" },
  });
  if (!operation.applied && operation.status === "succeeded") return;
  await markProviderDispatched(operation.eventId);
  try {
    const result = await createProlificClient().deleteUnpublishedStudy(prolificStudyId);
    await recordProviderResult({
      eventId: operation.eventId,
      status: "succeeded",
      effect: "external_deleted",
      response: { deleted: true },
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: "UNPUBLISHED",
    });
    await abandonStudy(studyId, operation.eventId, "draft_validation", new Error("Draft was not ready"));
  } catch (error) {
    await handlePaidMutationFailure(studyId, operation.eventId, "delete", error, false);
    throw error;
  }
}

async function handlePaidMutationFailure(
  studyId: string,
  eventId: string,
  stage: string,
  error: unknown,
  abandonOnDefinitive: boolean,
) {
  const appError = error instanceof AppError ? error : null;
  if (appError?.code === "PROVIDER_AMBIGUOUS") {
    await recordProviderResult({
      eventId,
      status: "ambiguous",
      effect: "unknown",
      errorCode: appError.code,
      errorMessage: safeError(appError.message),
    });
    const result = await getServiceSupabase().rpc("mark_launch_ambiguous", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
      p_failure_stage: stage,
      p_error_code: appError.code,
      p_error_message: safeError(appError.message),
    });
    if (result.error) throw databaseError("Ambiguous launch evidence could not be saved.", result.error);
    return;
  }
  if (error instanceof ProviderError || appError?.code === "PROVIDER_REJECTED") {
    await recordProviderResult({
      eventId,
      status: "definitive_failure",
      effect: abandonOnDefinitive ? "definitive_no_create" : "draft_exists",
      errorCode: appError?.code ?? "PROVIDER_REJECTED",
      errorMessage: safeError(appError?.message ?? "Provider rejected the request."),
    });
    if (abandonOnDefinitive) await abandonStudy(studyId, eventId, stage, error);
  }
}

async function abandonStudy(studyId: string, eventId: string, stage: string, error: unknown) {
  const appError = error instanceof AppError ? error : null;
  const { error: abandonError } = await getServiceSupabase().rpc("abandon_unlaunched_study", {
    p_study_id: studyId,
    p_provider_event_id: eventId,
    p_failure_stage: stage,
    p_error_code: appError?.code ?? "PRE_PROVIDER_FAILURE",
    p_error_message: safeError(appError?.message ?? "Launch could not start."),
  });
  if (abandonError) throw databaseError("Unlaunched study could not be safely abandoned.", abandonError);
}

async function recordNonPaidFailure(eventIds: string[], error: unknown) {
  const appError = error instanceof AppError ? error : null;
  await Promise.allSettled(
    eventIds.map((eventId) =>
      recordProviderResult({
        eventId,
        status: "ambiguous",
        effect: "unknown",
        errorCode: appError?.code ?? "PREFLIGHT_FAILED",
        errorMessage: safeError(appError?.message ?? "Preflight failed."),
      }),
    ),
  );
}

function fromPayloadFilters(payload: ProlificCreateStudyPayload) {
  return payload.filters.map((filter) =>
    "selected_values" in filter
      ? { filterId: filter.filter_id, type: "select" as const, choiceIds: filter.selected_values }
      : {
          filterId: filter.filter_id,
          type: "range" as const,
          min: filter.selected_range.lower ?? Number.NEGATIVE_INFINITY,
          max: filter.selected_range.upper ?? Number.POSITIVE_INFINITY,
        },
  );
}

function parseCount(value: unknown): 5 | 10 | 20 {
  const count = Number(value);
  if (count === 5 || count === 10 || count === 20) return count;
  throw new AppError("SCHEMA_DRIFT", "Stored participant count is invalid.", { status: 500 });
}
