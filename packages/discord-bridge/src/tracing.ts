import { trace, SpanStatusCode, Span } from "@opentelemetry/api";

export const tracer = trace.getTracer("roomy-discord-bridge");

/**
 * Record an error on a span, setting status and exception details.
 */
export function recordError(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  if (error instanceof Error) {
    span.recordException(error);
  } else {
    span.setAttribute("error.message", String(error));
  }
}

/**
 * Set Discord-related attributes on a span.
 */
export function setDiscordAttrs(
  span: Span,
  ctx: {
    guildId?: bigint | string;
    channelId?: bigint | string;
    messageId?: bigint | string;
    userId?: bigint | string;
  },
): void {
  if (ctx.guildId) span.setAttribute("discord.guild.id", String(ctx.guildId));
  if (ctx.channelId) span.setAttribute("discord.channel.id", String(ctx.channelId));
  if (ctx.messageId) span.setAttribute("discord.message.id", String(ctx.messageId));
  if (ctx.userId) span.setAttribute("discord.user.id", String(ctx.userId));
}

/**
 * Set Roomy-related attributes on a span.
 */
export function setRoomyAttrs(
  span: Span,
  ctx: {
    spaceId?: string;
    roomId?: string;
    eventId?: string;
  },
): void {
  if (ctx.spaceId) span.setAttribute("roomy.space.id", ctx.spaceId);
  if (ctx.roomId) span.setAttribute("roomy.room.id", ctx.roomId);
  if (ctx.eventId) span.setAttribute("roomy.event.id", ctx.eventId);
}
