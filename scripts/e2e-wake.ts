/**
 * End-to-end wake test.
 *
 *   1. Enroll a target device + heartbeat.
 *   2. Open an SSE stream as that device's Updater.
 *   3. Enqueue a `wake_agent` power command carrying the session to rejoin
 *      (same shape as the admin Reconnect / Wake button).
 *   4. Assert the SSE listener receives the wake within seconds.
 *   5. Simulate the Updater relaunching the agent: heartbeat → session invite,
 *      then ack the command → state `delivered`.
 *   6. Assert the woken agent JOINS the requested session.
 *   7. Second pass with no requested session → assert a NEW session is served.
 *   8. Assert staged Wake-on-LAN failure reporting when no LAN peer is online.
 *
 *   Run: API_BASE=https://zoomlite.live bun scripts/e2e-wake.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.API_BASE || "http://localhost:8080";
const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE