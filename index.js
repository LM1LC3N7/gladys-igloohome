// -----------------------------------------------------------------------------
// Entry point of the container: SDK wiring only (src/handlers.js registers
// every handler BEFORE connect(), and delegates to the IglooApp of
// src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { IglooApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new IglooApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

logger.info('Starting the igloohome integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err?.message ?? 'error');
  process.exit(1);
});
