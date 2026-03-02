import { createContext } from 'react';

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

export type GlobalModalContextValue = {
  showAlert: (options: AlertOptions) => void;
  showConfirm: (options: ConfirmOptions) => Promise<boolean>;
  closeModal: () => void;
};

export const GlobalModalContext = createContext<GlobalModalContextValue | null>(null);
