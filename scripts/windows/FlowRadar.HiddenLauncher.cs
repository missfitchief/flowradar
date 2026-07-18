using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class FlowRadarHiddenLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string workingDirectory = null;
        string stdoutPath = null;
        string stderrPath = null;
        string launcherLogPath = null;
        var command = new List<string>();
        var commandMode = false;

        for (var index = 0; index < args.Length; index++)
        {
            if (commandMode)
            {
                command.Add(args[index]);
                continue;
            }

            if (args[index] == "--")
            {
                commandMode = true;
                continue;
            }

            if (index + 1 >= args.Length)
                return 64;

            if (args[index] == "--cwd") workingDirectory = args[++index];
            else if (args[index] == "--stdout") stdoutPath = args[++index];
            else if (args[index] == "--stderr") stderrPath = args[++index];
            else if (args[index] == "--launcher-log") launcherLogPath = args[++index];
            else return 64;
        }

        if (command.Count == 0 || String.IsNullOrWhiteSpace(workingDirectory))
            return 64;

        try
        {
            EnsureParent(stdoutPath);
            EnsureParent(stderrPath);
            EnsureParent(launcherLogPath);

            var startInfo = new ProcessStartInfo
            {
                FileName = command[0],
                Arguments = JoinArguments(command.GetRange(1, command.Count - 1)),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = false,
                RedirectStandardOutput = !String.IsNullOrWhiteSpace(stdoutPath),
                RedirectStandardError = !String.IsNullOrWhiteSpace(stderrPath)
            };

            using (var child = new Process { StartInfo = startInfo, EnableRaisingEvents = true })
            using (var stdout = OpenAppend(stdoutPath))
            using (var stderr = OpenAppend(stderrPath))
            {
                if (stdout != null)
                    child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data != null) WriteLine(stdout, eventArgs.Data);
                    };
                if (stderr != null)
                    child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data != null) WriteLine(stderr, eventArgs.Data);
                    };

                if (!child.Start())
                    throw new InvalidOperationException("The child process did not start.");

                if (stdout != null) child.BeginOutputReadLine();
                if (stderr != null) child.BeginErrorReadLine();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            AppendLauncherError(launcherLogPath, error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static void EnsureParent(string filePath)
    {
        if (String.IsNullOrWhiteSpace(filePath)) return;
        var parent = Path.GetDirectoryName(filePath);
        if (!String.IsNullOrWhiteSpace(parent)) Directory.CreateDirectory(parent);
    }

    private static StreamWriter OpenAppend(string filePath)
    {
        if (String.IsNullOrWhiteSpace(filePath)) return null;
        var stream = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        return new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
    }

    private static void WriteLine(StreamWriter writer, string value)
    {
        lock (writer) writer.WriteLine(DateTime.UtcNow.ToString("o") + " " + value);
    }

    private static void AppendLauncherError(string filePath, string message)
    {
        if (String.IsNullOrWhiteSpace(filePath)) return;
        try
        {
            EnsureParent(filePath);
            File.AppendAllText(filePath, DateTime.UtcNow.ToString("o") + " launcher error: " + message + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { }
    }

    // ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell's
    // .NET Framework runtime. Quote each argument according to CreateProcess's
    // CommandLineToArgvW rules without invoking cmd.exe or another shell.
    private static string JoinArguments(IList<string> values)
    {
        var result = new StringBuilder();
        for (var index = 0; index < values.Count; index++)
        {
            if (index > 0) result.Append(' ');
            result.Append(QuoteArgument(values[index]));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
