import { AppError } from "@/lib/errors";
import {
  type NormalizedCatalogFilter,
  type TargetingPlan,
  type ValidatedProlificFilter,
  normalizedCatalogFilterSchema,
  targetingPlanSchema,
  validatedProlificFilterSchema,
} from "@/lib/domain/schemas";

const semanticAliases: Record<string, readonly string[]> = {
  country: ["country", "country of residence", "residence", "resident", "residents", "location", "living in", "live in", "united states", "usa", "u s"],
  age: ["age", "aged", "ages", "adult", "adults", "years old"],
  gender: ["gender", "sex"],
  employment: ["employment", "employment status", "work status", "employed"],
  industry: ["industry", "work sector", "sector"],
  student: ["student", "student status", "studying"],
  education: ["education", "highest level", "qualification"],
  language: ["language", "fluent", "fluency", "native language"],
  politics: ["political", "politics", "party", "affiliation"],
  parenthood: ["parent", "children", "parenthood"],
  relationship: ["relationship", "marital", "partner"],
};

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
  limit = 12,
): NormalizedCatalogFilter[] {
  const normalizedQuery = normalizePhrase(requestedAudience);
  const queryTerms = tokenize(requestedAudience);
  const semanticTerms = new Set(queryTerms);
  const requestedDimensions = new Set<string>();
  for (const [dimension, aliases] of Object.entries(semanticAliases)) {
    if (aliases.some((alias) => includesPhrase(normalizedQuery, normalizePhrase(alias)))) {
      requestedDimensions.add(dimension);
      aliases.flatMap(tokenize).forEach((term) => semanticTerms.add(term));
    }
  }

  return catalog
    .map((filter) => {
      const title = tokenize(filter.title);
      const details = tokenize(`${filter.question} ${filter.category}`);
      const choiceTerms = tokenize(filter.choices?.map((choice) => choice.label).join(" ") ?? "");
      let score = 0;
      for (const term of semanticTerms) {
        if (title.includes(term)) score += 5;
        if (details.includes(term)) score += 2;
        if (choiceTerms.includes(term)) score += 1;
      }
      for (const dimension of requestedDimensions) {
        score += preferredDimensionScore(dimension, filter);
      }
      if (
        isCurrentCountryFilter(filter) &&
        filter.choices?.some((choice) =>
          includesPhrase(normalizedQuery, normalizePhrase(choice.label)),
        )
      ) {
        score += 40;
      }
      return { filter, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.filter.title.localeCompare(right.filter.title))
    .slice(0, limit)
    .map((entry) => entry.filter);
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
  const normalized = request.toLocaleLowerCase();
  const dimensions = Object.entries(semanticAliases)
    .filter(([, aliases]) => aliases.some((alias) => normalized.includes(alias)))
    .map(([dimension]) => dimension);
  if (dimensions.length < 2 || !/\b(?:or|either)\b/.test(normalized)) return false;

  // OR is only safe among values of one filter. Mixed dimensions are conservatively unsupported.
  const clauses = normalized.split(/\b(?:or|either)\b/);
  const clauseDimensions = clauses.map((clause) =>
    Object.entries(semanticAliases)
      .filter(([, aliases]) => aliases.some((alias) => clause.includes(alias)))
      .map(([dimension]) => dimension),
  );
  return new Set(clauseDimensions.flat()).size > 1;
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

function preferredDimensionScore(
  dimension: string,
  filter: NormalizedCatalogFilter,
): number {
  const metadata = normalizePhrase(`${filter.id} ${filter.title} ${filter.question}`);
  switch (dimension) {
    case "country":
      return isCurrentCountryFilter(filter) ? 60 : /\bcountry\b/.test(metadata) ? 8 : 0;
    case "age":
      return filter.id === "age" || normalizePhrase(filter.title) === "age" ? 60 : 0;
    case "employment":
      return /\bemployment status\b|\bwork status\b/.test(metadata) ? 45 : 0;
    case "student":
      return /\bstudent status\b/.test(metadata) ? 45 : 0;
    case "language":
      return /\bfirst language\b|\bnative language\b/.test(metadata) ? 45 : 0;
    default:
      return semanticAliases[dimension]?.some((alias) =>
        includesPhrase(metadata, normalizePhrase(alias)),
      )
        ? 20
        : 0;
  }
}

function isCurrentCountryFilter(filter: NormalizedCatalogFilter): boolean {
  const metadata = normalizePhrase(`${filter.id} ${filter.title} ${filter.question}`);
  return (
    includesPhrase(metadata, "current country of residence") ||
    (includesPhrase(metadata, "country") && includesPhrase(metadata, "currently reside"))
  );
}
