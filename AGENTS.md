# Development Guidelines

## Project Architecture

Zerodrift Agent is a Next.js workspace for AI-assisted security audits.
It is a general-purpose, multi-Workflow Agent platform that integrates different Agents through BaseAgent. Its primary components are Session, Agent, and Workflow, while Runner coordinates their execution.

## Technology Stack

The application is built with Next.js and React. It uses Tailwind CSS v4 with shadcn/Radix UI, Lucide for icons, Framer Motion for animations, Sonner for notifications, TanStack Query for request caching, Zod for schemas and validation, and Shiki for code syntax highlighting.

## Frontend Guidelines

- Prefer the existing component system and shadcn/Radix styling. Do not introduce another UI framework.
- Use Lucide for all icons.
- Prefer TanStack Query for client requests, mutations, and cache invalidation.
- Prefer Zod schemas to validate forms and API inputs and responses.
- Use Sonner toasts for user feedback.
- Keep pages and components consistent with the current product style: information-dense, clear, and direct, without large marketing-style decorative sections.

## Backend and Data Guidelines

- Treat `src/server/db/schema.ts` as the single source of truth for the database schema.
- Generate database schema migrations with Drizzle tooling, for example `pnpm db:generate`.
- Do not hand-write `CREATE TABLE` or `ALTER TABLE` statements in application code as schema repair logic.
- Do not add runtime SQL repair helpers to bypass migrations.
- When API request or response structures change, update `src/schemas/openapi.ts` and regenerate `public/openapi.json`.
