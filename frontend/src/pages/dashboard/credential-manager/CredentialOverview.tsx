import type { TFunction } from 'i18next';

interface CredentialOverviewProps {
  t: TFunction;
  available: number;
  error: number;
  limited: number;
  total: number;
  unavailable?: boolean;
}

export default function CredentialOverview({
  t,
  available,
  error,
  limited,
  total,
  unavailable = false,
}: CredentialOverviewProps) {
  const cards = [
    {
      label: t('Available'),
      description: t('Currently schedulable'),
      value: available,
      accentClass: 'bg-emerald-400',
      dotClass: 'bg-emerald-400 ring-emerald-400/20',
      valueClass: 'text-emerald-500 dark:text-emerald-400',
    },
    {
      label: t('Errors'),
      description: t('Abnormal or disabled credentials'),
      value: error,
      accentClass: 'bg-rose-400',
      dotClass: 'bg-rose-400 ring-rose-400/20',
      valueClass: 'text-rose-500 dark:text-rose-400',
    },
    {
      label: t('Limited'),
      description: t('Cooling down or restricted'),
      value: limited,
      accentClass: 'bg-amber-400',
      dotClass: 'bg-amber-400 ring-amber-400/20',
      valueClass: 'text-amber-500 dark:text-amber-300',
    },
    {
      label: t('Total'),
      description: t('Credential capacity'),
      value: total,
      accentClass: 'bg-blue-400',
      dotClass: 'bg-blue-400 ring-blue-400/20',
      valueClass: 'text-foreground',
    },
  ];

  return (
    <section
      aria-label={t('Credential Overview')}
      aria-busy={unavailable}
      className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-4"
    >
      {cards.map((card) => (
        <article
          key={card.label}
          className="relative min-h-[138px] min-w-0 overflow-hidden rounded-2xl border border-border bg-card px-4 py-4 shadow-sm sm:min-h-[150px] sm:px-6 sm:py-5"
        >
          <div className={`absolute inset-x-0 top-0 h-0.5 ${card.accentClass}`} aria-hidden="true" />
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground sm:text-base">{card.label}</h3>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ${card.dotClass}`} aria-hidden="true" />
          </div>
          <div className={`mt-4 text-3xl font-semibold leading-none tracking-tight tabular-nums min-[420px]:text-4xl sm:text-5xl ${card.valueClass}`}>
            {unavailable ? '—' : card.value.toLocaleString()}
          </div>
          <p className="mt-2 text-xs text-muted-foreground sm:text-sm">{card.description}</p>
        </article>
      ))}
    </section>
  );
}
