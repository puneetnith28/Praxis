/**
 * Reading a Supervisor failure.
 *
 * These three questions decide whether supervision keeps happening, so they
 * live apart from the watcher: no imports, nothing to mock, directly testable.
 *
 * The distinction that matters is between "your credentials are wrong" and
 * "that model cannot be invoked". They need different advice and, until this
 * was split out, they got the same answer — which is how the Supervisor came
 * to be silently dead on this machine for days while telling the log to go and
 * check some perfectly valid AWS keys.
 */

/** Narrowly: are the credentials themselves the problem? */
export function isCredentialError(msg: string): boolean {
  return /credential|AccessDenied|UnrecognizedClient|ExpiredToken|not authorized|security token|Region is missing|ENOTFOUND|ECONNREFUSED/i.test(msg);
}

/**
 * The model cannot be invoked: retired, not enabled, or misnamed.
 *
 * Bedrock retires model versions, and every id then answers
 * `ResourceNotFoundException: This model version has reached the end of its
 * life`. Measured on this account: every `anthropic.*` id is end-of-life, and
 * the `us.*` inference profiles that replace them need an IAM line most
 * policies written a year ago do not have.
 */
export function isModelUnavailable(msg: string): boolean {
  return /ResourceNotFoundException|end of its life|ModelNotReady|could not be found|ValidationException.*model/i.test(msg);
}

/** Rate-capped by the provider. */
export function isRateCapped(msg: string): boolean {
  return /ThrottlingException|Too many tokens|TooManyRequests|ServiceQuotaExceeded/i.test(msg);
}

/**
 * Is this a reason to try the Anthropic API instead?
 *
 * This used to ask only "is it a credential error", which missed the case that
 * actually took the Supervisor down: classification threw on every batch,
 * forever, with a working Anthropic credential sitting unused beside it.
 *
 * A model that cannot be invoked is exactly as unusable as a credential that
 * does not work, and the user does not care which it was. Rate caps count too
 * — classifying through the other provider beats not classifying.
 */
export function shouldFallBack(msg: string): boolean {
  return isCredentialError(msg) || isModelUnavailable(msg) || isRateCapped(msg);
}
