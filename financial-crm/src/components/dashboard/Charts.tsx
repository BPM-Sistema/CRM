import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader } from '../ui';

interface ChartData {
  date: string;
  paid: number;
  pending: number;
  rejected: number;
  total: number;
}

interface StatusDistributionChartProps {
  data: ChartData[];
}

export function StatusDistributionChart({ data }: StatusDistributionChartProps) {
  const latestData = data[data.length - 1];
  const chartData = [
    { name: 'Pagados', value: latestData.paid, fill: '#10b981' },
    { name: 'Pendientes', value: latestData.pending, fill: '#f59e0b' },
    { name: 'Rechazados', value: latestData.rejected, fill: '#ef4444' },
  ];

  return (
    <Card className="h-full">
      <CardHeader title="Estado de Hoy" description="Distribución de pedidos por estado" />
      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 12, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 12, fill: '#6b7280' }}
              tickLine={false}
              axisLine={false}
              width={80}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: '12px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)',
              }}
            />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
