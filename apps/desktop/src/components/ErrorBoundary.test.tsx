import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

function Broken(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'filter')");
}

it("shows the error and a way out instead of a blank window", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(screen.getByRole("alert").textContent).toContain("Cannot read properties of undefined (reading 'filter')");
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  // Restarting the daemon needs the desktop app.
  expect(screen.queryByRole("button", { name: "Restart daemon" })).toBe(null);
});
