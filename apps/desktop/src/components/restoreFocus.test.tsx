import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { Modal } from "./Modal";
import { ModalC } from "./ModalC";

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
