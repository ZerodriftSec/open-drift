import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  dbCredentials: {
    url: "./.data/data.sqlite",
  },
  out: "./drizzle",
  schema: "./src/server/db/schema.ts",
});
