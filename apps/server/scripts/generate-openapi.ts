#!/usr/bin/env tsx
/**
 * Dumps the public API OpenAPI specs to JSON files.
 *
 * The release workflow attaches the output to the GitHub release so the docs
 * site can render the current stable specs from releases/latest/download.
 * The {host} server variable lets readers point "Test Request" at their own
 * instance; the runtime /docs endpoints override servers per-instance instead.
 *
 * Usage:
 *   pnpm openapi:dump [outDir]
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateOpenAPIDocument } from '../src/routes/public.openapi.js';
import { generateOpenAPIDocumentV2 } from '../src/routes/publicV2.openapi.js';

const SERVERS = [
  {
    url: 'https://{host}',
    description: 'Your Tracearr instance',
    variables: {
      host: {
        default: 'tracearr.example.com',
        description:
          'Hostname of your Tracearr instance, including any base path (e.g. media.example.com/tracearr)',
      },
    },
  },
];

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });

const docs: Array<[string, unknown]> = [
  ['openapi-v1.json', generateOpenAPIDocument()],
  ['openapi-v2.json', generateOpenAPIDocumentV2()],
];

for (const [file, doc] of docs) {
  const spec = { ...(doc as Record<string, unknown>), servers: SERVERS };
  const path = resolve(outDir, file);
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
