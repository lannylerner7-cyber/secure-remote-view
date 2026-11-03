namespace ConnectLive.Agent;

/// <summary>Only physical modifier events feed this local stop gesture.</summary>
internal sealed class LocalEscapeGesture
{
    private int _modifiers;
    internal bool Feed(uint key, bool down, bool injected)
    {
        if (injected) return false;
        int bit = key switch {
            0x11 or 0xA2 => 1, 0xA3 => 2, // left/right Ctrl
            0x12 or 0xA4 => 4, 0xA5 => 8, // left/right Alt
            0x10 or 0xA0 => 16, 0xA1 => 32, // left/right Shift
            _ => 0
        };
        if (down) System.Threading.Interlocked.Or(ref _modifiers, bit);
        else System.Threading.Interlocked.And(ref _modifiers, ~bit);
        var held = System.Threading.Volatile.Read(ref _modifiers);
        return down && key == 0x1B && (held & 3) != 0 && (held & 12) != 0 && (held & 48) != 0;
    }
    internal void Reset() => System.Threading.Interlocked.Exchange(ref _modifiers, 0);
}
