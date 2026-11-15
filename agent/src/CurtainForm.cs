using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// One physical-display notice. GDI painting plus constant alpha, never WPF's
/// per-pixel UpdateLayeredWindow surface. No input handling or control authority.
/// </summary>
internal sealed class CurtainForm : Form, ICurtainSurface
{
    private const string Heading = "ConnectLive · maintenance in progress";
    private const string Notice = "Your IT administrator is performing maintenance on this computer.";
    private const string Recovery = "Local keyboard and mouse input is temporarily paused. Press Ctrl + Alt + Shift + Esc to stop remote access. Windows Ctrl + Alt + Del remains available.";
    private readonly Rectangle _displayBounds;
    private readonly TaskCompletionSource<bool> _rendered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IntPtr _preparedHandle;

    internal CurtainForm(Rectangle bounds)
    {
        _displayBounds = bounds;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        AutoScaleMode = AutoScaleMode.None;
        DoubleBuffered = true;
        BackColor = Color.FromArgb(8, 12, 24);
        Text = "ConnectLive maintenance";
        AccessibleName = Heading;
        TabStop = false;
        SetStyle(ControlStyles.Selectable, false);
        // All properties that might recreate the HWND are set before creation.
        Bounds = bounds;
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= CurtainNative.RequiredExStyles;
            return parameters;
        }
    }

    Task ICurtainSurface.Rendered => _rendered.Task;
    bool ICurtainSurface.IsVisible => IsHandleCreated && CurtainNative.IsWindowVisible(Handle);

    CurtainApplyResult ICurtainSurface.Prepare()
    {
        _preparedHandle = Handle; // Still hidden.
        var prepared = CurtainNative.Prepare(_preparedHandle);
        return prepared.Applied ? CurtainNative.Place(_preparedHandle, _displayBounds) : prepared;
    }

    CurtainApplyResult ICurtainSurface.ShowAndRender()
    {
        if (!HasPreparedHandle) return CurtainApplyResult.Failed("display_unavailable");
        var verified = CurtainNative.Verify(_preparedHandle);
        if (!verified.Applied) return verified;
        Show();
        if (!HasPreparedHandle) return CurtainApplyResult.Failed("display_unavailable");
        // Native pixels, including negative monitor origins; no WPF DIP conversion.
        var placed = CurtainNative.Place(_preparedHandle, _displayBounds);
        if (!placed.Applied) return placed;
        Invalidate();
        Update(); // Real WM_PAINT; completion is signalled only after drawing.
        return CurtainApplyResult.Success;
    }

    CurtainApplyResult ICurtainSurface.VerifyAfterRender()
    {
        if (!HasPreparedHandle || !CurtainNative.IsWindowVisible(_preparedHandle))
            return CurtainApplyResult.Failed("display_unavailable");
        var composed = CurtainNative.FlushComposition();
        if (!composed.Applied) return composed;
        var verified = CurtainNative.Verify(_preparedHandle);
        return verified.Applied ? CurtainNative.VerifyBounds(_preparedHandle, _displayBounds) : verified;
    }

    private bool HasPreparedHandle => !IsDisposed && IsHandleCreated &&
        _preparedHandle != IntPtr.Zero && Handle == _preparedHandle;

    protected override void OnPaint(PaintEventArgs e)
    {
        try
        {
            base.OnPaint(e);
            if (ClientSize.Width != _displayBounds.Width || ClientSize.Height != _displayBounds.Height)
                return; // A layout-sized first paint does not confirm monitor coverage.
            DrawNotice(e.Graphics);
            _rendered.TrySetResult(true);
        }
        catch (Exception ex)
        {
            _rendered.TrySetException(ex);
        }
    }

    private void DrawNotice(Graphics graphics)
    {
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        float scale = Math.Max(1, DeviceDpi) / 96f;
        using var format = new StringFormat { Trimming = StringTrimming.None };
        // Preserve DPI sizing normally, but keep recovery instructions readable
        // instead of clipping them on a very small/high-DPI monitor.
        for (int attempt = 0; attempt < 8; attempt++)
        {
            float margin = 16 * scale, paddingX = 28 * scale, paddingY = 22 * scale;
            float width = Math.Min(520 * scale, ClientSize.Width - 2 * margin);
            float textWidth = width - 2 * paddingX;
            if (textWidth <= 0) { scale *= 0.5f; continue; }
            using var headingFont = new Font("Segoe UI Semibold", 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            using var noticeFont = new Font("Segoe UI Semibold", 18 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            using var recoveryFont = new Font("Segoe UI", 13 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            float headingHeight = graphics.MeasureString(Heading, headingFont, new SizeF(textWidth, 10000), format).Height;
            float noticeHeight = graphics.MeasureString(Notice, noticeFont, new SizeF(textWidth, 10000), format).Height;
            float recoveryHeight = graphics.MeasureString(Recovery, recoveryFont, new SizeF(textWidth, 10000), format).Height;
            float height = 2 * paddingY + headingHeight + noticeHeight + recoveryHeight + 18 * scale;
            if (height > ClientSize.Height - 2 * margin) { scale *= 0.75f; continue; }
            var card = new RectangleF((ClientSize.Width - width) / 2, (ClientSize.Height - height) / 2, width, height);
            using var path = RoundedRectangle(card, 14 * scale);
            using var background = new SolidBrush(Color.FromArgb(0x1F, 0x2A, 0x44));
            using var border = new Pen(Color.FromArgb(90, 0x4F, 0x7C, 0xFF), scale);
            graphics.FillPath(background, path);
            graphics.DrawPath(border, path);
            float left = card.Left + paddingX, top = card.Top + paddingY;
            using var headingBrush = new SolidBrush(Color.FromArgb(0xB9, 0xCC, 0xFF));
            using var recoveryBrush = new SolidBrush(Color.FromArgb(220, 255, 255, 255));
            graphics.DrawString(Heading, headingFont, headingBrush, new RectangleF(left, top, textWidth, headingHeight), format);
            top += headingHeight + 8 * scale;
            graphics.DrawString(Notice, noticeFont, Brushes.White, new RectangleF(left, top, textWidth, noticeHeight), format);
            top += noticeHeight + 10 * scale;
            graphics.DrawString(Recovery, recoveryFont, recoveryBrush, new RectangleF(left, top, textWidth, recoveryHeight), format);
            return;
        }
        throw new InvalidOperationException("The curtain notice does not fit this display.");
    }

    private static GraphicsPath RoundedRectangle(RectangleF rect, float radius)
    {
        var path = new GraphicsPath();
        float diameter = Math.Min(2 * radius, Math.Min(rect.Width, rect.Height));
        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _rendered.TrySetCanceled();
        base.Dispose(disposing);
    }
}
