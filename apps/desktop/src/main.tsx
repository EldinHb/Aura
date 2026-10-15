import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Files dropped outside the composer would make the webview open them in place of the app.
window.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files") || e.defaultPrevented) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
