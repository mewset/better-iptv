import { AlertCircle, X } from 'lucide-react';

interface ErrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  buttonText?: string;
}

export default function ErrorModal({
  isOpen,
  onClose,
  title,
  message,
  buttonText = 'OK',
}: ErrorModalProps) {
  if (!isOpen) return null;

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
            <div className="rounded-full bg-danger/10 p-2">
              <AlertCircle className="h-5 w-5 text-danger" aria-hidden="true" />
            </div>
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

        {/* Error Message */}
        <div className="mb-6">
          <p className="text-text-muted">{message}</p>
        </div>

        {/* Action */}
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-danger px-4 py-2 text-on-danger hover:bg-danger/90"
          >
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
}
