using System;
using System.Text;
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
///   * the datachannel is used only while it is genuinely open; one send
///     failure demotes the session to REST for the rest of it (no per-event
///     coin flip that would reorder the stream);
///   * safety kinds — <c>curtain_off</c>, <c>release_inputs</c> — never ride
///     the channel. They must land even when media is broken, which is
///     exactly when the channel is untrustworthy;
///   * wire shapes are identical on both paths: <c>{ kind, ...payload }</c>,
///     matching the switch in agent/src/InputRelay.cs.
/// </summary>
public static class InputTransport
{
    /// <summary>Kinds that must always take the REST path. See class