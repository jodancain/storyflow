import React from "react";
import { createRoot } from "react-dom/client";
import { PublicReview } from "./PublicReview";
import type { ReviewSnapshot } from "./ReviewPresentation";
import "./review.css";
import "./public.css";
const element = typeof document === "undefined" ? null : document.getElementById("storyflow-snapshot");
if (element) {
  const snapshot = JSON.parse(element.textContent || "null") as ReviewSnapshot;
  createRoot(document.getElementById("root")!).render(<PublicReview snapshot={snapshot} />);
}
