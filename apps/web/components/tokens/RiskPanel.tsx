import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** One entry of Token.riskFlags (RiskReport.flags from @flowradar/core / @flowradar/providers). */
export interface RiskFlagRow {
  id: string;
  label: string;
  severity: 'info' | 'warn' | 'danger';
}

export interface RiskPanelProps {
  flags: RiskFlagRow[];
}

const SEVERITY_BADGE_CLASS: Record<RiskFlagRow['severity'], string> = {
  danger: 'border-transparent bg-red-500/15 text-red-400',
  warn: 'border-transparent bg-amber-500/15 text-amber-400',
  info: 'border-transparent bg-zinc-500/15 text-zinc-300',
};

/**
 * Risk flags panel (Token.riskFlags Json array) + two forward-looking empty
 * states per binding decision #7: Entity clusters (arrives Wave 3) and Alert
 * history (arrives Wave 2). Both empty states are unconditional for now —
 * neither EntityCluster-via-WalletTokenTrade.entityClusterId joins nor Alert
 * rows are wired into this task's query (page.tsx doesn't fetch them for
 * this panel), matching the brief's explicit "may be empty until Wave 3" /
 * "empty until Wave 2" framing.
 */
export function RiskPanel({ flags }: RiskPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Risk flags</CardTitle>
        </CardHeader>
        <CardContent>
          {flags.length === 0 ? (
            <p className="text-sm text-muted-foreground">No risk flags recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {flags.map((flag) => (
                <li key={flag.id} className="flex items-center gap-2">
                  <Badge className={SEVERITY_BADGE_CLASS[flag.severity]}>{flag.severity}</Badge>
                  <span className="text-sm">{flag.label}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entity clusters</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Entity clusters arrive in Wave 3.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alert history</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No alerts yet.</p>
        </CardContent>
      </Card>
    </div>
  );
}
