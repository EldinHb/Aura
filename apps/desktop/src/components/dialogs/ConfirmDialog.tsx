import { Modal } from "../Modal";
import { useStore } from "../../state/store";
import clsx from "clsx";

export function ConfirmDialog({ title, message, onConfirm, danger }: { title: string; message: string; onConfirm: () => void; danger?: boolean }) {
  const closeDialog = useStore((s) => s.closeDialog);
  const confirm = () => {
    closeDialog();
    onConfirm();
  };
  return (
    <Modal
      title={title}
      width={460}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "y") {
          e.preventDefault();
          confirm();
        } else if (e.key === "n") {
          e.preventDefault();
          closeDialog();
        }
      }}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>
            Cancel <kbd>n</kbd>
          </button>
          <button type="button" className={clsx("btn", danger ? "danger" : "primary")} data-command="dialog.confirm" data-autofocus onClick={confirm}>
            Confirm <kbd>↩</kbd>
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}
