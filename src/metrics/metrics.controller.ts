import { Controller, Get, Header } from '@nestjs/common';
import { eventMetrics } from '@barfinex/utils';
import { renderIngressBackpressurePrometheusMetrics } from '@barfinex/detector';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  renderPrometheusMetrics(): string {
    return (
      eventMetrics.renderEventBusLatencyPrometheusMetric() +
      renderIngressBackpressurePrometheusMetrics()
    );
  }

  @Get('prometheus')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  renderPrometheusMetricsLegacyPath(): string {
    return (
      eventMetrics.renderEventBusLatencyPrometheusMetric() +
      renderIngressBackpressurePrometheusMetrics()
    );
  }
}
