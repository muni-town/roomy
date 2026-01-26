import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

// OTLPTraceExporter automatically reads:
// - OTEL_EXPORTER_OTLP_ENDPOINT (e.g., https://otlp-gateway-prod-us-central-0.grafana.net/otlp)
// - OTEL_EXPORTER_OTLP_HEADERS (e.g., "Authorization=Basic <base64>")
// If not set, exporter silently no-ops - bridge still runs without tracing.

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "roomy-discord-bridge",
  }),
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
});

sdk.start();
