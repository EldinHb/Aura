import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./MarkdownView";
afterEach(cleanup);
it("renders highlighted, formatted code in a separate box and copies the source", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const code = 'const answer: number = 42;\n  console.log("hello");';
  const { container } = render(<Markdown text={'```typescript\n' + code + '\n```'} />);
  expect(container.querySelector(".code-block code")?.textContent).toBe(code);
  expect(container.querySelector(".hljs-keyword")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
});
it("keeps HTML examples inert and unknown or streamed languages readable", () => {
  const { container, rerender } = render(<Markdown text={'```html\n<img src=x onerror=alert(1)>\n```'} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe('<img src=x onerror=alert(1)>');
  rerender(<Markdown text={'```unknown-language\n  incomplete <script>'} />);
  expect(container.querySelector("code")?.textContent).toBe('  incomplete <script>');
  expect(container.querySelector("script")).toBeNull();
});
it("renders indented fences after a list and respects fence length", () => {
  const { container } = render(<Markdown text={'- Example:\n  ```js title=example\n  const x = 1;\n  ```\n\n````md\n```ts\nhello\n```\n````'} />);
  expect(container.querySelectorAll(".code-block")).toHaveLength(2);
  expect(container.querySelectorAll("code")[1].textContent).toBe('```ts\nhello\n```');
});
