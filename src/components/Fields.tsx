import type { Summary } from '../../backtest/engine';

export const pct = (v: number, digits = 3) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
export const share = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

export function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  suffix,
  disabled,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
  step: number;
  min: number;
  suffix: string;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? 'field is-off' : 'field'}>
      <span>{label}</span>
      <span className="field-input">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          step={step}
          min={min}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= min) onChange(v);
          }}
        />
        {suffix}
      </span>
    </label>
  );
}

/** Headline figures for one set of trades; `excess` is omitted where there is no benchmark. */
export function Stats({ s, excess }: { s: Summary; excess?: number }) {
  return (
    <dl className="stats">
      <div>
        <dt>筆數</dt>
        <dd>{s.n}</dd>
      </div>
      <div>
        <dt>平均淨報酬</dt>
        <dd>
          <strong>{pct(s.netMean)}</strong>
        </dd>
      </div>
      <div>
        <dt>95% 信賴區間</dt>
        <dd>
          {pct(s.ci.lo)} 至 {pct(s.ci.hi)}
        </dd>
      </div>
      <div>
        <dt>勝率</dt>
        <dd>{share(s.winRate)}</dd>
      </div>
      <div>
        <dt>平均毛報酬</dt>
        <dd>{pct(s.grossMean)}</dd>
      </div>
      {excess !== undefined && (
        <div>
          <dt>相對任意進場</dt>
          <dd>{pct(excess)}</dd>
        </div>
      )}
    </dl>
  );
}

export function VerdictLine({ verdict }: { verdict: Summary['verdict'] }) {
  const kind = verdict === '有效' ? 'pass' : verdict === '無效' ? 'fail' : 'none';
  return (
    <p className={`verdict is-${kind}`}>
      <span aria-hidden="true">{kind === 'pass' ? '●' : kind === 'fail' ? '✕' : '–'}</span> 判定：{verdict}
    </p>
  );
}
