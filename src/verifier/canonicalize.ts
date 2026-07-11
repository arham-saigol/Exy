const ALLOWED_X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "m.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
]);

export interface CanonicalXPost {
  postId: string;
  canonicalUrl: string;
}

export class InvalidXPostReferenceError extends Error {
  constructor(message = "Expected a numeric X post ID or an x.com/twitter.com post URL") {
    super(message);
    this.name = "InvalidXPostReferenceError";
  }
}

/**
 * Extracts the opaque snowflake string without converting it to a JS number.
 * Query strings, fragments, mobile hosts, and /i/web/status URLs all collapse
 * to the same https://x.com/i/web/status/{id} identity.
 */
export function canonicalizeXPost(reference: string): CanonicalXPost {
  const input = reference.trim();
  if (input === "") throw new InvalidXPostReferenceError();

  if (/^\d{1,40}$/.test(input)) return fromDigits(input);

  let url: URL;
  try {
    const value = /^(?:x\.com|twitter\.com|(?:www|mobile|m)\.(?:x|twitter)\.com)\//i.test(input)
      ? `https://${input}`
      : input;
    url = new URL(value);
  } catch {
    throw new InvalidXPostReferenceError();
  }

  if (!/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "") {
    throw new InvalidXPostReferenceError("X post URL must use HTTP(S) and must not contain credentials");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!ALLOWED_X_HOSTS.has(hostname)) throw new InvalidXPostReferenceError();

  const match = url.pathname.match(
    /^\/(?:i\/(?:web\/)?status|[^/]+\/status(?:es)?)\/(\d{1,40})(?:\/.*)?$/i,
  );
  const digits = match?.[1];
  if (digits === undefined) throw new InvalidXPostReferenceError();
  return fromDigits(digits);
}

function fromDigits(digits: string): CanonicalXPost {
  const postId = digits.replace(/^0+(?=\d)/, "");
  if (postId === "0") throw new InvalidXPostReferenceError("X post ID must be greater than zero");
  return { postId, canonicalUrl: `https://x.com/i/web/status/${postId}` };
}
