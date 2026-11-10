// Orchestration actions and PAM application routes. Actions are the only way agents act: each names the capabilities it
// needs and calls engines through their service interfaces under the task's authorized context.
import type { Route } from '../service-kit.ts';
import type { ActionDefinition } from '../orchestration/index.ts';
import type { Runtime } from './compose.ts';

export function loadActions(_runtime: Runtime): Record<string, ActionDefinition> { return {}; }
export function loadExtraRoutes(_runtime: Runtime): Route[] { return []; }
