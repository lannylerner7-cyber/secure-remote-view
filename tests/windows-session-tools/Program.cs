using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ConnectLive.Agent;

internal static class Program
{
    private static int _checks;
    private static void Check(bool value, string label) { if (!value) throw new Exception(label); _checks++; }
    private static void Reject(Action action, string label)
    {
        try { action(); } catch { _checks++; return; }
        throw new Exception(label);
    }
    private static void Main(string[] args)
    {
        if (args.Length > 0)
        {
            foreach (var type in new[] { typeof(SIPSorcery.Net.RTCPSession), typeof(SIPSorcery.Net.RTCPCompoundPacket),
                typeof(SIPSorcery.Net.RTCPReceiverReport), typeof(SIPSorcery.Net.ReceptionReportSample) })
            {
                Console.WriteLine(type.FullName);
                foreach (var e in type.GetEvents()) Console.WriteLine(e.Name+" "+e.EventHandlerType);
                foreach (var f in type.GetFields())
                    Console.WriteLine(f.Name+" "+f.FieldType);
                foreach (var p in type.GetProperties())
                    Console.WriteLine(p.Name+" "+p.PropertyType);
            }
            return;
        }
        string folder = Path.Combine(Path.GetTempPath(), "connectlive-tools-" + Guid.NewGuid());
        Directory.CreateDirectory(folder);
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes("synthetic authorized file");
            string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            VerifiedFileInfo Info() => new(Guid.NewGuid().ToString(), "fixture.txt", bytes.Length, hash, "text/plain");
            var info = Info();
            using (var receive = new VerifiedFile(info, folder))
            {
                receive.Append(VerifiedFile.Encode(info.id,0,bytes,bytes.Length), () => true);
                string path = receive.Complete(1,hash,() => true);
                Check(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes), "complete bytes preserved");
            }
            using (var receive = new VerifiedFile(Info(),folder))
                Reject(() => receive.Complete(0,hash,() => true), "missing data cannot complete");
            info = Info();
            using (var receive = new VerifiedFile(info,folder))
                Reject(() => receive.Append(VerifiedFile.Encode(info.id,1,bytes,bytes.Length),() => true), "out of order rejected");
            info = Info();
            using (var receive = new VerifiedFile(info,folder))
            {
                var bad = (byte[])bytes.Clone(); bad[0] ^= 1;
                receive.Append(VerifiedFile.Encode(info.id,0,bad,bad.Length),() => true);
                Reject(() => receive.Complete(1,hash,() => true), "corruption rejected");
            }
            info = Info();
            using (var receive = new VerifiedFile(info,folder))
            {
                receive.Append(VerifiedFile.Encode(info.id,0,bytes,bytes.Length), () => true);
                Reject(() => receive.Complete(1,hash,() => false), "revoked at commit rejected");
            }
            Check(Directory.GetFiles(folder,"*.part").Length == 0, "partials removed locally");
            var budget = new SessionFileBudget();
            for (int i=0;i<10;i++) Check(budget.Reserve(Info() with {size=500L*1024*1024}), "quota reservation");
            Check(!budget.Reserve(Info() with {size=500L*1024*1024}), "5GiB cap");
            var duplicate = Info(); var fresh = new SessionFileBudget();
            Check(fresh.Reserve(duplicate) && !fresh.Reserve(duplicate), "no replay after uncertain send");
            var root = new ApprovedFolder("root", "Root",folder);
            File.WriteAllBytes(Path.Combine(folder,"chosen.txt"),bytes);
            using var browser = new RemoteFileAccess();
            var page = browser.List(root,"",null,() => true);
            Check(Array.Exists(page.entries,e=>e.name=="chosen.txt"), "real directory entries");
            var chosen = Array.Find(page.entries,e=>e.name=="chosen.txt")!;
            using (var read=RemoteFileAccess.Open(root,chosen.path,chosen.revision,chosen.size)) read.Validate();
            Reject(()=>RemoteFileAccess.Resolve(folder,"../outside"), "traversal");
            Reject(()=>RemoteFileAccess.Resolve(folder,"chosen.txt:secret"), "alternate stream");
            var outside = Path.Combine(Path.GetTempPath(),"outside-"+Guid.NewGuid()); Directory.CreateDirectory(outside);
            try {
                Directory.CreateSymbolicLink(Path.Combine(folder,"escape"),outside);
                Reject(()=>RemoteFileAccess.Resolve(folder,"escape"), "reparse escape");
            } finally { Directory.Delete(outside); }
            File.AppendAllText(Path.Combine(folder,"chosen.txt"),"changed");
            Reject(()=>RemoteFileAccess.Open(root,chosen.path,chosen.revision,chosen.size), "changed file rejected");
            long now=0; var lease=new MicrophoneLease(()=>now);
            var pendingGeneration=lease.Generation; lease.Stop();
            Check(!lease.Start("cancelled-pending",true,true,pendingGeneration),"Off invalidates a pending Listen request");
            Check(!lease.Start("a",false,true),"legacy grants never imply microphone");
            Check(lease.Start("a",true,true),"explicit microphone start");
            now=4000; Check(lease.RenewBrowser("a"),"same request browser renew");
            now=5001; Check(!lease.Allowed("a",true,true),"fresh heartbeat alone cannot extend mic authority");
            lease.Stop(); Check(!lease.RenewBrowser("a")&&!lease.Start("a",true,true),"no automatic replay");
            Check(lease.Start("b",true,true),"new explicit request");
            Check(!lease.Allowed("b",true,false),"disconnect blocks capture");
            Check(!lease.Allowed("b",false,true),"owner withdrawal blocks capture");
            Check(WindowsMicrophone.MuLaw(0)==255,"PCMU silence fixture");
            Check(MicrophoneEndpoint.IsMicrophoneFormFactor(4) && MicrophoneEndpoint.IsMicrophoneFormFactor(5),
                "Windows microphone and headset form factors");
            Check(!MicrophoneEndpoint.IsMicrophoneFormFactor(2) && !MicrophoneEndpoint.IsMicrophoneFormFactor(10),
                "line-level and unknown sources never become microphones");
            var gesture=new LocalEscapeGesture();
            gesture.Feed(0x11,true,false);gesture.Feed(0x12,true,false);gesture.Feed(0x10,true,false);
            Check(gesture.MicrophoneStop(0x4D,true,false),"physical microphone stop");
            Check(!gesture.MicrophoneStop(0x4D,true,true),"remote input cannot impersonate local stop");
            var owner=new object();Check(AppVerification.Begin(owner),"on-device bounded protection");
            AppVerification.End(new object()); Check(AppVerification.Active,"stale cancellation cannot end protection");
            AppVerification.End(owner);Check(!AppVerification.Active,"current cancellation releases only media guard");
            using var rsa=RSA.Create(3072); byte[] key=RandomNumberGenerator.GetBytes(32),iv=RandomNumberGenerator.GetBytes(12);
            var identity=new UnlockIdentity("https://example.invalid",Guid.NewGuid().ToString(),Guid.NewGuid().ToString(),
                Guid.NewGuid().ToString(),Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()),
                Convert.ToBase64String(rsa.ExportPkcs8PrivateKey()),"FIXTURE",true);
            var pin=Encoding.ASCII.GetBytes("123456");var cipher=new byte[pin.Length+16];
            using(var aes=new AesGcm(key,16)) aes.Encrypt(iv,pin,cipher.AsSpan(0,pin.Length),cipher.AsSpan(pin.Length),
                Encoding.UTF8.GetBytes($"ConnectLive.WindowsHelloPin.v1\n{identity.DeviceId}\n{identity.AuthorizationId}\n{identity.KeyId}"));
            using var envelope=JsonDocument.Parse(JsonSerializer.Serialize(new{version=1,algorithm="RSA-OAEP-256+A256GCM",keyId=identity.KeyId,
                wrappedKey=Convert.ToBase64String(rsa.Encrypt(key,RSAEncryptionPadding.OaepSHA256)),iv=Convert.ToBase64String(iv),ciphertext=Convert.ToBase64String(cipher)}));
            var opened=UnlockEnrollment.OpenPin(envelope.RootElement,identity);
            Check(opened.AsSpan().SequenceEqual(pin),"existing device-bound vault envelope roundtrip");
            Reject(()=>UnlockEnrollment.OpenPin(envelope.RootElement,identity with {DeviceId=Guid.NewGuid().ToString()}),"wrong device binding");
            CryptographicOperations.ZeroMemory(opened);CryptographicOperations.ZeroMemory(pin);CryptographicOperations.ZeroMemory(key);
            Console.WriteLine($"PASS {_checks} portable assertions; actual production C# plus actual SIPSorcery API. No native device behavior certified.");
        }
        finally { Directory.Delete(folder,true); }
    }
}
