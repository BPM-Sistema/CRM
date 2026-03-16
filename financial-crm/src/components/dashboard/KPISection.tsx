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
  kpis: KPIItem[];
  navigateTo?: string;
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

export function KPISection({ title, icon, kpis, navigateTo }: KPISectionProps) {
  const navigate = useNavigate();

  return (
    <div
      className={`bg-white rounded-xl border border-neutral-200/60 p-4 shadow-soft ${navigateTo ? 'hover:border-neutral-300 cursor-pointer transition-colors' : ''}`}
      onClick={() => navigateTo && navigate(navigateTo)}
    >
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">{title}</h3>
      </div>
      <div className="flex items-end justify-between gap-2">
        {kpis.map((kpi, index) => (
          <button
            key={index}
            onClick={(e) => {
              if (kpi.navigateTo) {
                e.stopPropagation();
                navigate(kpi.navigateTo);
              }
            }}
            className={`flex-1 flex flex-col items-center p-2 rounded-lg transition-colors ${
              kpi.navigateTo ? 'hover:bg-neutral-50 cursor-pointer' : 'cursor-default'
            }`}
          >
            <span className={`text-xl font-bold ${colorMap[kpi.color || 'neutral']}`}>
              {typeof kpi.value === 'number' && kpi.value > 999999
                ? new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(kpi.value)
                : typeof kpi.value === 'number' && kpi.value > 999
                ? new Intl.NumberFormat('es-AR').format(kpi.value)
                : kpi.value}
            </span>
            <span className="text-[10px] text-neutral-400 mt-0.5 text-center leading-tight">{kpi.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
