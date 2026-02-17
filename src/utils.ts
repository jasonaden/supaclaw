/**
 * Escapes PostgREST filter special characters to prevent filter injection.
 *
 * PostgREST uses characters like `.`, `,`, `(`, `)`, `%`, and `*` as
 * operators/delimiters in filter expressions. User-supplied values
 * interpolated into `.or()` or `.ilike()` filters must be escaped so
 * they are treated as literal text.
 */
export function sanitizeFilterInput(value: string): string {
  // Backslash-escape each PostgREST special character
  return value.replace(/[.,()%*\\]/g, '\\$&');
}
