import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { Card, CardHeader } from '../ui';
import { getEventConfig, formatEventLabel } from '../../utils/eventConfig';

// Tipo flexible para actividades del sistema
export interface SystemActivity {
  id: string | number;
  orderNumber: string | null;
  accion: string;
  timestamp: string;
  performedBy: string | null;
}

interface ActivityFeedProps {
  activities: SystemActivity[];
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  return (
    <Card padding="none" className="h-full">
      <div className="p-5 border-b border-neutral-100">
        <CardHeader title="Actividad Reciente" description="Últimas operaciones del sistema" />
      </div>
      <div className="divide-y divide-neutral-100 max-h-[400px] overflow-y-auto">
        {activities.length === 0 ? (
          <div className="px-5 py-8 text-center text-neutral-400 text-sm">
            No hay actividad reciente
          </div>
        ) : (
          activities.map((activity) => {
            const config = getEventConfig(activity.accion);
            return (
              <div key={activity.id} className="px-5 py-4 hover:bg-neutral-50/50 transition-colors">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 ${config.color}`}
                  >
                    <span className="text-sm">{config.emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900">
                        {activity.orderNumber ? `#${activity.orderNumber}` : 'Sistema'}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true, locale: es })}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-neutral-600">
                      {formatEventLabel(activity.accion)}
                    </p>
                    {activity.performedBy && (
                      <p className="mt-1 text-xs text-neutral-400">por {activity.performedBy}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
