import { readFileSync } from 'node:fs';

const {
  REDDIT_CLIENT_ID: clientId,
  REDDIT_CLIENT_SECRET: clientSecret,
  REDDIT_REFRESH_TOKEN: refreshToken,
  REDDIT_SUBREDDIT: subreddit = 'tracearr',
  RELEASE_TAG: tag,
  TITLE_PREFIX: titlePrefix = 'Release',
  NOTES_FILE: notesFile,
  REDDIT_FLAIR_ID: flairId,
  DRY_RUN: dryRun,
} = process.env;

if (!tag || !notesFile) {
  console.error('RELEASE_TAG and NOTES_FILE are required');
  process.exit(1);
}

const title = `${titlePrefix}: ${tag}`;
const footer =
  '\n\n---\n\n' +
  '[Discord](https://discord.gg/a7n3sFd2Yw) | ' +
  '[Documentation](https://docs.tracearr.com) | ' +
  '[tracearr.com](https://tracearr.com)';
const body = readFileSync(notesFile, 'utf8').trim() + footer;

if (dryRun) {
  console.log(`[dry-run] r/${subreddit}\n[dry-run] title: ${title}\n\n${body}`);
  process.exit(0);
}

if (!clientId || !clientSecret || !refreshToken) {
  console.log('Reddit credentials not configured - skipping announcement post');
  process.exit(0);
}

// Reddit throttles requests without a descriptive User-Agent.
const userAgent = 'tracearr-release/1.0 (r/tracearr release announcements)';

const tokenResponse = await fetch('https://www.reddit.com/api/v1/access_token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
  },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
});
const tokenJson = await tokenResponse.json();
if (!tokenResponse.ok || !tokenJson.access_token) {
  console.error(`Reddit auth failed (${tokenResponse.status}):`, tokenJson);
  process.exit(1);
}

const submitResponse = await fetch('https://oauth.reddit.com/api/submit', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokenJson.access_token}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
  },
  body: new URLSearchParams({
    sr: subreddit,
    kind: 'self',
    title,
    text: body,
    api_type: 'json',
    sendreplies: 'false',
    resubmit: 'true',
    ...(flairId ? { flair_id: flairId } : {}),
  }),
});
// /api/submit answers 200 even on failure; the real errors are in json.errors.
const submitJson = await submitResponse.json();
const errors = submitJson?.json?.errors ?? [];
if (!submitResponse.ok || errors.length > 0) {
  console.error(`Reddit submit failed (${submitResponse.status}):`, JSON.stringify(submitJson));
  process.exit(1);
}

console.log(`Posted to r/${subreddit}: ${submitJson.json.data?.url ?? '(no url returned)'}`);
