// Compile the real UI orchestration in a portable assembly. These deliberately
// inert platform contracts do not certify WPF, privacy APIs or Win32 behavior.
using System;
using System.Collections.Generic;
namespace System.Windows {
    public enum WindowStyle { ToolWindow }
    public enum ResizeMode { NoResize }
    public enum WindowStartupLocation { CenterScreen }
    public enum SizeToContent { Height,WidthAndHeight }
    public enum TextWrapping { Wrap }
    public enum HorizontalAlignment { Right,Left,Center,Stretch }
    public struct Thickness { public Thickness(double value){} public Thickness(double a,double b,double c,double d){} }
    public static class FontWeights { public static object Bold=>new(); }
    public class FrameworkElement {
        public Thickness Margin {get;set;} public bool IsEnabled {get;set;}=true;
        public HorizontalAlignment HorizontalAlignment {get;set;}
    }
    public class Window:FrameworkElement {
        public string Title {get;set;}=""; public double Width{get;set;} public double Height{get;set;}
        public double MaxHeight{get;set;} public object? Content{get;set;}
        public bool Topmost{get;set;} public bool ShowInTaskbar{get;set;}
        public object? Background{get;set;} public object? Foreground{get;set;}
        public WindowStyle WindowStyle{get;set;} public ResizeMode ResizeMode{get;set;}
        public WindowStartupLocation WindowStartupLocation{get;set;} public SizeToContent SizeToContent{get;set;}
        public event EventHandler? SourceInitialized; public event EventHandler? Closed; public event EventHandler? Loaded;
        public event System.ComponentModel.CancelEventHandler? Closing;
        public Threading.Dispatcher Dispatcher {get;}=new();
        public void Show(){} public bool? ShowDialog()=>false; public void Close(){}
    }
    public class Application { public static Application Current {get;}=new(); public Threading.Dispatcher Dispatcher{get;}=new(); }
}
namespace System.Windows.Threading {
    public class Dispatcher { public void Invoke(Action action)=>action(); public object BeginInvoke(Action action)=>new(); }
    public class DispatcherTimer {
        public TimeSpan Interval{get;set;} public event EventHandler? Tick; public void Start(){} public void Stop(){}
    }
}
namespace System.Windows.Controls {
    public class Control:System.Windows.FrameworkElement {
        public object? Content{get;set;} public Thickness Padding{get;set;} public double Width{get;set;} public double Height{get;set;}
        public object? Background{get;set;} public object? Foreground{get;set;} public double FontSize{get;set;}
        public object? FontWeight{get;set;}
    }
    public class Panel:Control { public List<System.Windows.FrameworkElement> Children{get;}=new(); }
    public class StackPanel:Panel {}
    public class TextBlock:Control { public string Text{get;set;}=""; public TextWrapping TextWrapping{get;set;} }
    public class Button:Control { public event EventHandler? Click; }
    public class CheckBox:Control { public bool? IsChecked{get;set;} }
    public class ListBox:Control { public object? ItemsSource{get;set;} public object? SelectedItem{get;set;} public string DisplayMemberPath{get;set;}=""; }
    public class PasswordBox:Control {
        public int MaxLength{get;set;} public System.Security.SecureString SecurePassword=>new();
        public List<Input.CommandBinding> CommandBindings{get;}=new(); public void Clear(){}
    }
    public class ScrollViewer:Control {}
}
namespace System.Windows.Media {
    public static class Brushes { public static object White=>new(); }
    public struct Color { public static Color FromRgb(byte r,byte g,byte b)=>new(); }
    public class SolidColorBrush(Color color) {}
}
namespace System.Windows.Input {
    public static class ApplicationCommands { public static object Copy=>new(); public static object Cut=>new(); public static object Paste=>new(); }
    public class ExecutedRoutedEventArgs:EventArgs { public bool Handled{get;set;} }
    public class CommandBinding(object command,Action<object,ExecutedRoutedEventArgs> handler) {}
}
namespace System.Windows.Interop {
    public class WindowInteropHelper(System.Windows.Window window) { public IntPtr Handle=>IntPtr.Zero; }
    public delegate IntPtr HwndSourceHook(IntPtr hwnd,int msg,IntPtr wParam,IntPtr lParam,ref bool handled);
    public class HwndSource { public static HwndSource? FromHwnd(IntPtr hwnd)=>null; public void AddHook(HwndSourceHook hook){} public void RemoveHook(HwndSourceHook hook){} }
}
namespace System.Windows.Forms {
    public enum DialogResult { OK,Cancel }
    public class FolderBrowserDialog:IDisposable {
        public string Description{get;set;}=""; public bool UseDescriptionForTitle{get;set;}
        public string SelectedPath{get;set;}=""; public DialogResult ShowDialog()=>DialogResult.Cancel; public void Dispose(){}
    }
}
