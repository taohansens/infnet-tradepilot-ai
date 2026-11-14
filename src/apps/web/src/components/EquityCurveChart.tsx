'use client';

import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, createChart, type UTCTimestamp } from 'lightweight-charts';
import type { EquityPointDto } from '@tradepilot/shared';
import { useAppTheme } from './ThemeProvider';

/**
 * Gráfico interativo de Curva de Capital (Equity Curve) com `lightweight-charts`,
 * seguindo o visual do `EquityCurvePanel` do Taometria (`SPEC-15`, `SPEC-18`).
 *
 * @spec SPEC-15
 * @spec SPEC-18
 * @rf RF-M2-2
 * @rnf RNF-2
 * @rnf RNF-23
 */
export default function EquityCurveChart({
  points,
}: {
  points: EquityPointDto[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useAppTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el || points.length === 0) return;

    const isDark = theme === 'dracula';
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 290,
      layout: {
        background: {
          type: ColorType.Solid,
          color: isDark ? '#282a36' : '#ffffff',
        },
        textColor: isDark ? '#f8f8f2' : '#0f172a',
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(68,71,90,0.45)' : '#e2e8f0' },
        horzLines: { color: isDark ? 'rgba(68,71,90,0.45)' : '#e2e8f0' },
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(98,114,164,0.35)' : '#cbd5e1',
      },
      timeScale: {
        borderColor: isDark ? 'rgba(98,114,164,0.35)' : '#cbd5e1',
        timeVisible: true,
      },
    });

    const lastVal = Number(points[points.length - 1]?.cumulative_pnl_brl ?? 0);
    const positive = lastVal >= 0;

    const series = chart.addSeries(AreaSeries, {
      lineColor: positive ? '#10b981' : '#ef4444',
      topColor: positive
        ? 'rgba(16, 185, 129, 0.34)'
        : 'rgba(239, 68, 68, 0.34)',
      bottomColor: positive
        ? 'rgba(16, 185, 129, 0.02)'
        : 'rgba(239, 68, 68, 0.02)',
      lineWidth: 2,
    });

    // Garante timestamps estritamente crescentes exigidos pelo lightweight-charts
    let prevTs = 0;
    const data = points.map((p) => {
      let ts = Math.floor(new Date(p.timestamp).getTime() / 1000);
      if (ts <= prevTs) ts = prevTs + 1;
      prevTs = ts;
      return {
        time: ts as UTCTimestamp,
        value: Number(p.cumulative_pnl_brl),
      };
    });

    series.setData(data);
    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [points, theme]);

  if (points.length === 0) {
    return (
      <div className="flex h-[290px] items-center justify-center rounded-2xl border border-dashed border-[var(--app-line)] text-sm text-[var(--app-muted)]">
        Importe seu extrato ou ative a base demonstrativa para visualizar a curva de capital.
      </div>
    );
  }

  return <div ref={containerRef} className="w-full overflow-hidden rounded-2xl" />;
}
