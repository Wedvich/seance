/**
 * Outbound HTTP as `startDaemon`, the leader and telemetry take it, so a test
 * above the unit tier can stand in for an endpoint. Not `typeof fetch`: Bun's
 * type carries `preconnect`, which no stand-in could satisfy without a cast.
 */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
