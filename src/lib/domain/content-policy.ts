import { AppError } from "@/lib/errors";

const prohibitedRules: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:child|children|minor|under[- ]?18|teen(?:ager)?s?)\b[\s\S]{0,80}\b(?:sex|sexual|explicit|nude|porn)/i,
    reason: "sexual content involving minors",
  },
  {
    pattern: /\b(?:survey(?:ing)?|recruit(?:ing)?|target(?:ing)?|ask(?:ing)?|opinions? (?:of|from)|feedback from|participants?|respondents?)\b[\s\S]{0,100}\b(?:child|children|minor|under[- ]?18|middle[- ]?school(?:ers| students?| pupils?)?|high[- ]?school(?:ers| students?| pupils?)?|teen(?:ager)?s?)\b/i,
    reason: "surveys targeting minors",
  },
  {
    pattern: /\b(?:full names?|e-?mail addresses?|phone numbers?|home addresses?|social security numbers?|passport numbers?|contact details)\b/i,
    reason: "requests for direct identifiers",
  },
  {
    pattern: /(?:\b(?:collect(?:ing)?|request(?:ing)?|obtain(?:ing)?|record(?:ing)?|capture|capturing|store|storing)\b[\s\S]{0,80}\be-?mails?\b|\b(?:provide|providing|submit|submitting|enter|entering|share|sharing)\s+(?:(?:us\s+)?(?:your|their|an?)\s+)?e-?mails?\b|\bask(?:ing)?\b[\s\S]{0,60}\bfor\s+(?:(?:your|their|an?)\s+)?e-?mails?\b)/i,
    reason: "requests for direct identifiers",
  },
  {
    pattern: /\b(?:how to|help (?:me )?|plan to|instructions? (?:for|to))\b[\s\S]{0,100}\b(?:kill|bomb|attack|kidnap|traffic|poison|disable security|evade police)\b/i,
    reason: "serious violence or illegal harm",
  },
];

export function enforceMinimalContentPolicy(text: string): void {
  const match = prohibitedRules.find((rule) => rule.pattern.test(text));
  if (match) {
    throw new AppError(
      "CONTENT_REJECTED",
      `This request cannot be used for the demo because it involves ${match.reason}.`,
      { status: 422 },
    );
  }
}
