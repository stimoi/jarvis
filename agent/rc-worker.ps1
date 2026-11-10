# Worker de contrôle à distance : processus PowerShell persistant (compile le C# une seule fois).
#   stdin  : commandes texte, une par ligne  (voir Handle)
#   stdout : trames binaires  [type:1 octet][longueur:4 octets LE][données]
#            type 1 = image JPEG de l'écran, type 2 = "largeur hauteur" de l'écran, type 3 = message d'erreur
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RC {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);

  static Queue<string> q = new Queue<string>();
  static object ql = new object();
  static Stream outS;

  static void Send(byte type, byte[] data) {
    lock (outS) {
      byte[] h = new byte[5];
      h[0] = type;
      BitConverter.GetBytes(data.Length).CopyTo(h, 1);
      outS.Write(h, 0, 5);
      outS.Write(data, 0, data.Length);
      outS.Flush();
    }
  }

  static bool Ext(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F; }
  static INPUT K(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Key(ushort vk, bool up) { uint f = (up ? 2u : 0u) | (Ext(vk) ? 1u : 0u); SendInput(1, new INPUT[] { K(vk, 0, f) }, Marshal.SizeOf(typeof(INPUT))); }
  static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x0D, false); Key(0x0D, true); continue; }
      if (c == '\t') { Key(0x09, false); Key(0x09, true); continue; }
      INPUT[] a = new INPUT[] { K(0, c, 4u), K(0, c, 6u) };
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }
  }
  static void Btn(string b, bool down) {
    uint f;
    if (b == "r") f = down ? 8u : 16u; else if (b == "m") f = down ? 32u : 64u; else f = down ? 2u : 4u;
    mouse_event(f, 0, 0, 0, IntPtr.Zero);
  }
  static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
  static double Num(string s) { return Double.Parse(s, CultureInfo.InvariantCulture); }

  static ImageCodecInfo Jpeg() {
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
    return null;
  }

  static byte[] Capture(int maxW, int quality, ImageCodecInfo codec) {
    try {
      int W = GetSystemMetrics(0), H = GetSystemMetrics(1);
      double s = Math.Min(1.0, (double)maxW / W);
      int ow = Math.Max(1, (int)(W * s)), oh = Math.Max(1, (int)(H * s));
      using (Bitmap full = new Bitmap(W, H, PixelFormat.Format32bppRgb)) {
        using (Graphics g = Graphics.FromImage(full)) { g.CopyFromScreen(0, 0, 0, 0, new Size(W, H)); }
        using (Bitmap o = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
          using (Graphics g2 = Graphics.FromImage(o)) {
            g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
            g2.DrawImage(full, 0, 0, ow, oh);
            POINT p;
            if (GetCursorPos(out p)) {
              float cx = (float)(p.X * s), cy = (float)(p.Y * s);
              PointF[] arrow = new PointF[] { new PointF(cx, cy), new PointF(cx, cy + 17), new PointF(cx + 4, cy + 13), new PointF(cx + 8, cy + 20), new PointF(cx + 11, cy + 19), new PointF(cx + 7, cy + 12), new PointF(cx + 12, cy + 12) };
              g2.FillPolygon(Brushes.White, arrow);
              using (Pen pen = new Pen(Color.Black, 1.5f)) { g2.DrawPolygon(pen, arrow); }
            }
          }
          using (MemoryStream ms = new MemoryStream()) {
            EncoderParameters ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            o.Save(ms, codec, ep);
            return ms.ToArray();
          }
        }
      }
    } catch (Exception) { return null; }
  }

  static bool Same(byte[] a, byte[] b) {
    if (a == null || b == null || a.Length != b.Length) return false;
    for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }

  public static void Run() {
    SetProcessDPIAware();
    outS = Console.OpenStandardOutput();
    Send(2, Encoding.UTF8.GetBytes(GetSystemMetrics(0) + " " + GetSystemMetrics(1)));
    Thread t = new Thread(delegate () {
      string l;
      while ((l = Console.In.ReadLine()) != null) { lock (ql) { q.Enqueue(l); } }
      lock (ql) { q.Enqueue("Q"); }
    });
    t.IsBackground = true;
    t.Start();

    bool cap = false; int fps = 5, maxW = 1000, quality = 55;
    byte[] prev = null;
    DateTime next = DateTime.MinValue;
    ImageCodecInfo codec = Jpeg();

    while (true) {
      string cmd = null;
      lock (ql) { if (q.Count > 0) cmd = q.Dequeue(); }
      if (cmd != null) {
        try {
          string[] a = cmd.Split(' ');
          if (a[0] == "Q") break;
          else if (a[0] == "C") {
            if (a[1] == "1") { cap = true; fps = Clamp(int.Parse(a[2]), 1, 15); maxW = Clamp(int.Parse(a[3]), 320, 2560); quality = Clamp(int.Parse(a[4]), 20, 90); prev = null; next = DateTime.MinValue; }
            else cap = false;
          }
          else if (a[0] == "M") {
            double x = Math.Max(0, Math.Min(1, Num(a[1]))), y = Math.Max(0, Math.Min(1, Num(a[2])));
            SetCursorPos((int)(x * (GetSystemMetrics(0) - 1)), (int)(y * (GetSystemMetrics(1) - 1)));
          }
          else if (a[0] == "D") Btn(a[1], true);
          else if (a[0] == "U") Btn(a[1], false);
          else if (a[0] == "S") mouse_event(0x800, 0, 0, Clamp(int.Parse(a[1]), -30, 30) * 120, IntPtr.Zero);
          else if (a[0] == "T") TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[1])));
          else if (a[0] == "K") Key((ushort)int.Parse(a[1]), a[2] == "u");
          else if (a[0] == "P") {
            string[] vs = a[1].Split(',');
            for (int i = 0; i < vs.Length; i++) Key((ushort)int.Parse(vs[i]), false);
            Thread.Sleep(15);
            for (int i = vs.Length - 1; i >= 0; i--) Key((ushort)int.Parse(vs[i]), true);
          }
        } catch (Exception e) { Send(3, Encoding.UTF8.GetBytes(e.Message)); }
        continue;
      }
      if (cap && DateTime.UtcNow >= next) {
        next = DateTime.UtcNow.AddMilliseconds(1000.0 / fps);
        byte[] f = Capture(maxW, quality, codec);
        if (f != null && !Same(f, prev)) { prev = f; Send(1, f); }
      } else {
        Thread.Sleep(2);
      }
    }
  }
}
'@
[RC]::Run()
