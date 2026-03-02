import { useCallback, useMemo, useState } from 'react';
import { GlobalModalContext } from './modalContext';

type ModalKind = 'alert' | 'confirm';

type ModalState = {
  kind: ModalKind;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  closeOnOverlay?: boolean;
  resolve?: (confirmed: boolean) => void;
};

type AlertOptions = {
  title: string;
  message: string;
  confirmText?: string;
  closeOnOverlay?: boolean;
};

type ConfirmOptions = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  closeOnOverlay?: boolean;
};

export function GlobalModalProvider({ children }: { children: React.ReactNode }) {
  const [modal, setModal] = useState<ModalState | null>(null);

  const closeWithResult = useCallback((confirmed: boolean) => {
    setModal((prev) => {
      if (prev?.resolve) {
        prev.resolve(confirmed);
      }
      return null;
    });
  }, []);

  const closeModal = useCallback(() => {
    closeWithResult(false);
  }, [closeWithResult]);

  const showAlert = useCallback((options: AlertOptions) => {
    setModal({
      kind: 'alert',
      title: options.title,
      message: options.message,
      confirmText: options.confirmText,
      closeOnOverlay: options.closeOnOverlay ?? true,
    });
  }, []);

  const showConfirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setModal({
        kind: 'confirm',
        title: options.title,
        message: options.message,
        confirmText: options.confirmText,
        cancelText: options.cancelText,
        closeOnOverlay: options.closeOnOverlay ?? false,
        resolve,
      });
    });
  }, []);

  const contextValue = useMemo(() => ({
    showAlert,
    showConfirm,
    closeModal,
  }), [showAlert, showConfirm, closeModal]);

  return (
    <GlobalModalContext.Provider value={contextValue}>
      {children}
      {modal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => {
            if (modal.closeOnOverlay) {
              closeWithResult(false);
            }
          }}
        >
          <div
            className="bg-card w-full max-w-sm rounded-lg border border-border shadow-lg overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold">{modal.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{modal.message}</p>
            </div>
            <div className="bg-muted/50 px-6 py-4 flex items-center justify-end gap-3">
              {modal.kind === 'confirm' && (
                <button
                  onClick={() => closeWithResult(false)}
                  className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted text-foreground transition-colors border border-transparent hover:border-border"
                >
                  {modal.cancelText || 'Cancel'}
                </button>
              )}
              <button
                onClick={() => closeWithResult(true)}
                className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {modal.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </GlobalModalContext.Provider>
  );
}
