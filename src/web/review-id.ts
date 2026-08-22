const reviewIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReviewId(value: string | null): string | null {
  return value && reviewIdPattern.test(value) ? value : null;
}
