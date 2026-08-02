using System;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Colour conversion for the native video path.
///
/// Gate B locked this code: whatever shape the decoder hands back
/// (I420 planar, packed BGR24, or packed BGRA32), it lands here and comes out
/// as tightly-packed BGRA32 — the one format WPF's Bgra32
/// <c>WriteableBitmap</c> and the D3D9 A8R8G8B8 surface both consume without
/// another copy.
///
/// The "orange stays orange" gate lives on the I420 path: the BT.601 limited
/// range coefficients below are the ones proven by Spike 1. Do NOT swap them
/// for BT.709 or full-range without re-running the spike — that is exactly the
/// change that turns orange into red-brown.
/// </summary>
public static class FrameConvert
{
    public enum Shape { Unknown, I420, Bgr24, Bgra32 }

    /// <summary>Infer the decoder output layout from the sample length.</summary>
    public static Shape Classify(int sampleLength, int width, int height)
    {
        if (width <= 0 || height <= 0) return Shape.Unknown;
        long px = (long)width * height;
        if (sampleLength == px * 4) return Shape.Bgra32;
        if (sampleLength == px * 3) return Shape.Bgr24;
        if (sampleLength == px * 3 / 2) return Shape.I420;
        return Shape.Unknown;
    }

    /// <summary>
    /// Convert into <paramref name="dst"/> (must be width*height*4 bytes).
    /// Returns false when the sample shape is not recognised — the caller drops
    /// the frame and logs rather than presenting garbage.
    /// </summary>
    public static bool ToBgra32(byte[] src, int width, int height, byte[] dst)
    {
        if (src == null || dst == null) return false;
        long need = (long)width * height * 4;
        if (dst.LongLength < need) return false;

        switch (Classify(src.Length, width, height))
        {
            case Shape.Bgra32:
                Buffer.BlockCopy(src, 0, dst, 0, (int)need);
                return true;
            case Shape.Bgr24:
                Bgr24ToBgra32(src, width, height, dst);
                return true;
            case Shape.I420:
                I420ToBgra32(src, width, height, dst);
                return true;
            default:
                return false;
        }
    }

    private static void Bgr24ToBgra32(byte[] src, int width, int height, byte[] dst)
    {
        int n = width * height;
        int s = 0, d = 0;
        for (int i = 0; i < n; i++)
        {
            dst[d++] = src[s++];   // B
            dst[d++] = src[s++];   // G
            dst[d++] = src[s++];   // R
            dst[d++] = 255;        // A (opaque — the remote desktop has no alpha)
        }
    }

    /// <summary>
    /// I420 (planar Y, then U, then V at half resolution) → BGRA32.
    /// BT.601 limited range, the format libvpx/SIPSorcery emit for VP8.
    /// </summary>
    public static void I420ToBgra32(byte[] src, int width, int height, byte[] dst)
    {
        int ySize = width * height;
        int cw = (width + 1) / 2;
        int ch = (height + 1) / 2;
        int uOff = ySize;
        int vOff = ySize + cw * ch;

        for (int y = 0; y < height; y++)
        {
            int yRow = y * width;
            int cRow = (y >> 1) * cw;
            int d = yRow * 4;
            for (int x = 0; x < width; x++)
            {
                int c = src[yRow + x] - 16;
                if (c < 0) c = 0;
                int cx = x >> 1;
                int u = src[uOff + cRow + cx] - 128;
                int v = src[vOff + cRow + cx] - 128;

                int y298 = 298 * c;
                int r = (y298 + 409 * v + 128) >> 8;
                int g = (y298 - 100 * u - 208 * v + 128) >> 8;
                int b = (y298 + 516 * u + 128) >> 8;

                dst[d++] = Clamp8(b);
                dst[d++] = Clamp8(g);
                dst[d++] = Clamp8(r);
                dst[d++] = 255;
            }
        }
    }

    private static byte Clamp8(int v) => v < 0 ? (byte)0 : v > 255 ? (byte)255 : (byte)v;
}
