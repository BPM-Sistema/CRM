import { NotificationBell, PendingShippingDataBadge } from '../ui';

interface HeaderProps {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-neutral-100">
      <div className="flex items-center justify-between px-3 md:px-6 py-2 md:py-0 md:h-16 gap-2">
        <div className="flex flex-col min-w-0">
          <h1 className="text-base md:text-xl font-semibold text-neutral-900 truncate">{title}</h1>
          {subtitle && (
            <p className="text-[11px] md:text-sm text-neutral-500 truncate">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 md:gap-4 flex-shrink-0">
          <NotificationBell />
          <PendingShippingDataBadge />
          <div className="hidden md:contents">
            {actions}
          </div>
        </div>
      </div>
      {actions && (
        <div className="md:hidden overflow-x-auto px-3 pb-2 flex items-center gap-1.5 scrollbar-hide">
          {actions}
        </div>
      )}
    </header>
  );
}
