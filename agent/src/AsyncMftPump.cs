using System;

namespace ConnectLive.Agent;

internal enum AsyncMftEvent { None, NeedInput, HaveOutput, Other, Error }

/// <summary>
/// One NeedInput event is one input credit, including events received after
/// this call already submitted its frame. Credits belong to the transform,
/// not to a single Encode call. No waiting/spinning on an empty event queue.
/// </summary>
internal sealed class AsyncMftPump
{
    internal int PendingInputs { get; private set; }

    internal bool Step(Func<AsyncMftEvent> nextEvent, Func<bool> submit,
        Func<bool> collectOutput, Func<bool> hasOutput)
    {
        bool submitted = false;
        // Bound a misbehaving event producer; leave unread events queued.
        for (int count = 0; count < 64; count++)
        {
            if (!submitted && PendingInputs > 0)
            {
                if (!submit()) return false;
                PendingInputs--;
                submitted = true;
            }
            // Return exactly one access unit, not several frames concatenated
            // under a single RTP timestamp. The next call drains the next event.
            if (hasOutput()) return true;
            switch (nextEvent())
            {
                case AsyncMftEvent.None: return true;
                case AsyncMftEvent.NeedInput:
                    if (PendingInputs >= 256) return false;
                    PendingInputs++;
                    break;
                case AsyncMftEvent.HaveOutput:
                    if (!collectOutput()) return false;
                    break;
                case AsyncMftEvent.Error: return false;
            }
        }
        return true;
    }
}
