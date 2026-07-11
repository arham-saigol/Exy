export const DISCORD_MESSAGE_LIMIT = 2_000;

/**
 * Split text without dropping characters. Newlines and then whitespace are
 * preferred, with a Unicode-safe hard boundary as the final fallback.
 */
export function chunkDiscordMessage(
  text: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Discord message chunk limit must be a positive integer");
  }

  if (text.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let boundary = preferredBoundary(remaining, limit);

    // Do not split a UTF-16 surrogate pair at a hard boundary.
    if (
      boundary > 0 &&
      isHighSurrogate(remaining.charCodeAt(boundary - 1)) &&
      isLowSurrogate(remaining.charCodeAt(boundary))
    ) {
      boundary -= 1;
    }

    // A one-code-unit limit cannot contain an astral code point intact.
    if (boundary === 0) {
      throw new RangeError(
        "Discord message chunk limit is too small for the next Unicode character",
      );
    }

    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function preferredBoundary(text: string, limit: number): number {
  const minimumSoftBoundary = Math.floor(limit * 0.5);
  const newline = text.lastIndexOf("\n", limit - 1);
  if (newline >= minimumSoftBoundary) {
    return newline + 1;
  }

  for (let index = limit - 1; index >= minimumSoftBoundary; index -= 1) {
    const character = text[index];
    if (character !== undefined && /\s/u.test(character)) {
      return index + 1;
    }
  }

  return limit;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
