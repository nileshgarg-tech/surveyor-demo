import { AppError } from "@/lib/errors";
import { type ParticipantCount, participantCountSchema } from "@/lib/domain/schemas";

export type CostPreflight = {
  authoritativeTotalCents: number;
  currencyCode: string;
  availableBalanceCents: number;
  checkedAt: string;
};

export function rewardCents(estimatedMinutes: number, hourlyPayCents = 1_200): number {
  assertPositiveInteger(estimatedMinutes, "estimatedMinutes");
  assertPositiveInteger(hourlyPayCents, "hourlyPayCents");
  return Math.ceil((estimatedMinutes * hourlyPayCents) / 60);
}

export function roughPreviewCents(
  participants: ParticipantCount,
  perParticipantRewardCents: number,
): number {
  participantCountSchema.parse(participants);
  assertPositiveInteger(perParticipantRewardCents, "perParticipantRewardCents");
  return Math.ceil((participants * perParticipantRewardCents * 1_333) / 1_000);
}

export function maximumAllowedTimeMinutes(estimatedMinutes: number): number {
  assertPositiveInteger(estimatedMinutes, "estimatedMinutes");
  return Math.ceil(2 + 2 * estimatedMinutes + 2 * Math.sqrt(estimatedMinutes));
}

export function parseProviderCents(value: unknown, field = "amount"): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new AppError("SCHEMA_DRIFT", `Provider returned an invalid ${field}.`, {
    status: 502,
  });
}

export function assertLaunchCost(
  preflight: CostPreflight,
  options: {
    expectedCurrency: string;
    maxStudyCents: number;
    currentReservedCents: number;
    lifetimeCommittedCents: number;
    maxEventCents: number;
  },
): void {
  const values = [
    preflight.authoritativeTotalCents,
    preflight.availableBalanceCents,
    options.maxStudyCents,
    options.currentReservedCents,
    options.lifetimeCommittedCents,
    options.maxEventCents,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new AppError("SCHEMA_DRIFT", "A monetary value was invalid.", { status: 502 });
  }
  if (preflight.currencyCode !== options.expectedCurrency) {
    throw new AppError(
      "SETUP_REQUIRED",
      `Prolific workspace currency must be ${options.expectedCurrency}.`,
      { status: 503 },
    );
  }
  if (preflight.authoritativeTotalCents > options.maxStudyCents) {
    throw new AppError("FORBIDDEN", "This participant option exceeds the $25 study cap.", {
      status: 422,
    });
  }
  if (
    options.currentReservedCents +
      options.lifetimeCommittedCents +
      preflight.authoritativeTotalCents >
    options.maxEventCents
  ) {
    throw new AppError("FORBIDDEN", "The event budget does not have enough remaining capacity.", {
      status: 422,
    });
  }
  if (preflight.availableBalanceCents < preflight.authoritativeTotalCents) {
    throw new AppError("FORBIDDEN", "The Prolific workspace balance is too low for this study.", {
      status: 422,
    });
  }
}

export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("BAD_REQUEST", `${field} must be a positive integer.`, { status: 400 });
  }
}
