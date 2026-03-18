import { NotificationBell } from '../ui';

interface HeaderProps {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-neutral-100">
      <div className="flex items-center justify-between h-14 md:h-16 px-4 md:px-6">
        <div className="flex flex-col min-w-0">
          <h1 className="text-lg md:text-xl font-semibold text-neutral-900 truncate">{title}</h1>
          {subtitle && (
            <p className="text-sm text-neutral-500">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
          <NotificationBell />
          {actions}
        </div>
      </div>
    </header>
  );
}
