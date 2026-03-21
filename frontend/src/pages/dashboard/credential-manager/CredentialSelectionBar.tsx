import { Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

interface CredentialSelectionBarProps {
    t: TFunction;
    selectedCount: number;
    isArchiveBusy: boolean;
    isDeletingSelection: boolean;
    onArchiveSelected: () => void;
    onBatchDelete: () => void;
}

export default function CredentialSelectionBar({
    t,
    selectedCount,
    isArchiveBusy,
    isDeletingSelection,
    onArchiveSelected,
    onBatchDelete,
}: CredentialSelectionBarProps) {
    if (selectedCount === 0) return null;

    return (
        <div className="flex items-center justify-between rounded-lg bg-primary/10 border border-primary/20 px-4 py-3 animate-in fade-in slide-in-from-top-4">
            <div className="text-sm font-medium text-primary">
                {selectedCount} {t('items selected')}
            </div>
            <button
                onClick={onArchiveSelected}
                disabled={isArchiveBusy || selectedCount === 0}
                className="inline-flex items-center justify-center rounded-md border border-input bg-transparent h-8 px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
                归档选中
            </button>
            <button
                onClick={onBatchDelete}
                disabled={isDeletingSelection || selectedCount === 0}
                className="inline-flex items-center justify-center rounded-md border border-destructive bg-destructive text-destructive-foreground h-8 px-3 text-xs font-medium hover:bg-destructive/90"
            >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                {t('Delete Selected')}
            </button>
        </div>
    );
}
