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
    public enum Shape { Unknown, I420, Nv12, Bgr24, Bgra32 }

    /// <summary>
    /// Infer the decoder output layout from the sample length.
    ///
    /// S16 — this used to demand an EXACT byte count, so any decoder build that
    /// hands back row-padded output (stride &gt; width*bpp, which several libvpx
    /// wrappers do) failed on every single frame: the pipeline dropped 100% of
    /// frames, never presented anything, and the only symptom the technician saw
    /// was "video never started". Padding is now tolerated — the stride is
    /// derived from the sample length — and the packed-planar case can be read
    /// as either I420 or NV12 (see <paramref name="chroma"/>).
    /// </summary>
    public static Shape Classify(int sampleLength, int width, int height, Shape chroma = Shape.I420)
    {
        if (width <= 0 || height <= 0 || sampleLength <= 0) return Shape.Unknown;
        long px = (long)width * height;

        if (sampleLength == px * 4) return Shape.Bgra32;
        if (sampleLength == px * 3) return Shape.Bgr24;
        if (sampleLength == px * 3 / 2) return chroma == Shape.Nv12 ? Shape.Nv12 : Shape.I420;

        // Row-padded packed formats: length is an exact multiple of the height
        // and each row holds at least width pixels.
        if (sampleLength % height == 0)
        {
            int stride = sampleLength / height;
            if (stride >= width * 4) return Shape.Bgra32;
            if (stride >= width * 3) return Shape.Bgr24;
        }

        // Padded planar: luma plane is stride*height, chroma adds half again.
        int planar = sampleLength * 2 / 3;
        if (planar >= px && planar % height == 0 && planar / height >= width)
            return chroma == Shape.Nv12 ? Shape.Nv12 : Shape.I420;

        return Shape.Unknown;
    }

    /// <summary>Human-readable geometry for the diagnostic log when nothing matches.</summary>
    public static string Describe(int sampleLength, int width, int height)
    {
        long px = (long)width * height;
        string mod = height > 0 && sampleLength % height == 0
            ? $", stride={sampleLength / height}"
            : ", not row-aligned";
        return $"{sampleLength} bytes for {width}x{height} (bgra32 wants {px * 4}, " +
               $"bgr24 {px * 3}, i420/nv12 {px * 3 / 2}{mod})";
    }

    /// <summary>
    /// Convert into <paramref name="dst"/> (must be width*height*4 bytes).
    /// Returns false when the sample shape is not recognised — the caller drops
    /// the frame and logs rather than presenting garbage.
    /// </summary>
    public static bool ToBgra32(byte[] src, int width, int height, byte[] dst, Shape chroma = Shape.I420)
    {
        if (src == null || dst == null || width <= 0 || height <= 0) return false;
        long need = (long)width * height * 4;
        if (dst.LongLength < need) return false;

        switch (Classify(src.Length, width, height, chroma))
        {
            case Shape.Bgra32:
                CopyBgra32(src, width, height, dst);
                return true;
            case Shape.Bgr24:
                Bgr24ToBgra32(src, width, height, dst);
                return true;
            case Shape.I420:
                I420ToBgra32(src, width, height, dst);
                return true;
            case Shape.Nv12:
                Nv12ToBgra32(src, width, height, dst);
                return true;
            default:
                return false;
        }
    }

    /// <summary>Packed or row-padded BGRA32 → tightly packed BGRA32.</summary>
    private static void CopyBgra32(byte[] src, int width, int height, byte[] dst)
    {
        int rowBytes = width * 4;
        int stride = src.Length / height;
        if (stride == rowBytes) { Buffer.BlockCopy(src, 0, dst, 0, rowBytes * height); return; }
        for (int y = 0; y < height; y++)
            Buffer.BlockCopy(src, y * stride, dst, y * rowBytes, rowBytes);
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
