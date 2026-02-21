export interface MessageFilter {
  skipPatterns?: string[];
  skipPrefixes?: string[];
  minLength?: number;
  skipRoles?: string[];
}

/**
 * Check if a message should be logged based on filter rules.
 * Returns true if the message passes all filters.
 */
export function shouldLog(
  content: string,
  role: string,
  filter: MessageFilter | undefined
): boolean {
  if (!filter) return true;

  if (filter.skipRoles?.includes(role)) {
    return false;
  }

  if (filter.minLength !== undefined && content.length < filter.minLength) {
    return false;
  }

  if (filter.skipPrefixes?.some(prefix => content.startsWith(prefix))) {
    return false;
  }

  if (filter.skipPatterns?.some(pattern => new RegExp(pattern).test(content))) {
    return false;
  }

  return true;
}
