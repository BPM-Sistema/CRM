import { Bell } from 'lucide-react';

interface HeaderProps {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-neutral-100">
      <div className="flex items-center justify-between h-16 px-6">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>
          {subtitle && (
            <p className="text-sm text-neutral-500">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-4">
          <button className="relative p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors">
            <Bell size={20} />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white" />
          </button>

          {actions}
        </div>
      </div>
    </header>
  );
}
