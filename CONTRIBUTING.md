# Contributing to Tracearr

Thanks for considering a contribution. This document covers how we work and what we expect from PRs.

## Talk to Us First

For new features or significant changes, discuss your idea before writing code. Open a GitHub Discussion or drop by [Discord](https://discord.gg/a7n3sFd2Yw). This saves everyone time if the approach needs adjustment or if someone else is already working on it.

This is not a suggestion. A feature PR that was never discussed with a code owner gets closed, even when the code is fine. An unrequested feature carries design decisions nobody agreed to, and reviewing it costs more than building it.

Bug fixes can go straight to a PR, though an issue helps track the problem.

## Project Structure

Tracearr is a monorepo using pnpm workspaces and Turborepo:

```
apps/
  server/       # Fastify + Drizzle ORM + BullMQ + Socket.io
  web/          # React 19 + Vite + Tailwind + shadcn/ui
  mobile/       # React Native (Expo)
packages/
  shared/       # Types, Zod schemas, constants
  translations/ # i18n
  test-utils/   # Test factories and mocks
```

## Development Setup

```bash
# Start databases (TimescaleDB + Redis)
pnpm docker:up

# Install dependencies
pnpm install

# Start web and server
pnpm dev
```

## Pull Requests

Before submitting:

- CI must pass (`pnpm typecheck && pnpm lint && pnpm test:unit`)
- Include a clear description of what changed and why
- Add screenshots for UI changes
- Write tests for new features

### Commit Messages

Write commit messages in plain language. Describe what changed.

Good:

- `Add session termination endpoint`
- `Fix trust score calculation for users with no sessions`

Bad:

- `feat(sessions): implement termination functionality`
- `fix: resolve issue with calculation`

We don't use conventional commit prefixes.

## On AI-Assisted Code

We're fine with AI tools. Copilot, Claude, Cursor, whatever helps you work. But there are expectations.

**You own what you submit.** If you can't explain the code or debug it when something breaks, that's a problem. We've had PRs where contributors couldn't answer basic questions about their own submissions because they didn't actually understand what the AI generated. That's not a contribution, it's a maintenance burden.

**Disclose significant AI usage in your PR.** Not every autocomplete suggestion, but if AI wrote substantial portions of your code, say so. This helps reviewers know where to look carefully. The PR template has a checkbox for this.

**Tests matter more than ever.** If you understood the code well enough to write it, you can write tests for it. PRs that add features without tests often indicate the contributor doesn't fully grasp what they've built.

To be clear: we're not trying to gatekeep or ban AI. These tools are useful. But a 5,000-line PR with no tests and a contributor who can't explain the implementation creates real problems for maintainers.

## Autonomous Agents and Undiscussed Features

We do not accept contributions from autonomous agents. Pull requests and issues we believe were created autonomously get closed, and automated comments may be marked as spam. Bypassing or replacing the issue and PR templates counts.

The human-shaped version gets the same treatment. If a PR exists because someone pointed an AI at something they wanted and opened whatever came out, without discussing the feature with a code owner and without being able to explain the diff, it gets closed. This has already happened to recent submissions and it will keep happening.

Bug reports follow the same rule. Fill in the template with what actually happened and attach logs. A report that swaps the template for an AI-written diagnosis with a suggested fix gets closed; generated analysis is not evidence, and reviewing it costs more than the two facts we actually needed.

## Testing

```bash
pnpm test:unit       # Unit tests (fast, run these often)
pnpm test            # All tests (unit, services, routes, security)
pnpm test:integration # Integration tests (requires running DB/Redis)
```

New features need tests. Bug fixes should include a test that would have caught the bug when practical.

## Code Style

- React Query for server state
- PascalCase for components (`UserProfile.tsx`), camelCase for utils (`sessionService.ts`)

The project uses ESLint and Prettier. Run `pnpm lint` and `pnpm format` before committing.

## Questions

Open a GitHub Discussion or ask on [Discord](https://discord.gg/a7n3sFd2Yw).
