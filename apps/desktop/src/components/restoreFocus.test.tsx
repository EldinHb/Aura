import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { Modal } from "./Modal";
import { ModalC } from "./ModalC";
import { CommandPalette } from "./CommandPalette";
import { registerCommands } from "../lib/commands";
import { useStore } from "../state/store";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

it("ModalC gives the keyboard back to its opener, also when its input takes focus with autoFocus", () => {
  function App() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" data-hint onClick={() => setOpen(true)}>Open</button>
        {open && <ModalC title="Search" onKeyDown={(e) => e.key === "Enter" && setOpen(false)}><input aria-label="Search" data-autofocus autoFocus /></ModalC>}
      </>
    );
  }
  render(<App />);
  const opener = screen.getByText("Open");
  opener.focus();
  fireEvent.click(opener);
  expect(document.activeElement).toBe(screen.getByLabelText("Search"));
  fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });
  expect(document.activeElement).toBe(opener);
});

it("Modal leaves the keyboard where whoever closed it put it, and skips an opener that is gone", () => {
  function Host() {
    const [open, setOpen] = useState(false);
    const [opener, setOpener] = useState(true);
    return (
      <>
        {opener && <button type="button" data-hint onClick={() => setOpen(true)}>Opener</button>}
        <textarea aria-label="Message" />
        {open && (
          <Modal title="Rename" onClose={() => setOpen(false)}>
            <button type="button" data-hint onClick={() => { setOpen(false); screen.getByLabelText("Message").focus(); }}>Rename and write</button>
            <button type="button" data-hint onClick={() => { setOpener(false); setOpen(false); }}>Delete opener</button>
          </Modal>
        )}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByText("Opener");
  opener.focus();
  fireEvent.click(opener);
  act(() => fireEvent.click(screen.getByText("Rename and write")));
  expect(document.activeElement).toBe(screen.getByLabelText("Message"));
  opener.focus();
  fireEvent.click(opener);
  act(() => fireEvent.click(screen.getByText("Delete opener")));
  expect(document.activeElement).toBe(document.body);
});

const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

/** A message box and whichever dialog the store names, as the app shows them. */
function Dialogs() {
  const kind = useStore((s) => s.dialog.kind);
  return (
    <>
      <textarea aria-label="Message" />
      {kind === "rename" && (
        <Modal title="First">
          <button type="button" data-hint onClick={() => useStore.getState().openDialog({ kind: "help" })}>Next</button>
        </Modal>
      )}
      {kind === "help" && (
        <Modal title="Second">
          <button type="button" data-hint>Got it</button>
        </Modal>
      )}
    </>
  );
}

it("a dialog run from the command palette gives the keyboard back to where the palette was opened, as does the palette", async () => {
  const unregister = registerCommands([{ id: "test.open-dialog", title: "Open the test dialog", group: "Test", run: () => useStore.getState().openDialog({ kind: "help" }) }]);
  useStore.setState({ dialog: { kind: "none" }, paletteOpen: false });
  render(<><Dialogs /><CommandPalette /></>);
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  box.focus();
  act(() => useStore.getState().setPalette(true));
  await nextFrame();
  const input = screen.getByPlaceholderText(/^Type a command/);
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Open the test dialog" } });
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  expect(useStore.getState().paletteOpen).toBe(false);
  expect(document.activeElement).toBe(screen.getByText("Got it"));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(document.activeElement).toBe(box);
  // Closing the palette itself gives it back too.
  act(() => useStore.getState().setPalette(true));
  await nextFrame();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Escape" });
  expect(document.activeElement).toBe(box);
  unregister();
});

it("a dialog opened from another dialog gives the keyboard back to where the first was opened", () => {
  useStore.setState({ dialog: { kind: "none" } });
  render(<Dialogs />);
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  box.focus();
  act(() => useStore.getState().openDialog({ kind: "rename", sessionId: "s" }));
  expect(document.activeElement).toBe(screen.getByText("Next"));
  act(() => fireEvent.click(screen.getByText("Next")));
  expect(document.activeElement).toBe(screen.getByText("Got it"));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(document.activeElement).toBe(box);
});
