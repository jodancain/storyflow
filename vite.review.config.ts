import { defineConfig } from "vite";
export default defineConfig({ define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { outDir: "dist-review", emptyOutDir: true, cssCodeSplit: false, lib: { entry: "src/review/public-entry.tsx", name: "StoryFlowReview", formats: ["iife"], fileName: () => "review.js", cssFileName: "review" } } });
