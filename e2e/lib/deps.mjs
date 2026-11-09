// Resolve ws and playwright the way CommonJS does, so a globally installed copy (NODE_PATH) also works.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const WebSocket = require('ws');
export const { WebSocketServer } = WebSocket;
export const { chromium } = require('playwright');
