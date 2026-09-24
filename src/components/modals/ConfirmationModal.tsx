import { AlertTriangle, X } from 'lucide-react';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'danger' | 'primary';
}

export default function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmVariant = 'primary',
}: ConfirmationModalProps) {
  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {confirmVariant === 'danger' && (
              <div className="rounded-full bg-danger/10 p-2">
                <AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />
              </div>
            )}
            <h3 className="text-xl font-bold text-text">{title}</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 hover:bg-surface-hover"
          >
            <X className="h-5 w-5 text-text-muted" aria-hidden="true" />
          </button>
        </div>

        {/* Message */}
        <div className="mb-6">
          <p className="text-text-muted">{message}</p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-surface-2 px-4 py-2 text-text hover:bg-surface-hover"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            className={`rounded-lg px-4 py-2 ${
              confirmVariant === 'danger'
                ? 'bg-danger text-on-danger hover:bg-danger/90'
                : 'bg-accent text-on-accent hover:bg-accent-hover'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
