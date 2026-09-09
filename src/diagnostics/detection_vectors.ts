/**
 * Registry of known browser-automation detection vectors.
 *
 * Each rule compares a subject fingerprint (Weles) against a real-browser
 * baseline and returns a Finding when the subject exhibits a tell that
 * anti-bot systems (LinkedIn, reCAPTCHA Enterprise, PerimeterX, Akamai,
 * Cloudflare, BotD, etc.) are known to use.
 *
 * Rules are intentionally conservative: a Finding is evidence, not proof.
 * The analyzer scores and ranks them so operators see the most likely
 * detection signals first.
 *
 * The vectors themselves live in `./detection_vectors/`, grouped by the layer
 * of the stack they interrogate — the JS browser surface, the device beneath
 * it, the network below that, and the cross-signal checks that need no
 * baseline at all. This file remains the registry: it decides which families
 * are enrolled and in what order they run.
 *
 * That order is part of the contract. The analyzer sorts findings by severity
 * with a stable sort, so within one severity band an operator reads them in
 * registry order. The spread below therefore reproduces the historical order
 * exactly, and a family must be inserted at the position its rules already
 * occupied rather than appended for convenience.
 */

import type { DetectionRule } from './detection_vectors/finding.js';
import { navigatorSurfaceRules } from './detection_vectors/browser_surface/navigator_surface.js';
import { clientHintsRules } from './detection_vectors/browser_surface/client_hints.js';
import { chromeGlobalsRules } from './detection_vectors/browser_surface/chrome_globals.js';
import { profileProvenanceRules } from './detection_vectors/browser_surface/profile_provenance.js';
import { surfaceCompletenessRules } from './detection_vectors/browser_surface/surface_completeness.js';
import { screenGeometryRules } from './detection_vectors/device_signals/screen_geometry.js';
import { gpuRendererRules } from './detection_vectors/device_signals/gpu_renderer.js';
import { mediaFingerprintRules } from './detection_vectors/device_signals/media_fingerprints.js';
import { transportFingerprintRules } from './detection_vectors/network_signals/transport_fingerprints.js';
import { webrtcRoutingRules } from './detection_vectors/network_signals/webrtc_routing.js';
import { engineBehaviorRules } from './detection_vectors/cross_signal/engine_behavior.js';
import { personaConsistencyRules } from './detection_vectors/cross_signal/persona_consistency.js';

export type {
  Finding,
  FindingCategory,
  FindingSeverity,
  DetectionRule,
} from './detection_vectors/finding.js';

const rules: DetectionRule[] = [
  ...navigatorSurfaceRules,
  ...clientHintsRules,
  ...screenGeometryRules,
  ...gpuRendererRules,
  ...mediaFingerprintRules,
  ...chromeGlobalsRules,
  ...engineBehaviorRules,
  ...transportFingerprintRules,
  ...webrtcRoutingRules,
  ...profileProvenanceRules,
  ...personaConsistencyRules,
  ...surfaceCompletenessRules,
];

export function getDetectionRules(): DetectionRule[] {
  return rules;
}
