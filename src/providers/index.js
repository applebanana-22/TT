import * as facebook from './facebook.js';
import * as tiktok from './tiktok.js';
import { Status, transition } from '../lib/connection.js';
import { ProviderError } from '../lib/http.js';

export const providers = { facebook, tiktok };
export const PROVIDER_NAMES = Object.keys(providers);

// Runs an API call for a provider. If the provider says our token is no longer
// valid, the account is moved to EXPIRED so the UI shows "Reconnect".
export async function withAuthHandling(provider, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError && err.auth) {
      await transition(provider, Status.EXPIRED, { statusReason: err.message });
    }
    throw err;
  }
}
