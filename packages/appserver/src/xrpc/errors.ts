export class XrpcError extends Error {
  constructor(
    public readonly status: number,
    public readonly xrpcError: string,
    message: string,
  ) {
    super(message);
    this.name = "XrpcError";
  }
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof XrpcError) {
    return Response.json(
      { error: err.xrpcError, message: err.message },
      { status: err.status },
    );
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  return Response.json({ error: "InternalServerError", message }, { status: 500 });
}
