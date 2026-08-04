import { AppError } from "@/lib/errors";
import {
  type NormalizedCatalogFilter,
  type TargetingPlan,
  type ValidatedProlificFilter,
  normalizedCatalogFilterSchema,
  targetingPlanSchema,
  validatedProlificFilterSchema,
} from "@/lib/domain/schemas";

export type TargetingDraft = {
  requestedAudience: string;
  recruitedAudience: string;
  confidence: "high" | "medium" | "low";
  filters: ValidatedProlificFilter[];
  proxies: TargetingPlan["proxies"];
  unsupportedCriteria: string[];
};

export function normalizeCatalog(input: unknown[]): NormalizedCatalogFilter[] {
  return input.map((value) => normalizedCatalogFilterSchema.parse(value));
}

export function buildCatalogIndex(catalog: readonly NormalizedCatalogFilter[]) {
  return catalog.map((filter) => ({
    id: filter.id,
    title: filter.title,
    question: filter.question,
    category: filter.category,
    type: filter.type,
    min: filter.min,
    max: filter.max,
    choiceCount: filter.choices?.length ?? 0,
  }));
}

export function shortlistCatalog(
  requestedAudience: string,
  catalog: readonly NormalizedCatalogFilter[],
  limit = 20,
): NormalizedCatalogFilter[] {
  if (catalog.length <= limit) return [...catalog];

  const normalizedQuery = normalizePhrase(requestedAudience);
  const queryTerms = tokenize(requestedAudience);

  const scored = catalog.map((filter) => {
    const title = tokenize(filter.title);
    const details = tokenize(`${filter.question} ${filter.category}`);
    const choiceTerms = tokenize(filter.choices?.map((choice) => choice.label).join(" ") ?? "");
    let score = 0;

    for (const term of queryTerms) {
      if (term.length <= 1) continue;
      if (title.includes(term)) score += 10;
      if (details.includes(term)) score += 4;
      if (choiceTerms.includes(term)) score += 2;
    }

    const idLower = filter.id.toLowerCase();
    const titleLower = filter.title.toLowerCase();

    if (
      isCurrentCountryFilter(filter) &&
      (normalizedQuery.includes("united states") ||
        normalizedQuery.includes("resident") ||
        normalizedQuery.includes("live") ||
        normalizedQuery.includes("location") ||
        normalizedQuery.includes("country"))
    ) {
      score += 50;
    }
    if (
      (idLower === "age" || titleLower === "age") &&
      /\b(age|aged|years|adult|adults|gen|old)\b/i.test(requestedAudience)
    ) {
      score += 50;
    }
    if (
      (idLower === "sex" || idLower === "gender" || titleLower === "sex" || titleLower === "gender") &&
      /\b(female|male|women|men|woman|man|sex|gender|girl|boy)\b/i.test(requestedAudience)
    ) {
      score += 50;
    }
    if (
      (idLower === "student" || titleLower.includes("student")) &&
      /\b(student|college|university|school|enrolled|study|studying)\b/i.test(requestedAudience)
    ) {
      score += 50;
    }
    if (
      (idLower === "employment" || titleLower.includes("employment")) &&
      /\b(employment|work|job|employed|full-time|part-time|full time|part time)\b/i.test(requestedAudience)
    ) {
      score += 50;
    }
    if (
      (idLower === "language" || titleLower.includes("language")) &&
      /\b(language|english|spanish|fluent|native)\b/i.test(requestedAudience)
    ) {
      score += 50;
    }

    return { filter, score };
  });

  const matches = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.filter.title.localeCompare(right.filter.title))
    .map((entry) => entry.filter);

  if (matches.length === 0) {
    return catalog.slice(0, limit);
  }

  return matches.slice(0, limit);
}

export function validateSelectedFilters(
  filters: readonly ValidatedProlificFilter[],
  catalog: readonly NormalizedCatalogFilter[],
): ValidatedProlificFilter[] {
  const catalogById = new Map(catalog.map((filter) => [filter.id, filter]));
  const seen = new Set<string>();

  return filters.map((rawFilter) => {
    const selected = validatedProlificFilterSchema.parse(rawFilter);
    if (seen.has(selected.filterId)) {
      throw new AppError("BAD_REQUEST", "Only one condition is allowed for each Prolific filter.", {
        status: 422,
      });
    }
    seen.add(selected.filterId);
    const live = catalogById.get(selected.filterId);
    if (!live) {
      throw new AppError("SCHEMA_DRIFT", "Targeting referenced an unknown live Prolific filter.", {
        status: 422,
      });
    }
    if (selected.type !== live.type) {
      throw new AppError("SCHEMA_DRIFT", "Targeting used the wrong live Prolific filter type.", {
        status: 422,
      });
    }
    if (selected.type === "select") {
      const validChoices = new Set(live.choices?.map((choice) => choice.id) ?? []);
      if (new Set(selected.choiceIds).size !== selected.choiceIds.length) {
        throw new AppError("BAD_REQUEST", "Targeting choices must be unique.", { status: 422 });
      }
      if (selected.choiceIds.some((choice) => !validChoices.has(choice))) {
        throw new AppError("SCHEMA_DRIFT", "Targeting referenced an unknown Prolific choice.", {
          status: 422,
        });
      }
      return selected;
    }
    if (
      live.min === undefined ||
      live.max === undefined ||
      selected.min > selected.max ||
      selected.min < live.min ||
      selected.max > live.max
    ) {
      throw new AppError("SCHEMA_DRIFT", "Targeting range is outside the live Prolific bounds.", {
        status: 422,
      });
    }
    return selected;
  });
}

export function finalizeTargetingPlan(
  draft: TargetingDraft,
  catalog: readonly NormalizedCatalogFilter[],
  availability: { reportedCount: number; checkedAt: string },
  options: { unsupportedBooleanLogic?: boolean } = {},
): TargetingPlan {
  const filters = validateSelectedFilters(draft.filters, catalog);
  const unsupportedCriteria = [...draft.unsupportedCriteria];
  if (options.unsupportedBooleanLogic && !unsupportedCriteria.includes("requested boolean logic")) {
    unsupportedCriteria.push("requested boolean logic");
  }
  const status =
    unsupportedCriteria.length > 0
      ? "unsupported"
      : draft.proxies.length > 0 || draft.confidence !== "high"
        ? "proxy"
        : "exact";

  return targetingPlanSchema.parse({
    ...draft,
    filters,
    unsupportedCriteria,
    status,
    availability: {
      reportedCount: availability.reportedCount,
      privacyCensoredBelow25: availability.reportedCount === 0,
      checkedAt: availability.checkedAt,
    },
  });
}

export function hasUnsupportedBooleanLogic(request: string): boolean {
  const normalized = normalizePhrase(request);
  if (!/\b(?:or|either)\b/.test(normalized)) return false;

  const clauses = normalized.split(/\b(?:or|either)\b/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length <= 1) return false;

  const hasCountryClause = clauses.some((c) => /\b(country|residence|united states|us|uk|canada)\b/.test(c));
  const hasAgeClause = clauses.some((c) => /\b(age|aged|years|adult)\b/.test(c));
  const hasWorkClause = clauses.some((c) => /\b(employed|work|employment|job)\b/.test(c));

  const dimensionCount = [hasCountryClause, hasAgeClause, hasWorkClause].filter(Boolean).length;
  return dimensionCount > 1;
}

export function availabilityLabel(plan: Pick<TargetingPlan, "availability">): string {
  return plan.availability.privacyCensoredBelow25
    ? "Small audience; timing is uncertain"
    : `${plan.availability.reportedCount.toLocaleString()} people currently eligible`;
}

function tokenize(value: string): string[] {
  return normalizePhrase(value)
    .split(" ")
    .filter((term) => term.length > 1);
}

function normalizePhrase(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function includesPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function isCurrentCountryFilter(filter: NormalizedCatalogFilter): boolean {
  const metadata = normalizePhrase(`${filter.id} ${filter.title} ${filter.question}`);
  return (
    includesPhrase(metadata, "current country of residence") ||
    (includesPhrase(metadata, "country") && includesPhrase(metadata, "currently reside"))
  );
}
