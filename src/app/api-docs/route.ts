import { ApiReference } from "@scalar/nextjs-api-reference";

const config = {
  _integration: "nextjs",
  agent: {
    disabled: true,
  },
  mcp: {
    disabled: true,
  },
  showDeveloperTools: "never",
  url: "/openapi.json",
} as const;

export const GET = ApiReference(config);
