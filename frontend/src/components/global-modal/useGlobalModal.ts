import { useContext } from 'react';
import { GlobalModalContext } from './modalContext';

export function useGlobalModal() {
  const context = useContext(GlobalModalContext);
  if (!context) {
    throw new Error('useGlobalModal must be used within GlobalModalProvider');
  }
  return context;
}
