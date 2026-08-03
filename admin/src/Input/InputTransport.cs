using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Admin.Diag;

namespace ConnectLive.Admin.Input;

/// <summary>
/// S10 — input over the WebRTC datachannel, with the REST queue as the
/// guaranteed fallback.
///
/// The agent already accepts input on an <c>input</c> datachannel
/// (agent/src/WebRtcSession.cs → <c>ondatachannel</c> → <c>InputRelay.Apply</c>);
/// until now the native console never opened one, so every click and every
/// mouse delta paid an HTTPS round trip to a peer we already hold an SRTP
/// tunnel with.
///
/// Rules:
///   * the channel is used only while it is genuinely open; a single send
///     failure demotes the session to REST for good, so the stream can never
///     interleave two transports with different latencies and reorder itself;
///   * safety kinds — <c>curtain_off</c>, <c>release_inputs</c> — always take
///     REST. They must land precisely when media