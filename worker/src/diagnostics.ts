/** Only bounded codes and fixed labels leave the relay, never upstream error text. */
type FailureKind = 'quota' | 'capacity' | 'rate_limit' | 'access' | 'model' | 'invalid_request' | 'timeout' | 'unavailable';

export interface ProviderFailure {
  provider: string;
  kind: FailureKind;
  code?: number;
  status?: number;
}

// https://developers.cloudflare.com/workers-ai/platform/errors/
const CLOUDFLARE_CODES: Record<number, [FailureKind, number]> = {
  3003: ['invalid_request', 400], 3006: ['invalid_request', 413],
  3007: ['timeout', 408], 3008: ['timeout', 408],
  3023: ['access', 403], 3036: ['quota', 429], 3039: ['model', 400],
  3040: ['capacity', 429], 3041: ['access', 403], 3042: ['model', 404],
  5004: ['invalid_request', 400], 5005: ['model', 405], 5007: ['model', 400],
  5016: ['access', 403], 5018: ['access', 403], 5019: ['invalid_request', 405],
  5035: ['access', 403],
};

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

export function describeFailure(provider: string, error: unknown): ProviderFailure {
  const fields = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = typeof fields.message === 'string' ? fields.message : typeof error === 'string' ? error : '';
  const cloudflare = provider === 'Cloudflare Workers AI';
  // Bindings commonly throw "AI_ERROR: 3006: ..." instead of exposing a code field.
  // Match the prefix only; arbitrary numbers inside a prompt are not diagnostic codes.
  const prefix = /^(?:(?:AI_ERROR|[A-Za-z]*Error):\s*)*(\d{4}):/.exec(message);
  const code = cloudflare ? boundedInteger(fields.code ?? prefix?.[1], 1000, 9999) : undefined;
  let status = boundedInteger(fields.status ?? fields.statusCode, 400, 599);
  let kind: FailureKind = 'unavailable';
  const known = code === undefined ? undefined : CLOUDFLARE_CODES[code];
  if (known) { [kind] = known; status ??= known[1]; }
  else if (status === 401 || status === 403) kind = 'access';
  else if (status === 404) kind = 'model';
  else if (status === 400 || status === 413 || status === 422) kind = 'invalid_request';
  else if (status === 408 || status === 504 || fields.name === 'AbortError' || /\btimeout\b|timed out/i.test(message)) kind = 'timeout';
  else if (/\bcapacity\b|overloaded/i.test(message)) kind = 'capacity';
  else if (/\bquota\b|daily free allocation|insufficient_quota/i.test(message)) kind = 'quota';
  else if (status === 429 || /rate.?limit|too many requests/i.test(message)) kind = 'rate_limit';
  return { provider, kind, ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) };
}

const MESSAGES: Record<FailureKind, string> = {
  quota: 'Le quota du fournisseur d’IA est atteint. Vérifiez sa consommation et sa date de renouvellement.',
  capacity: 'Le fournisseur d’IA est temporairement saturé. Réessayez dans quelques minutes.',
  rate_limit: 'Le fournisseur d’IA limite momentanément les requêtes. Attendez avant de réessayer.',
  access: 'Le fournisseur d’IA refuse l’accès. Vérifiez la clé, les autorisations et l’offre associée au modèle.',
  model: 'Le modèle d’IA configuré est introuvable ou incompatible. Vérifiez sa configuration.',
  invalid_request: 'Le fournisseur d’IA a refusé le format ou la taille de la requête. Le relais doit être vérifié.',
  timeout: 'Le délai de réponse du fournisseur d’IA a été dépassé. Réessayez plus tard.',
  unavailable: 'L’appel au fournisseur d’IA a échoué ; la cause n’a pas pu être identifiée.',
};

export function failureMessage(failures: ProviderFailure[]): string {
  // Different fallback failures must not be described as a single provider's quota.
  if (failures.length !== 1) return 'Les fournisseurs d’IA configurés ont échoué. Consultez les diagnostics du relais.';
  const failure = failures[0];
  const label = failure.code !== undefined ? `${failure.provider}, code ${failure.code}`
    : failure.status !== undefined ? `${failure.provider}, HTTP ${failure.status}` : failure.provider;
  return `${MESSAGES[failure.kind]} (${label})`;
}
