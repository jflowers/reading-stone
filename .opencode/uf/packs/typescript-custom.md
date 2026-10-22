---
pack_id: typescript-custom
language: TypeScript
version: 1.0.0
---
<!-- scaffolded by uf vdev -->

# Custom Rules: TypeScript

Project-specific TypeScript conventions that extend the
canonical TypeScript convention pack. Rules in this file
are loaded alongside `typescript.md` by Cobalt-Crush
(during implementation) and all Divisor persona agents
(during review).

Use the `CR-NNN` prefix for all custom rules. Use `[MUST]`,
`[SHOULD]`, or `[MAY]` severity indicators per RFC 2119.

## Custom Rules

- **CR-001** [MUST] This project uses Biome for both linting and
  formatting (`npx biome check src/ tests/`, 88-column line width).
  Biome supersedes the canonical pack's CS-001 (ESLint) and CS-002
  (Prettier): do not introduce ESLint, Prettier, or their
  configuration files.

<!-- Add project-specific rules below this line -->
