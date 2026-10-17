import type { RendererApi } from '../shared/ipc';
import type { UsageAction } from '../shared/usage';

/**
 * Fire-and-forget usage tracking from the renderer. Wrapped so that a missing API surface or any
 * unexpected error can never interrupt the user action it is attached to — tracking is always
 * strictly secondary to the thing the user actually clicked.
 */
export function track(api: RendererApi, action: UsageAction): void {
  try {
    api.usage?.track(action);
  } catch {
    /* tracking must never affect the UI */
  }
}
