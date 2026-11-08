param([Parameter(Mandatory = $true)][string]$Spec)
$ErrorActionPreference = 'Stop'
# This supervisor is independent of the Harness timer. Native atomic JOB_LIST
# assignment closes the create/assign gap. No taskkill or raw-PID fallback.
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class RoleChainJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint PageFaults, Processes, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public short Show, Reserved2Size; public IntPtr Reserved2, Stdin, Stdout, Stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint Pid, Tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref SECURITY_ATTRIBUTES attrs, uint disposition, uint flags, IntPtr template);

  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static string Now() { return DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture); }
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Write(string path, Dictionary<string, object> value) {
    // Windows PowerShell 5.1 (.NET Framework) enforces MAX_PATH unless long paths
    // are enabled machine-wide; a 32-hex temp suffix pushed receipt paths past 260
    // characters and made Write throw DirectoryNotFoundException after the child ran.
    string temp = path + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".tmp";
    byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value));
    using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
    if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
  }
  static bool Stop(string path, string nonce, string round, string execution, int generation) {
    if (!File.Exists(path)) return false;
    var value = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    return Convert.ToString(value["nonce"]) == nonce && Convert.ToString(value["roundId"]) == round &&
      Convert.ToString(value["executionId"]) == execution && Convert.ToInt32(value["generation"]) == generation;
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[]{' ', '\t', '\n', '"'}) < 0) return value;
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    ACCOUNTING accounting; Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "Query Job active processes");
    return accounting.Active;
  }
  static FileStream AcquireAdmission(string path) {
    DateTime until = DateTime.UtcNow.AddMilliseconds(750);
    while (true) {
      try { return new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
      catch (IOException) {
        if (!File.Exists(path) || DateTime.UtcNow >= until) throw;
        Thread.Sleep(5);
      }
    }
  }
  public static int Run(string specPath) {
    var spec = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(specPath, Encoding.UTF8));
    string nonce = Convert.ToString(spec["nonce"]), round = Convert.ToString(spec["roundId"]), execution = Convert.ToString(spec["executionId"]);
    int generation = Convert.ToInt32(spec["generation"]);
    string dir = Path.GetDirectoryName(specPath), stopPath = Path.Combine(dir, "stop.json"), receiptPath = Path.Combine(dir, "receipt.json");
    DateTimeOffset deadline = DateTimeOffset.Parse(Convert.ToString(spec["deadlineAt"]), CultureInfo.InvariantCulture);
    DateTimeOffset signalDue = DateTimeOffset.Parse(Convert.ToString(spec["signalDueAt"]), CultureInfo.InvariantCulture);
    var receipt = new Dictionary<string, object> {
      {"version",1},{"backend","windows-job-list-v1"},{"nonce",nonce},{"roundId",round},{"executionId",execution},{"generation",generation},
      {"deadlineAt",deadline.ToString("o")},{"signalDueAt",signalDue.ToString("o")},{"jobEmpty",false},{"launched",false},{"checkedAt",Now()}
    };
    IntPtr job = IntPtr.Zero, attrs = IntPtr.Zero, jobValue = IntPtr.Zero, handleValues = IntPtr.Zero;
    IntPtr stdout = new IntPtr(-1), stderr = new IntPtr(-1), stdin = new IntPtr(-1);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool attributeReady = false, launched = false, empty = false;
    string reason = "natural-completion", error = null; int exitCode = 0;
    try {
      // No resource may be launched after the immutable absolute shutdown boundary.
      if (DateTimeOffset.UtcNow >= signalDue || Stop(stopPath, nonce, round, execution, generation)) {
        reason = DateTimeOffset.UtcNow >= signalDue ? "deadline-before-launch" : "cancelled-before-launch"; empty = true;
      } else {
        job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create kill-on-close Job");
        EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.Basic.Flags = 0x00002000;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Set kill-on-close Job limit");
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        attrs = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs, 2, 0, ref size), "Initialize process attribute list"); attributeReady = true;
        jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
        // Atomic job assignment at process creation. Unsupported Windows versions fail before start.
        Check(UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x0002000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Install atomic JOB_LIST attribute");
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), Inherit = true };
        stdout = CreateFileW(Path.Combine(dir,"stdout.txt"), 0x40000000, 3, ref security, 2, 0x80, IntPtr.Zero);
        stderr = CreateFileW(Path.Combine(dir,"stderr.txt"), 0x40000000, 3, ref security, 2, 0x80, IntPtr.Zero);
        stdin = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        Check(stdout != new IntPtr(-1) && stderr != new IntPtr(-1) && stdin != new IntPtr(-1), "Open explicit process standard handles");
        handleValues = Marshal.AllocHGlobal(IntPtr.Size * 3);
        Marshal.WriteIntPtr(handleValues, 0, stdout); Marshal.WriteIntPtr(handleValues, IntPtr.Size, stderr); Marshal.WriteIntPtr(handleValues, IntPtr.Size * 2, stdin);
        Check(UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x00020002), handleValues, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Install explicit HANDLE_LIST attribute");
        STARTUPINFOEX startup = new STARTUPINFOEX(); startup.Info.Size = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.Info.Flags = 0x00000100; startup.Info.Stdin = stdin; startup.Info.Stdout = stdout; startup.Info.Stderr = stderr; startup.Attributes = attrs;
        var argv = new List<string>(); foreach (object arg in (System.Collections.IEnumerable)spec["argv"]) argv.Add(Convert.ToString(arg));
        StringBuilder command = new StringBuilder();
        foreach (string arg in argv) { if (command.Length != 0) command.Append(' '); command.Append(Quote(arg)); }
        bool signalled = false;
        var prepared = new Dictionary<string, object>(receipt); prepared["phase"] = "awaiting-admission";
        Write(Path.Combine(dir, "prepared.json"), prepared); // Observation only, never an exit receipt.
        string admissionPath = Path.Combine(dir, "admission.lock");
        // Host stop persistence + marker commit uses this same CreateNew lock.
        // Never remove an abandoned lock or infer that its owner has exited.
        using (FileStream admission = AcquireAdmission(admissionPath)) {
          try {
            if (DateTimeOffset.UtcNow >= signalDue || Stop(stopPath, nonce, round, execution, generation)) {
              reason = DateTimeOffset.UtcNow >= signalDue ? "deadline-before-create" : "cancelled-before-create";
              empty = true;
            } else {
              Check(CreateProcessW(Convert.ToString(argv[0]), command, IntPtr.Zero, IntPtr.Zero, true,
                0x00080000 | 0x00000004 | 0x08000000, IntPtr.Zero, Convert.ToString(spec["cwd"]), ref startup, out process), "Create process atomically in Job");
              launched = true; receipt["launched"] = true; receipt["startedAt"] = Now();
              if (DateTimeOffset.UtcNow >= signalDue || Stop(stopPath, nonce, round, execution, generation)) {
                reason = DateTimeOffset.UtcNow >= signalDue ? "deadline-before-resume" : "cancelled-before-resume";
                receipt["resumed"] = false; receipt["signalAt"] = Now();
                Check(TerminateJobObject(job, 137), "Reap suspended Job process"); signalled = true;
              } else {
                Check(ResumeThread(process.Thread) != 0xFFFFFFFF, "Resume Job process"); receipt["resumed"] = true;
              }
            }
          } finally { admission.Dispose(); File.Delete(admissionPath); }
        }
        if (launched) {
        var ready = new Dictionary<string, object>(receipt); ready["supervisorPid"] = Process.GetCurrentProcess().Id; ready["targetPid"] = process.Pid;
        Write(Path.Combine(dir, "ready.json"), ready);
        long outputLimit = Convert.ToInt64(spec["outputLimitBytes"]);
        while (Active(job) != 0) {
          DateTimeOffset now = DateTimeOffset.UtcNow;
          bool cancelled = Stop(stopPath, nonce, round, execution, generation);
          bool tooMuchOutput = new FileInfo(Path.Combine(dir,"stdout.txt")).Length + new FileInfo(Path.Combine(dir,"stderr.txt")).Length > outputLimit;
          if (!signalled && (cancelled || now >= signalDue || tooMuchOutput)) {
            reason = cancelled ? "cancelled" : tooMuchOutput ? "output-limit" : "deadline";
            receipt["signalAt"] = Now();
            Check(TerminateJobObject(job, 137), "Terminate controlled Job"); signalled = true;
          }
          if (signalled && now > deadline.AddSeconds(2)) throw new TimeoutException("Job empty proof unavailable after deadline grace");
          Thread.Sleep(25);
        }
        empty = true; uint code; Check(GetExitCodeProcess(process.Process, out code), "Read direct process exit code"); exitCode = unchecked((int)code);
        }
      }
    } catch (Exception exception) {
      error = exception.ToString(); reason = "supervisor-error"; exitCode = 1;
      if (!launched) empty = true;
      else if (job != IntPtr.Zero) {
        try { TerminateJobObject(job, 137); for (int i = 0; i < 80; i++) { if (Active(job) == 0) { empty = true; break; } Thread.Sleep(25); } } catch {}
      }
    } finally {
      if (launched && !empty && job != IntPtr.Zero) { try { TerminateJobObject(job, 137); } catch {} }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (stdout != new IntPtr(-1)) CloseHandle(stdout); if (stderr != new IntPtr(-1)) CloseHandle(stderr); if (stdin != new IntPtr(-1)) CloseHandle(stdin);
      if (attributeReady) DeleteProcThreadAttributeList(attrs);
      if (attrs != IntPtr.Zero) Marshal.FreeHGlobal(attrs); if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue); if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
      if (job != IntPtr.Zero) CloseHandle(job); // KILL_ON_JOB_CLOSE also protects supervisor termination.
    }
    receipt["jobEmpty"] = empty; receipt["reason"] = reason; receipt["exitAt"] = Now(); receipt["exitCode"] = exitCode;
    receipt["checkedAt"] = Now(); if (error != null) receipt["error"] = error;
    Write(receiptPath, receipt);
    Console.WriteLine("role-chain receipt: " + receiptPath);
    return error == null && empty ? 0 : 1;
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
exit [RoleChainJob]::Run($Spec)
