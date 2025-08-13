import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "roomy-discord-bridge",
  }),
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: "http://localhost:8910/api/default/v1/traces",
      headers: {
        Authorization: `Basic emlja2xhZ0BrYXRoYXJvc3RlY2guY29tOmFhZlRJM05Ja0t6UGJ2SFo=`,
        "stream-name": "default",
      },
    }),
  ),
});

sdk.start();
