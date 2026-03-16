import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

interface KPIItem {
  label: string;
  value: number | string;
  color?: 'green' | 'yellow' | 'red' | 'blue' | 'neutral' | 'violet' | 'amber';
  navigateTo?: string;
}

interface KPISectionProps {
  title: string;
  icon: ReactNode;
  iconBgColor: string;
  kpis: KPIItem[];
}

const colorMap: Record<string, string> = {
  green: 'text-emerald-600',
  yellow: 'text-amber-600',
  red: 'text-red-600',
  blue: 'text-blue-600',
  neutral: 'text-neutral-900',
  violet: 'text-violet-600',
  amber: 'text-amber-600',
};

export function KPISection({ title, icon, iconBgColor, kpis }: KPISectionProps) {
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-2xl border border-neutral-200/60 p-5 shadow-soft">
      <div className="flex items-center gap-3 mb-4">
        <div className={`flex items-center justify-center w-9 h-9 rounded-xl ${iconBgColor}`}>
          {icon}
        </div>
        <h3 className="text-base font-semibold text-neutral-900">{title}</h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        {kpis.map((kpi, index) => (
          <button
            key={index}
            onClick={() => kpi.navigateTo && navigate(kpi.navigateTo)}
            disabled={!kpi.navigateTo}
            className={`flex flex-col items-start p-3 rounded-xl transition-colors ${
              kpi.navigateTo
                ? 'hover:bg-neutral-50 cursor-pointer'
                : 'cursor-default'
            }`}
          >
            <span className={`text-2xl font-bold ${colorMap[kpi.color || 'neutral']}`}>
              {typeof kpi.value === 'number' && kpi.value > 999999
                ? new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(kpi.value)
                : typeof kpi.value === 'number' && kpi.value > 999
                ? new Intl.NumberFormat('es-AR').format(kpi.value)
                : kpi.value}
            </span>
            <span className="text-xs text-neutral-500 mt-0.5">{kpi.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
