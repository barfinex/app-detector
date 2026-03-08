import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { eventMetrics } from '@barfinex/utils';
import { MetricsModule } from './metrics.module';

describe('MetricsController (smoke)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [MetricsModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns prometheus format with HELP/TYPE and gauge line', async () => {
    eventMetrics.logEventLatency('provider.candle.received', {
      eventId: 'event-1',
      traceId: 'trace-1',
      source: 'provider',
      timestamp: Date.now() - 50,
    });

    const response = await request(app.getHttpServer()).get('/metrics/prometheus').expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.text).toContain('# HELP event_bus_latency_ms Redis Event Bus latency in milliseconds');
    expect(response.text).toContain('# TYPE event_bus_latency_ms gauge');
    expect(response.text).toContain('# HELP event_trace_latency_ms End-to-end trace latency in milliseconds');
    expect(response.text).toContain('# TYPE event_trace_latency_ms gauge');
    expect(response.text).toMatch(
      /event_bus_latency_ms\{service="[^"]+",event_type="provider\.candle\.received",source="provider"\} [-]?\d+/,
    );
    expect(response.text).toMatch(
      /event_trace_latency_ms\{service="[^"]+",event_type="provider\.candle\.received",source="provider"\} [-]?\d+/,
    );
  });
});
